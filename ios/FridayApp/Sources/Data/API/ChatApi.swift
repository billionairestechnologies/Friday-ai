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
    case step(BuildStep)
    case preview(url: String, port: Int)
    case plan(BuildPlan)
    case ask([BuildAskQuestion])
    /// Normal chat got a build request: offer "Open in Build" (from {"t":"suggest_build",...}).
    case suggestBuild(String)
    case buildMeta(elapsedMs: Int?, zipBytes: Int?, zipName: String?)
    /// The local socket dropped (network blip, app backgrounded/killed mid-stream) — NOT a server
    /// failure. The backend keeps generating and persists the full reply regardless (see
    /// activeGenerations.ts), so this must never overwrite whatever text already streamed in; it
    /// just flags the message so a later refetch (open/foreground) replaces it with the truth.
    case disconnected
    case done
}

enum ChatApi {
    static func parseAsk(_ raw: Any?) -> [BuildAskQuestion] {
        (raw as? [[String: Any]] ?? []).compactMap { q in
            guard let text = q["question"] as? String, !text.isEmpty else { return nil }
            let opts = (q["options"] as? [[String: Any]] ?? []).map {
                BuildAskOption(label: $0["label"] as? String ?? "", description: $0["description"] as? String ?? "", recommended: $0["recommended"] as? Bool ?? false)
            }
            return BuildAskQuestion(id: q["id"] as? String ?? UUID().uuidString, question: text, options: opts)
        }
    }

    struct StreamAttachment {
        let mime: String
        let dataUrl: String
        let name: String
        let size: Int
        let kind: String
    }

    static func createConversation(mode: String, modelId: String?, providerSlug: String?, workspace: String? = nil) async throws -> String {
        var body: [String: Any] = ["mode": mode]
        // "build" = a Build workspace session: every message goes to the Build agent.
        if workspace == "build" { body["workspace"] = "build" }
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
        research: Bool = false,
        attachments: [StreamAttachment],
        effort: String? = nil
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
                        "research": research,
                    ]
                    // Build workspace effort picker (low | medium | high) — ignored outside Build sessions.
                    if let effort { body["effort"] = effort }
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
                        case "step":
                            continuation.yield(.step(BuildStep.parse(json, defaultState: "running")))
                        case "preview":
                            continuation.yield(.preview(url: json["url"] as? String ?? "", port: json["port"] as? Int ?? 0))
                        case "plan":
                            if let plan = BuildPlan.parse(json) { continuation.yield(.plan(plan)) }
                        case "suggest_build":
                            continuation.yield(.suggestBuild(json["prompt"] as? String ?? ""))
                        case "ask":
                            continuation.yield(.ask(ChatApi.parseAsk(json["questions"])))
                        case "build":
                            continuation.yield(.buildMeta(elapsedMs: json["elapsedMs"] as? Int, zipBytes: json["zipBytes"] as? Int, zipName: json["zipName"] as? String))
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
                        continuation.yield(.disconnected)
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
        var workspace: String?
        var hasBuild: Bool = false
    }

    static func list() async throws -> [Summary] {
        let json = try await ApiClient.shared.requestJSON(path: "chat/conversations", authed: true)
        guard let arr = json["conversations"] as? [[String: Any]] else { return [] }
        return arr.map {
            Summary(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "New chat", updatedAt: $0["updated_at"] as? String, workspace: $0["workspace"] as? String, hasBuild: $0["has_build"] as? Bool ?? false)
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
            var build: BuildInfo?
            if let b = row["build"] as? [String: Any] {
                let steps = (b["steps"] as? [[String: Any]] ?? []).map {
                    BuildStep.parse($0, defaultState: "ok")
                }
                let plan = BuildPlan.parse(b["plan"] as? [String: Any])
                let ask = ChatApi.parseAsk(b["ask"])
                // A suggestion-only build object (no steps/plan/ask/preview) isn't a Build turn.
                if !(steps.isEmpty && plan == nil && ask.isEmpty && b["previewUrl"] == nil && b["zipBytes"] == nil) {
                    build = BuildInfo(plan: plan, steps: steps, previewUrl: b["previewUrl"] as? String, port: b["port"] as? Int, elapsedMs: b["elapsedMs"] as? Int, zipBytes: b["zipBytes"] as? Int, zipName: b["zipName"] as? String, ask: ask.isEmpty ? nil : ask)
                }
            }
            let suggest = ((row["build"] as? [String: Any])?["suggestBuild"] as? [String: Any])?["prompt"] as? String
            // A turn the server rejected before generating anything (e.g. the plan/tier gate) is
            // persisted with empty content and the message in `error` instead — the live stream
            // already folds this into content as it arrives (the .err case below), so a reload
            // does the same instead of showing a blank bubble.
            let errorText = row["error"] as? String
            let rawContent = row["content"] as? String ?? ""
            let content: String
            if let errorText, !errorText.isEmpty {
                content = rawContent.isEmpty ? errorText : "\(rawContent)\n\n\(errorText)"
            } else {
                content = rawContent
            }
            return ChatMessage(
                id: row["id"] as? String ?? UUID().uuidString,
                role: (row["role"] as? String) == "user" ? .user : .assistant,
                content: content,
                sources: sources,
                build: build,
                suggestBuildPrompt: (suggest?.isEmpty ?? true) ? nil : suggest
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
