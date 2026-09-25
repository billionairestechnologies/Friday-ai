import Foundation

/// One auto-saved code block / page / image from a chat reply (backend GET /api/library).
struct LibraryItem: Identifiable, Hashable {
    let id: String
    let title: String
    let kind: String
    let lang: String?
    let category: String
    let createdAt: String
    /// Short preview in lists; the full body (or the image URL) after `LibraryApi.get`.
    var content: String
}

enum LibraryApi {
    private static func parse(_ o: [String: Any], content: String) -> LibraryItem {
        LibraryItem(
            id: o["id"] as? String ?? "",
            title: o["title"] as? String ?? "",
            kind: o["kind"] as? String ?? "code",
            lang: o["lang"] as? String,
            category: o["category"] as? String ?? "Other code",
            createdAt: o["created_at"] as? String ?? "",
            content: content
        )
    }

    static func list() async throws -> [LibraryItem] {
        let json = try await ApiClient.shared.requestJSON(path: "library", authed: true)
        let arr = json["items"] as? [[String: Any]] ?? []
        return arr.map { parse($0, content: $0["preview"] as? String ?? "") }
    }

    static func get(id: String) async throws -> LibraryItem {
        let json = try await ApiClient.shared.requestJSON(path: "library/\(id)", authed: true)
        guard let o = json["item"] as? [String: Any] else { throw ApiError.decode }
        return parse(o, content: o["content"] as? String ?? "")
    }

    static func delete(id: String) async throws {
        _ = try await ApiClient.shared.request(path: "library/\(id)", method: "DELETE", authed: true)
    }
}
