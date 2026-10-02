import Foundation

struct ProjectSummary: Identifiable, Hashable {
    let id: String
    var name: String
    var description: String
    var instructions: String
}

/// A file in a project's knowledge base (backend services/knowledge): status is processing | ready | error.
struct ProjectFile: Identifiable, Hashable {
    let id: String
    let filename: String
    let sizeBytes: Int
    let status: String
    let error: String?
    let chunkCount: Int
    let embedded: Bool
}

enum ProjectsApi {
    static func list() async throws -> [ProjectSummary] {
        let json = try await ApiClient.shared.requestJSON(path: "projects", authed: true)
        return (json["projects"] as? [[String: Any]] ?? []).map(parse)
    }

    static func create(name: String, description: String, instructions: String) async throws -> ProjectSummary {
        let json = try await ApiClient.shared.requestJSON(
            path: "projects", method: "POST",
            body: ["name": name, "description": description, "instructions": instructions, "mode": "work"],
            authed: true
        )
        guard let p = json["project"] as? [String: Any] else { throw ApiError.decode }
        return parse(p)
    }

    static func delete(id: String) async throws {
        _ = try await ApiClient.shared.request(path: "projects/\(id)", method: "DELETE", authed: true)
    }

    static func files(projectId: String) async throws -> [ProjectFile] {
        let json = try await ApiClient.shared.requestJSON(path: "projects/\(projectId)/files", authed: true)
        return (json["files"] as? [[String: Any]] ?? []).map {
            ProjectFile(
                id: $0["id"] as? String ?? UUID().uuidString,
                filename: $0["filename"] as? String ?? "file",
                sizeBytes: $0["size_bytes"] as? Int ?? 0,
                status: $0["status"] as? String ?? "processing",
                error: $0["error"] as? String,
                chunkCount: $0["chunk_count"] as? Int ?? 0,
                embedded: $0["embedded"] as? Bool ?? false
            )
        }
    }

    /// POST /projects/:id/files (multipart, field "files") — the server reads and indexes it in the background.
    static func upload(projectId: String, fileURL: URL) async throws {
        let scoped = fileURL.startAccessingSecurityScopedResource()
        defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: fileURL)
        let mime = mimeType(for: fileURL.pathExtension)
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: ApiClient.baseURL.appendingPathComponent("projects/\(projectId)/files"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"files\"; filename=\"\(fileURL.lastPathComponent)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body
        let (resp, http) = try await ApiClient.shared.rawRequest(req)
        guard (200...299).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: resp) as? [String: Any])?["error"] as? String
            throw ApiError.http(http.statusCode, msg ?? "Upload failed")
        }
    }

    static func deleteFile(projectId: String, fileId: String) async throws {
        _ = try await ApiClient.shared.request(path: "projects/\(projectId)/files/\(fileId)", method: "DELETE", authed: true)
    }

    /// The project's own chats (kept out of the main chat list).
    static func conversations(projectId: String) async throws -> [ConversationsApi.Summary] {
        let json = try await ApiClient.shared.requestJSON(path: "projects/\(projectId)/conversations", authed: true)
        return (json["conversations"] as? [[String: Any]] ?? []).map {
            ConversationsApi.Summary(id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "New chat", updatedAt: $0["updated_at"] as? String, workspace: $0["workspace"] as? String, hasBuild: $0["has_build"] as? Bool ?? false)
        }
    }

    private static func parse(_ p: [String: Any]) -> ProjectSummary {
        ProjectSummary(id: p["id"] as? String ?? "", name: p["name"] as? String ?? "Project", description: p["description"] as? String ?? "", instructions: p["instructions"] as? String ?? "")
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "pdf": return "application/pdf"
        case "txt", "md": return "text/plain"
        case "csv": return "text/csv"
        case "json": return "application/json"
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        default: return "application/octet-stream"
        }
    }
}
