import Foundation

/// One parsed frame from the hand-rolled `data: <json>` SSE stream.
/// Discriminated by the backend's `t` field — see chat/messages/stream.
enum ChatEvent {
    case status(String)
    case think(String) // cumulative reasoning buffer
    case text(String) // cumulative text buffer
    case cite(title: String?, url: String)
    case err(String)
    case agent(AgentStatus)
    case done
}

enum ChatApi {
    struct StreamAttachment {
        let mime: String
        let dataUrl: String
        let name: String
        let size: Int
        let kind: String
    }

    static func createConversation(mode: String, modelId: String?, providerSlug: String?) async throws -> String {
        var body: [String: Any] = ["mode": mode]
        if mode == "single" {
            if let modelId { body["modelId"] = modelId }
            if let providerSlug { body["providerSlug"] = providerSlug }
        }
        let json = try await ApiClient.shared.requestJSON(path: "chat/conversations", method: "POST", body: body, authed: true)
        guard let conv = json["conversation"] as? [String: Any], let id = conv["id"] as? String else {
            throw ApiError.decode
        }
        return id
    }

    /// PATCH /chat/conversations/:id — switches an EXISTING conversation to a different
    /// model/mode without starting a new one (which would drop the history the model sees).
    static func updateConversation(id: String, mode: String, modelId: String?, providerSlug: String?) async throws {
        var body: [String: Any] = ["mode": mode]
        if mode == "single" {
            if let modelId { body["modelId"] = modelId }
            if let providerSlug { body["providerSlug"] = providerSlug }
        }
        _ = try await ApiClient.shared.requestJSON(path: "chat/conversations/\(id)", method: "PATCH", body: body, authed: true)
    }

    /// POST /chat/conversations/:id/stop — the backend keeps generating after the client
    /// disconnects, so an explicit Stop has to be sent to it. Best-effort (204, no body).
    static func stop(conversationId: String) async {
        _ = try? await ApiClient.shared.request(path: "chat/conversations/\(conversationId)/stop", method: "POST", body: [:], authed: true)
    }

    /// Streams one assistant reply. Yields cumulative buffers per the
    /// backend's contract (not deltas) — the caller replaces, not appends.
    static func streamMessage(
        conversationId: String,
        content: String,
        think: Bool,
        webSearch: Bool,
        canvas: Bool,
        attachments: [StreamAttachment]
    ) -> AsyncThrowingStream<ChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var body: [String: Any] = [
                        "content": content,
                        "inputMode": "text",
                        "think": think,
                        "webSearch": webSearch,
                        "canvas": canvas,
                    ]
                    if !attachments.isEmpty {
                        body["attachments"] = attachments.map {
                            ["mime": $0.mime, "dataUrl": $0.dataUrl, "name": $0.name, "size": $0.size, "kind": $0.kind]
                        }
                    }
                    let (bytes, http) = try await ApiClient.shared.streamRequest(
                        path: "chat/conversations/\(conversationId)/messages/stream", body: body
                    )
                    guard (200...299).contains(http.statusCode) else {
                        continuation.yield(.text("Connection lost: server returned \(http.statusCode)"))
                        continuation.yield(.done)
                        continuation.finish()
                        return
                    }

                    var dataLines: [String] = []
                    var textBuffer = ""
                    var thinkBuffer = ""
                    var sources: [Source] = []

                    func flushEvent() {
                        guard !dataLines.isEmpty else { return }
                        let payload = dataLines.joined(separator: "\n")
                        dataLines = []
                        guard let data = payload.data(using: .utf8),
                              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let t = json["t"] as? String else { return }
                        switch t {
                        case "status":
                            continuation.yield(.status(json["s"] as? String ?? ""))
                        case "think", "reasoning":
                            thinkBuffer += (json["c"] as? String ?? "")
                            continuation.yield(.think(thinkBuffer))
                        case "text":
                            textBuffer += (json["c"] as? String ?? "")
                            continuation.yield(.text(textBuffer))
                        case "cite":
                            if let u = json["u"] as? String {
                                sources.append(Source(title: json["title"] as? String, url: u))
                                continuation.yield(.cite(title: json["title"] as? String, url: u))
                            }
                        case "err":
                            let msg = json["c"] as? String ?? "Something went wrong."
                            textBuffer += "\n\n" + msg
                            continuation.yield(.text(textBuffer))
                        case "agent":
                            let status = AgentStatus(
                                slug: json["slug"] as? String ?? "",
                                model: json["model"] as? String ?? "",
                                state: json["state"] as? String ?? "start",
                                error: json["error"] as? String
                            )
                            continuation.yield(.agent(status))
                        case "done":
                            continuation.yield(.done)
                        default:
                            break
                        }
                    }

                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if line.isEmpty {
                            flushEvent()
                            continue
                        }
                        if line.hasPrefix("data:") {
                            // AsyncBytes.lines drops blank lines, so frames can't be delimited by them —
                            // each data line is a complete single-line JSON frame.
                            dataLines.append(String(line.dropFirst(5).trimmingCharacters(in: .whitespaces)))
                            flushEvent()
                        }
                    }
                    flushEvent()
                    continuation.yield(.done)
                    continuation.finish()
                } catch {
                    if !Task.isCancelled {
                        continuation.yield(.text("Connection lost: \(error.localizedDescription)"))
                        continuation.yield(.done)
                    }
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

enum ConversationsApi {
    struct Summary: Identifiable, Hashable {
        let id: String
        let title: String
        let updatedAt: String?
    }

    static func list() async throws -> [Summary] {
        let json = try await ApiClient.shared.requestJSON(path: "chat/conversations", authed: true)
        guard let arr = json["conversations"] as? [[String: Any]] else { return [] }
        return arr.map {
            Summary(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "New chat", updatedAt: $0["updated_at"] as? String)
        }
    }

    static func messages(conversationId: String) async throws -> [ChatMessage] {
        let json = try await ApiClient.shared.requestJSON(path: "chat/conversations/\(conversationId)/messages", authed: true)
        guard let arr = json["messages"] as? [[String: Any]] else { return [] }
        return arr.map { row in
            let sources = (row["sources"] as? [[String: Any]] ?? []).compactMap { s -> Source? in
                guard let u = s["u"] as? String else { return nil }
                return Source(title: s["title"] as? String, url: u)
            }
            return ChatMessage(
                id: row["id"] as? String ?? UUID().uuidString,
                role: (row["role"] as? String) == "user" ? .user : .assistant,
                content: row["content"] as? String ?? "",
                sources: sources
            )
        }
    }

    static func delete(conversationId: String) async throws {
        _ = try await ApiClient.shared.request(path: "chat/conversations/\(conversationId)", method: "DELETE", authed: true)
    }

    static func deleteAll() async throws {
        _ = try await ApiClient.shared.request(path: "chat/conversations", method: "DELETE", authed: true)
    }
}

enum ModelsApi {
    static func list() async throws -> [RemoteModel] {
        let json = try await ApiClient.shared.requestJSON(path: "models")
        guard let arr = json["models"] as? [[String: Any]] else { return [] }
        return arr.map {
            RemoteModel(
                modelId: $0["model_id"] as? String ?? "",
                displayName: $0["display_name"] as? String ?? "",
                minTier: $0["min_tier"] as? String,
                providerSlug: ($0["providers"] as? [String: Any])?["slug"] as? String
            )
        }
    }
}
