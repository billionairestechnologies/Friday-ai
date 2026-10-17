import Foundation

/// One place this account is signed in: a browser, a phone app, or FridayX (supabase 0068).
struct DeviceSession: Identifiable, Hashable {
    let id: String
    let kind: String
    let platform: String
    let client: String
    let ipPrefix: String?
    let createdAt: String
    let lastSeenAt: String?
    let current: Bool
}

/// GET /api/sessions, DELETE /api/sessions/:id?kind=, POST /api/sessions/revoke-others (backend routes/sessions.ts).
enum SessionsApi {
    static func list() async -> [DeviceSession]? {
        guard let json = try? await ApiClient.shared.requestJSON(path: "sessions", authed: true) else { return nil }
        return (json["sessions"] as? [[String: Any]] ?? []).compactMap { o in
            guard let id = o["id"] as? String else { return nil }
            return DeviceSession(
                id: id, kind: o["kind"] as? String ?? "app", platform: o["platform"] as? String ?? "",
                client: o["client"] as? String ?? "", ipPrefix: o["ipPrefix"] as? String,
                createdAt: o["createdAt"] as? String ?? "", lastSeenAt: o["lastSeenAt"] as? String,
                current: o["current"] as? Bool ?? false
            )
        }
    }

    static func signOut(_ s: DeviceSession) async -> Bool {
        (try? await ApiClient.shared.request(path: "sessions/\(s.id)?kind=\(s.kind)", method: "DELETE", authed: true)) != nil
    }

    static func signOutOthers() async -> Int? {
        guard let json = try? await ApiClient.shared.requestJSON(path: "sessions/revoke-others", method: "POST", body: [:], authed: true) else { return nil }
        return (json["signedOut"] as? NSNumber)?.intValue ?? 0
    }
}
