import Foundation

/// A product update published from the Team Console — shown once per account (the backend records views).
struct Announcement: Identifiable, Hashable {
    let id: String
    let title: String
    let body: String
    let ctaLabel: String?
    let ctaUrl: String?
    let kind: String
}

/// GET /api/updates/pending?platform=ios and POST /api/updates/seen (backend routes/engagement.ts).
/// Best effort: any failure means "nothing to show" — a What's New card must never block the app.
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
                kind: o["kind"] as? String ?? "feature"
            )
        }
    }

    static func markSeen(ids: [String], clickedId: String?) async {
        var body: [String: Any] = ["ids": ids]
        if let clickedId { body["clickedId"] = clickedId }
        _ = try? await ApiClient.shared.request(path: "updates/seen", method: "POST", body: body, authed: true)
    }
}
