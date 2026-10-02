import Foundation

enum FilesApi {
    /// GET /files/:id/download — files are private to their owner, so this goes through the authenticated API.
    static func download(id: String) async throws -> Data {
        var req = URLRequest(url: ApiClient.baseURL.appendingPathComponent("files/\(id)/download"))
        req.httpMethod = "GET"
        let (data, http) = try await ApiClient.shared.rawRequest(req)
        if http.statusCode == 404 { throw ApiError.http(404, "This file was deleted from your Library") }
        guard (200...299).contains(http.statusCode) else { throw ApiError.http(http.statusCode, "Download failed") }
        return data
    }
}
