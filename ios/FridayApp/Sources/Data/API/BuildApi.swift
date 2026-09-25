import Foundation

/// Build Mode project endpoints (backend /api/build/:conversationId/…).
enum BuildApi {
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
