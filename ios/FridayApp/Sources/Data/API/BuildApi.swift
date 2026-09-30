import Foundation

/// Build Mode project endpoints (backend /api/build/:conversationId/…).
enum BuildApi {
    /// GET /api/build/:id/checkpoints — ids of the user messages that have a restore point.
    static func checkpoints(conversationId: String) async throws -> Set<String> {
        let json = try await ApiClient.shared.requestJSON(path: "build/\(conversationId)/checkpoints", authed: true)
        return Set((json["checkpoints"] as? [[String: Any]] ?? []).compactMap { $0["messageId"] as? String })
    }

    /// POST /api/build/:id/restore — files back to before that message, conversation rewound.
    static func restore(conversationId: String, messageId: String) async throws {
        _ = try await ApiClient.shared.requestJSON(path: "build/\(conversationId)/restore", method: "POST", body: ["messageId": messageId], authed: true)
    }

    /// GET /api/build/:id/approvals — prompts this build is waiting on.
    static func approvals(conversationId: String) async throws -> [BuildApproval] {
        let json = try await ApiClient.shared.requestJSON(path: "build/\(conversationId)/approvals", authed: true)
        return (json["approvals"] as? [[String: Any]] ?? []).map { BuildApproval.parse($0) }
    }

    /// POST /api/build/:id/approve — decision: allow | deny | allow_all.
    static func approve(conversationId: String, id: String, decision: String) async throws {
        _ = try await ApiClient.shared.requestJSON(path: "build/\(conversationId)/approve", method: "POST", body: ["id": id, "decision": decision], authed: true)
    }

    /// GET /api/build/sessions — the Build home + drawer list with live status. Throws on failure.
    static func sessions() async throws -> [BuildSessionSummary] {
        let json = try await ApiClient.shared.requestJSON(path: "build/sessions", authed: true)
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return (json["sessions"] as? [[String: Any]] ?? []).map {
            let updated = $0["updatedAt"] as? String
            return BuildSessionSummary(
                id: $0["id"] as? String ?? "",
                title: ($0["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "New build",
                updatedAt: updated.flatMap { iso.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) },
                status: $0["status"] as? String ?? "done",
                activity: $0["activity"] as? String ?? "",
                repo: $0["repo"] as? String,
                prUrl: $0["prUrl"] as? String
            )
        }
    }

    enum Preview {
        case ready(String)
        case failed(String)
    }

    /// Makes sure the sandbox + dev server are alive (restores from snapshot if it expired).
    static func ensurePreview(conversationId: String) async -> Preview {
        do {
            let json = try await ApiClient.shared.requestJSON(path: "build/\(conversationId)/preview", method: "POST", body: [:], authed: true)
            if let url = json["url"] as? String, !url.isEmpty { return .ready(url) }
            return .failed(json["message"] as? String ?? "The preview couldn't be started.")
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// path → contents, or nil on failure.
    static func files(conversationId: String) async -> [String: String]? {
        guard let json = try? await ApiClient.shared.requestJSON(path: "build/\(conversationId)/files", authed: true),
              let files = json["files"] as? [String: String] else { return nil }
        return files
    }

    /// Downloads the project zip into a temp file; nil on failure.
    static func downloadZip(conversationId: String) async -> URL? {
        guard let data = try? await ApiClient.shared.request(path: "build/\(conversationId)/download", authed: true) else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("friday-project.zip")
        do { try data.write(to: url); return url } catch { return nil }
    }
}
