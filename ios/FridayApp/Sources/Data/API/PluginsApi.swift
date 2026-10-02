import Foundation

/// The plugin catalog the web shows (frontend/src/lib/plugins.ts) — what exists; whether it is connected,
/// and how to connect it, comes from the backend (`/connectors`, `/connectors/config`).
struct PluginItem: Identifiable, Hashable {
    let id: String
    let name: String
    let desc: String
    let category: String
}

let PLUGIN_CATEGORIES = ["Productivity", "Developer tools", "Business & finance", "Design"]

let FEATURED_PLUGINS: [PluginItem] = [
    PluginItem(id: "gmail", name: "Gmail", desc: "Read and draft mail", category: "Productivity"),
    PluginItem(id: "calendar", name: "Google Calendar", desc: "See events and upcoming meetings", category: "Productivity"),
    PluginItem(id: "drive", name: "Google Drive", desc: "Search files and docs", category: "Productivity"),
    PluginItem(id: "notion", name: "Notion", desc: "Search pages and docs", category: "Productivity"),
    PluginItem(id: "box", name: "Box", desc: "Search files and docs", category: "Productivity"),
    PluginItem(id: "github", name: "GitHub", desc: "Search repos and pull requests", category: "Developer tools"),
    PluginItem(id: "supabase", name: "Supabase", desc: "Query your database and tables", category: "Developer tools"),
    PluginItem(id: "vercel", name: "Vercel", desc: "Manage your deploys", category: "Developer tools"),
    PluginItem(id: "railway", name: "Railway", desc: "Check deploys and service status", category: "Developer tools"),
    PluginItem(id: "razorpay", name: "Razorpay", desc: "Track payments and orders", category: "Business & finance"),
    PluginItem(id: "finance", name: "Finance", desc: "Connect financial accounts", category: "Business & finance"),
    PluginItem(id: "canva", name: "Canva", desc: "Create and edit designs", category: "Design"),
]

struct ConnectorField: Hashable {
    let key: String // token | secret | url
    let label: String
    let secret: Bool
    let placeholder: String?
}

struct ConnectorSpec: Hashable {
    let mode: String // oauth | token
    let configured: Bool
    let pluginIds: [String]
    let fields: [ConnectorField]
}

struct ConnectorAccount: Identifiable, Hashable {
    let id: String
    let provider: String
    let accountLogin: String?
}

struct ConnectorPreviewItem: Identifiable, Hashable {
    var id: String { title + (subtitle ?? "") }
    let title: String
    let subtitle: String?
}

enum PluginsApi {
    static func config() async throws -> [String: ConnectorSpec] {
        let json = try await ApiClient.shared.requestJSON(path: "connectors/config", authed: true)
        var out: [String: ConnectorSpec] = [:]
        for (provider, raw) in json["connectors"] as? [String: Any] ?? [:] {
            guard let o = raw as? [String: Any] else { continue }
            let fields = (o["fields"] as? [[String: Any]] ?? []).map {
                ConnectorField(key: $0["key"] as? String ?? "token", label: $0["label"] as? String ?? "Token", secret: $0["secret"] as? Bool ?? false, placeholder: $0["placeholder"] as? String)
            }
            out[provider] = ConnectorSpec(mode: o["mode"] as? String ?? "token", configured: o["configured"] as? Bool ?? false, pluginIds: o["pluginIds"] as? [String] ?? [], fields: fields)
        }
        return out
    }

    static func accounts() async throws -> [ConnectorAccount] {
        let json = try await ApiClient.shared.requestJSON(path: "connectors", authed: true)
        return (json["accounts"] as? [[String: Any]] ?? []).map {
            ConnectorAccount(id: $0["id"] as? String ?? UUID().uuidString, provider: $0["provider"] as? String ?? "", accountLogin: $0["accountLogin"] as? String)
        }
    }

    /// GitHub / Google: the authorize URL to open in the browser; the server finishes the link on its callback.
    static func oauthStart(provider: String) async throws -> URL {
        let json = try await ApiClient.shared.requestJSON(path: "connectors/\(provider)/start?returnTo=%2F", authed: true)
        guard let s = json["url"] as? String, let url = URL(string: s) else { throw ApiError.decode }
        return url
    }

    static func connect(provider: String, values: [String: String]) async throws {
        var body: [String: Any] = [:]
        for (k, v) in values where !v.trimmingCharacters(in: .whitespaces).isEmpty { body[k] = v.trimmingCharacters(in: .whitespaces) }
        _ = try await ApiClient.shared.requestJSON(path: "connectors/\(provider)", method: "POST", body: body, authed: true)
    }

    static func disconnect(provider: String) async throws {
        _ = try await ApiClient.shared.request(path: "connectors/\(provider)", method: "DELETE", authed: true)
    }

    static func preview(provider: String) async throws -> [ConnectorPreviewItem] {
        let json = try await ApiClient.shared.requestJSON(path: "connectors/\(provider)/preview", authed: true)
        return (json["items"] as? [[String: Any]] ?? []).map { ConnectorPreviewItem(title: $0["title"] as? String ?? "", subtitle: $0["subtitle"] as? String) }
    }
}
