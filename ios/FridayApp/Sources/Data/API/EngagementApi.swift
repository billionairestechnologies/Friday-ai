import Foundation

/// A product update published from the Team Console — shown once per account (the backend records views).
struct Announcement: Identifiable, Hashable {
    let id: String
    let title: String
    let body: String
    let ctaLabel: String?
    let ctaUrl: String?
    let kind: String
    /// Each version shows at most once per person (supabase 0062).
    var version: Int = 1
}

/// A personal notification: an inbox item, or a one-time popup when a benefit was granted.
struct UserNotification: Identifiable, Hashable {
    let id: String
    let kind: String
    let title: String
    let body: String
    let createdAt: String
    var read: Bool = false
}

/// What's New (GET /api/updates/pending, POST /updates/claim|act) and notifications
/// (/api/notifications — inbox, benefit popups) — backend routes/engagement.ts.
/// Best effort: any failure means "nothing to show" — a card must never block the app.
enum EngagementApi {
    static func pending() async -> [Announcement] {
        guard let json = try? await ApiClient.shared.requestJSON(path: "updates/pending?platform=ios", authed: true) else { return [] }
        let arr = json["updates"] as? [[String: Any]] ?? []
        return arr.compactMap { o in
            guard let id = o["id"] as? String, !id.isEmpty else { return nil }
            return Announcement(
                id: id,
                title: o["title"] as? String ?? "",
                body: o["body"] as? String ?? "",
                ctaLabel: o["ctaLabel"] as? String,
                ctaUrl: o["ctaUrl"] as? String,
                kind: o["kind"] as? String ?? "feature",
                version: (o["version"] as? NSNumber)?.intValue ?? 1
            )
        }
    }

    /// Claims the right to show this version now — false if another device or tab already showed it.
    static func claim(_ a: Announcement) async -> Bool {
        let json = try? await ApiClient.shared.requestJSON(path: "updates/claim", method: "POST", body: ["id": a.id, "version": a.version, "platform": "ios"], authed: true)
        return json?["show"] as? Bool ?? false
    }

    /// What the person did with a shown update: "acknowledged", "dismissed" or "clicked".
    static func act(_ a: Announcement, state: String) async {
        _ = try? await ApiClient.shared.request(path: "updates/act", method: "POST", body: ["id": a.id, "version": a.version, "state": state], authed: true)
    }

    private static func notification(_ o: [String: Any]) -> UserNotification? {
        guard let id = o["id"] as? String, !id.isEmpty else { return nil }
        return UserNotification(
            id: id, kind: o["kind"] as? String ?? "", title: o["title"] as? String ?? "", body: o["body"] as? String ?? "",
            createdAt: o["createdAt"] as? String ?? "", read: o["read"] as? Bool ?? false
        )
    }

    /// Benefit popups waiting to be shown once (credits granted, programme approved).
    static func popups() async -> [UserNotification] {
        guard let json = try? await ApiClient.shared.requestJSON(path: "notifications/popups", authed: true) else { return [] }
        return (json["popups"] as? [[String: Any]] ?? []).compactMap(notification)
    }

    static func claimPopup(_ id: String) async -> Bool {
        let json = try? await ApiClient.shared.requestJSON(path: "notifications/\(id)/claim", method: "POST", body: [:], authed: true)
        return json?["show"] as? Bool ?? false
    }

    static func acknowledge(_ id: String) async {
        _ = try? await ApiClient.shared.request(path: "notifications/\(id)/ack", method: "POST", body: [:], authed: true)
    }

    /// The inbox: personal notifications (newest first) and the unread count.
    static func inbox() async -> (items: [UserNotification], unread: Int) {
        guard let json = try? await ApiClient.shared.requestJSON(path: "notifications?platform=ios", authed: true) else { return ([], 0) }
        return ((json["items"] as? [[String: Any]] ?? []).compactMap(notification), (json["unread"] as? NSNumber)?.intValue ?? 0)
    }

    static func markAllRead() async {
        _ = try? await ApiClient.shared.request(path: "notifications/read", method: "POST", body: ["all": true], authed: true)
    }
}
