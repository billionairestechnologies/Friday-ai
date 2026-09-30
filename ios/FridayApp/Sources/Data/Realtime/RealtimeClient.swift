import Foundation

/// Hand-rolled Supabase Realtime client (Phoenix Channels protocol over raw
/// WebSocket) — mirrors android SupabaseRealtime.kt rather than pulling in
/// the full Supabase SDK.
actor RealtimeClient {
    static let shared = RealtimeClient()

    private static let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzkwNzQ4Njc1LCJleHAiOjE5NDg0Mjg2NzV9.xdKM4esMqUgxauygQ7G7AzEiLjvAStYrHrXgLaqCkr4"
    private static let wsURL = URL(string: "wss://friday.billionairestechnologies.com/realtime/v1/websocket?apikey=\(anonKey)&vsn=1.0.0&log_level=info")!

    private var task: URLSessionWebSocketTask?
    private var userId: String?
    private var accessToken: String?
    private var ref = 0
    private var joinRef: Int?
    private var heartbeatTask: Task<Void, Never>?
    private var listenTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    private var conversationsChanged: (() -> Void)?
    private var messagesChanged: ((String) -> Void)?
    private var stopped = true

    func configure(onConversationsChanged: @escaping () -> Void, onMessagesChanged: @escaping (String) -> Void) {
        self.conversationsChanged = onConversationsChanged
        self.messagesChanged = onMessagesChanged
    }

    func connect(userId: String, accessToken: String) {
        self.userId = userId
        self.accessToken = accessToken
        self.stopped = false
        reconnectAttempts = 0
        open()
    }

    func disconnect() {
        stopped = true
        heartbeatTask?.cancel()
        listenTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        joinRef = nil
    }

    func updateAuth(_ token: String) {
        accessToken = token
        guard let task, let joinRef else { return }
        let ref = nextRef()
        let msg: [String: Any] = [
            "topic": "realtime:chat-sync:\(userId ?? "")",
            "event": "access_token",
            "payload": ["access_token": token],
            "ref": "\(ref)",
        ]
        _ = joinRef // silence unused warning path when not yet joined
        send(task, msg)
    }

    // MARK: - Connection lifecycle

    private func open() {
        guard let userId, let accessToken else { return }
        let t = URLSession.shared.webSocketTask(with: Self.wsURL)
        task = t
        t.resume()
        joinChannel(userId: userId, accessToken: accessToken)
        startHeartbeat()
        listen()
    }

    private func joinChannel(userId: String, accessToken: String) {
        guard let task else { return }
        let r = nextRef()
        joinRef = r
        let payload: [String: Any] = [
            "config": [
                "postgres_changes": [
                    ["event": "*", "schema": "public", "table": "conversations", "filter": "user_id=eq.\(userId)"],
                    // DELETE can't be column-filtered, so the filtered entry above never fires for a
                    // delete made on another device — this unfiltered one does.
                    ["event": "DELETE", "schema": "public", "table": "conversations"],
                    ["event": "*", "schema": "public", "table": "messages"],
                ],
            ],
            "access_token": accessToken,
        ]
        send(task, ["topic": "realtime:chat-sync:\(userId)", "event": "phx_join", "payload": payload, "ref": "\(r)"])
        // Belt-and-suspenders: resend access_token as its own event too.
        send(task, ["topic": "realtime:chat-sync:\(userId)", "event": "access_token", "payload": ["access_token": accessToken], "ref": "\(nextRef())"])
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            while let self, await !self.stopped {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let task = await self.task else { continue }
                await self.send(task, ["topic": "phoenix", "event": "heartbeat", "payload": [:], "ref": "\(await self.nextRef())"])
            }
        }
    }

    private func listen() {
        listenTask?.cancel()
        listenTask = Task { [weak self] in
            guard let self else { return }
            guard let task = await self.task else { return }
            do {
                while true {
                    let message = try await task.receive()
                    switch message {
                    case .string(let text):
                        await self.handleFrame(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            await self.handleFrame(text)
                        }
                    @unknown default:
                        break
                    }
                }
            } catch {
                await self.scheduleReconnect()
            }
        }
    }

    private func handleFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = json["event"] as? String,
              let payload = json["payload"] as? [String: Any]
        else { return }

        switch event {
        case "postgres_changes":
            handlePostgresChanges(payload)
        default:
            break
        }
    }

    private var debounceTasks: [String: Task<Void, Never>] = [:]

    private func handlePostgresChanges(_ payload: [String: Any]) {
        guard let data = payload["data"] as? [String: Any] else { return }
        let table = data["table"] as? String
        if table == "conversations" {
            debounceTasks["conversations"]?.cancel()
            debounceTasks["conversations"] = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 400_000_000)
                guard let self, await !Task.isCancelled else { return }
                await self.fireConversationsChanged()
            }
        } else if table == "messages" {
            let record = (data["record"] as? [String: Any]) ?? (data["old_record"] as? [String: Any])
            guard let convId = record?["conversation_id"] as? String else { return }
            let key = "messages-\(convId)"
            debounceTasks[key]?.cancel()
            debounceTasks[key] = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 400_000_000)
                guard let self, await !Task.isCancelled else { return }
                await self.fireMessagesChanged(convId)
            }
        }
    }

    private func fireConversationsChanged() {
        conversationsChanged?()
    }

    private func fireMessagesChanged(_ conversationId: String) {
        messagesChanged?(conversationId)
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        reconnectAttempts += 1
        let delayMs = min(1000 * (1 << min(reconnectAttempts, 5)), 30000)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            guard let self, await !self.stopped else { return }
            await self.open()
        }
    }

    private func nextRef() -> Int {
        ref += 1
        return ref
    }

    private func send(_ task: URLSessionWebSocketTask, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }
}
