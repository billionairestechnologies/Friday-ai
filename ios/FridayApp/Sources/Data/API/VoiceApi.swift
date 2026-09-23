import Foundation

struct Voice: Identifiable, Hashable {
    let id: String
    let name: String
}

enum VoiceApi {
    static func voices() async throws -> [Voice] {
        let json = try await ApiClient.shared.requestJSON(path: "voice/voices", authed: true)
        guard let arr = json["voices"] as? [[String: Any]] else { return [] }
        return arr.map { Voice(id: $0["id"] as? String ?? "", name: $0["name"] as? String ?? "") }
    }

    static func speak(text: String, voiceId: String?) async throws -> Data {
        var body: [String: Any] = ["text": text]
        if let voiceId, !voiceId.isEmpty {
            body["voice"] = voiceId
            body["voiceId"] = voiceId
        }
        var req = URLRequest(url: ApiClient.baseURL.appendingPathComponent("voice/speak"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, http) = try await ApiClient.shared.rawRequest(req)
        guard (200...299).contains(http.statusCode) else { throw ApiError.http(http.statusCode, "TTS failed") }
        return data
    }

    /// MIME must match the actual container or transcription silently fails server-side.
    static func transcribe(audioData: Data, containerMime: String, filename: String) async throws -> String {
        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: ApiClient.baseURL.appendingPathComponent("voice/transcribe"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(containerMime)\r\n\r\n".data(using: .utf8)!)
        body.append(audioData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let (data, http) = try await ApiClient.shared.rawRequest(req)
        guard (200...299).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = json["text"] as? String
        else { throw ApiError.http(http.statusCode, "Transcription failed") }
        return text
    }
}
