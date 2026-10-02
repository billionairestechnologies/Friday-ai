import Foundation

/// An expert playbook Friday can load (backend services/skills): built-in or the user's own.
struct Skill: Identifiable, Hashable {
    let id: String
    let source: String // builtin | user
    let name: String
    let description: String
    let icon: String
    let category: String
    var enabled: Bool
}

enum SkillsApi {
    static func list() async throws -> (categories: [String], skills: [Skill]) {
        let json = try await ApiClient.shared.requestJSON(path: "skills", authed: true)
        let skills = (json["skills"] as? [[String: Any]] ?? []).map {
            Skill(
                id: $0["id"] as? String ?? "",
                source: $0["source"] as? String ?? "builtin",
                name: $0["name"] as? String ?? "Skill",
                description: $0["description"] as? String ?? "",
                icon: $0["icon"] as? String ?? "✨",
                category: $0["category"] as? String ?? "Other",
                enabled: $0["enabled"] as? Bool ?? true
            )
        }
        return (json["categories"] as? [String] ?? [], skills)
    }

    static func setEnabled(id: String, enabled: Bool) async throws {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await ApiClient.shared.request(path: "skills/\(encoded)/enabled", method: "POST", body: ["enabled": enabled], authed: true)
    }
}
