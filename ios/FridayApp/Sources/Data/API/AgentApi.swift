import Foundation

struct MemoryItem: Identifiable, Hashable {
    let id: String
    let content: String
}

struct McpServer: Identifiable, Hashable {
    let id: String
    let name: String
    let url: String
    let hasAuth: Bool
    var enabled: Bool
}

struct Automation: Identifiable, Hashable {
    let id: String
    let title: String
    let prompt: String
    let frequency: String
    let timeOfDay: String
    let weekday: Int?
    let timezone: String
    let research: Bool
    var enabled: Bool
    let conversationId: String?
    let lastStatus: String?
    let lastError: String?
}

struct SearchHit: Identifiable, Hashable {
    var id: String { conversationId + snippet }
    let conversationId: String
    let title: String
    let role: String
    let snippet: String
}

/// Memory, MCP servers, Automations, chat search and share links — mirrors android AgentApi.kt.
/// Every call throws on failure so the UI can show the server's message instead of failing silently.
enum AgentApi {
    // MARK: Memory
    static func memories() async throws -> [MemoryItem] {
        let json = try await ApiClient.shared.requestJSON(path: "memory", authed: true)
        return (json["memories"] as? [[String: Any]] ?? []).map {
            MemoryItem(id: $0["id"] as? String ?? "", content: $0["content"] as? String ?? "")
        }
    }

    static func addMemory(_ content: String) async throws {
        _ = try await ApiClient.shared.request(path: "memory", method: "POST", body: ["content": content], authed: true)
    }

    static func deleteMemory(id: String) async throws {
        _ = try await ApiClient.shared.request(path: "memory/\(id)", method: "DELETE", authed: true)
    }

    static func clearMemories() async throws {
        _ = try await ApiClient.shared.request(path: "memory", method: "DELETE", authed: true)
    }

    // MARK: MCP servers
    private static func parseServer(_ o: [String: Any]) -> McpServer {
        McpServer(
            id: o["id"] as? String ?? "", name: o["name"] as? String ?? "", url: o["url"] as? String ?? "",
            hasAuth: o["hasAuth"] as? Bool ?? false, enabled: o["enabled"] as? Bool ?? true
        )
    }

    static func mcpServers() async throws -> [McpServer] {
        let json = try await ApiClient.shared.requestJSON(path: "mcp", authed: true)
        return (json["servers"] as? [[String: Any]] ?? []).map(parseServer)
    }

    /// Returns the tool names the server exposes (the backend verifies the connection before saving).
    static func addMcpServer(name: String, url: String, authorization: String) async throws -> [String] {
        var body: [String: Any] = ["name": name, "url": url]
        if !authorization.isEmpty { body["authorization"] = authorization }
        let json = try await ApiClient.shared.requestJSON(path: "mcp", method: "POST", body: body, authed: true)
        return json["tools"] as? [String] ?? []
    }

    static func setMcpEnabled(id: String, enabled: Bool) async throws {
        _ = try await ApiClient.shared.request(path: "mcp/\(id)", method: "PATCH", body: ["enabled": enabled], authed: true)
    }

    static func deleteMcpServer(id: String) async throws {
        _ = try await ApiClient.shared.request(path: "mcp/\(id)", method: "DELETE", authed: true)
    }

    // MARK: Automations
    private static func parseAutomation(_ o: [String: Any]) -> Automation {
        Automation(
            id: o["id"] as? String ?? "", title: o["title"] as? String ?? "", prompt: o["prompt"] as? String ?? "",
            frequency: o["frequency"] as? String ?? "daily", timeOfDay: o["timeOfDay"] as? String ?? "09:00",
            weekday: o["weekday"] as? Int, timezone: o["timezone"] as? String ?? "UTC",
            research: o["research"] as? Bool ?? false, enabled: o["enabled"] as? Bool ?? true,
            conversationId: o["conversationId"] as? String,
            lastStatus: o["lastStatus"] as? String, lastError: o["lastError"] as? String
        )
    }

    static func automations() async throws -> [Automation] {
        let json = try await ApiClient.shared.requestJSON(path: "automations", authed: true)
        return (json["automations"] as? [[String: Any]] ?? []).map(parseAutomation)
    }

    static func createAutomation(
        title: String, prompt: String, frequency: String, timeOfDay: String, weekday: Int?, research: Bool
    ) async throws {
        var body: [String: Any] = [
            "title": title, "prompt": prompt, "frequency": frequency, "timeOfDay": timeOfDay,
            "timezone": TimeZone.current.identifier, "research": research,
        ]
        if frequency == "weekly", let weekday { body["weekday"] = weekday }
        _ = try await ApiClient.shared.request(path: "automations", method: "POST", body: body, authed: true)
    }

    static func setAutomationEnabled(id: String, enabled: Bool) async throws {
        _ = try await ApiClient.shared.request(path: "automations/\(id)", method: "PATCH", body: ["enabled": enabled], authed: true)
    }

    static func runAutomation(id: String) async throws {
        _ = try await ApiClient.shared.request(path: "automations/\(id)/run", method: "POST", body: [:], authed: true)
    }

    static func deleteAutomation(id: String) async throws {
        _ = try await ApiClient.shared.request(path: "automations/\(id)", method: "DELETE", authed: true)
    }

    // MARK: Search + share
    static func search(_ query: String) async throws -> [SearchHit] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let json = try await ApiClient.shared.requestJSON(path: "chat/search?q=\(q)", authed: true)
        return (json["results"] as? [[String: Any]] ?? []).map {
            SearchHit(
                conversationId: $0["conversationId"] as? String ?? "", title: $0["title"] as? String ?? "",
                role: $0["role"] as? String ?? "", snippet: $0["snippet"] as? String ?? ""
            )
        }
    }

    /// Returns the public share URL (served by the web app at /share/:token).
    static func shareConversation(id: String) async throws -> URL {
        let json = try await ApiClient.shared.requestJSON(path: "chat/conversations/\(id)/share", method: "POST", body: [:], authed: true)
        guard let token = json["token"] as? String,
              let url = URL(string: "https://friday.billionairestechnologies.com/share/\(token)") else { throw ApiError.decode }
        return url
    }

    static func unshareConversation(id: String) async throws {
        _ = try await ApiClient.shared.request(path: "chat/conversations/\(id)/share", method: "DELETE", authed: true)
    }
}
