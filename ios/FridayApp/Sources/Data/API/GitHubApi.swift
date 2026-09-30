import Foundation

/// GitHub for the Build composer's repo / branch picker (backend /api/connectors/github/…).
enum GitHubApi {
    struct Repo: Identifiable, Hashable {
        let fullName: String
        let isPrivate: Bool
        let defaultBranch: String
        let description: String?
        var id: String { fullName }
    }

    private static func parseRepo(_ o: [String: Any]) -> Repo {
        Repo(
            fullName: o["fullName"] as? String ?? "",
            isPrivate: o["private"] as? Bool ?? false,
            defaultBranch: (o["defaultBranch"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "main",
            description: o["description"] as? String
        )
    }

    static func isConnected() async -> Bool {
        guard let json = try? await ApiClient.shared.requestJSON(path: "connectors", authed: true) else { return false }
        return (json["accounts"] as? [[String: Any]] ?? []).contains { $0["provider"] as? String == "github" }
    }

    static func startUrl() async throws -> URL {
        let json = try await ApiClient.shared.requestJSON(path: "connectors/github/start", authed: true)
        guard let s = json["url"] as? String, let url = URL(string: s) else { throw ApiError.decode }
        return url
    }

    static func repos(query: String) async throws -> [Repo] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let json = try await ApiClient.shared.requestJSON(path: "connectors/github/repos?mine=1&q=\(q)", authed: true)
        return (json["repositories"] as? [[String: Any]] ?? []).map(parseRepo)
    }

    static func branches(repo: String) async throws -> [String] {
        let r = repo.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repo
        let json = try await ApiClient.shared.requestJSON(path: "connectors/github/branches?repo=\(r)", authed: true)
        return json["branches"] as? [String] ?? []
    }

    static func createRepo(name: String, isPrivate: Bool) async throws -> Repo {
        let json = try await ApiClient.shared.requestJSON(path: "connectors/github/repos", method: "POST", body: ["name": name, "private": isPrivate], authed: true)
        return parseRepo(json["repository"] as? [String: Any] ?? [:])
    }

    static func createBranch(repo: String, branch: String, from: String) async throws {
        _ = try await ApiClient.shared.requestJSON(path: "connectors/github/branches", method: "POST", body: ["repo": repo, "branch": branch, "from": from], authed: true)
    }
}
