import Foundation

struct PageSummary: Identifiable, Hashable {
    let id: String
    let kind: String // doc | sheet | slides
    let title: String
    let updatedAt: String?
}

/// A page's content in the shape the backend stores (services/pages/pageService.ts): doc = markdown,
/// sheet = sheets with columns/rows, slides = slide specs.
struct PageDetail {
    let kind: String
    let title: String
    let markdown: String
    let sheets: [(name: String, columns: [String], rows: [[String]])]
    let slides: [[String: Any]]
}

enum PagesApi {
    static func list() async throws -> [PageSummary] {
        let json = try await ApiClient.shared.requestJSON(path: "pages", authed: true)
        return (json["pages"] as? [[String: Any]] ?? []).map {
            PageSummary(id: $0["id"] as? String ?? "", kind: $0["kind"] as? String ?? "doc", title: $0["title"] as? String ?? "Untitled", updatedAt: $0["updated_at"] as? String)
        }
    }

    static func get(id: String) async throws -> PageDetail {
        let json = try await ApiClient.shared.requestJSON(path: "pages/\(id)", authed: true)
        guard let page = json["page"] as? [String: Any] else { throw ApiError.decode }
        let content = page["content"] as? [String: Any] ?? [:]
        let sheets = (content["sheets"] as? [[String: Any]] ?? []).map { s -> (name: String, columns: [String], rows: [[String]]) in
            let rows = (s["rows"] as? [[Any]] ?? []).map { row in row.map { cell in cell is NSNull ? "" : "\(cell)" } }
            return (s["name"] as? String ?? "Sheet", (s["columns"] as? [Any] ?? []).map { "\($0)" }, rows)
        }
        return PageDetail(
            kind: page["kind"] as? String ?? "doc",
            title: page["title"] as? String ?? "Untitled",
            markdown: content["markdown"] as? String ?? "",
            sheets: sheets,
            slides: content["slides"] as? [[String: Any]] ?? []
        )
    }
}
