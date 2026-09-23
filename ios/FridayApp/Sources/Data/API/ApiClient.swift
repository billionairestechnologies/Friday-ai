import Foundation

enum ApiError: Error, LocalizedError {
    case http(Int, String)
    case decode
    case noSession

    var errorDescription: String? {
        switch self {
        case .http(let code, let msg): return "\(code): \(msg)"
        case .decode: return "Could not read server response."
        case .noSession: return "You need to be signed in."
        }
    }
}

/// Base HTTP client — mirrors android ApiClient.kt: bearer-token auth, single
/// auto-refresh-and-retry on 401 (capped at one retry), JSON in/out.
actor ApiClient {
    static let shared = ApiClient()

    static let baseURL = URL(string: "https://friday.billionairestechnologies.com/api/")!

    private let session: URLSession
    private var refreshTask: Task<Bool, Never>?

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    // MARK: - JSON requests

    /// appendingPathComponent percent-encodes "?" — that turned query strings into 404 paths.
    static func url(for path: String) -> URL {
        URL(string: baseURL.absoluteString + path) ?? baseURL.appendingPathComponent(path)
    }

    func request(
        path: String,
        method: String = "GET",
        body: [String: Any]? = nil,
        authed: Bool = false,
        allowRetry: Bool = true
    ) async throws -> Data {
        var req = URLRequest(url: Self.url(for: path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        if authed {
            guard let token = TokenStore.shared.accessToken else { throw ApiError.noSession }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw ApiError.decode }

        if http.statusCode == 401, authed, allowRetry {
            if await refreshSession() {
                return try await request(path: path, method: method, body: body, authed: authed, allowRetry: false)
            }
        }

        if !(200...299).contains(http.statusCode) {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { ($0["error"] as? String) ?? ($0["message"] as? String) }
                ?? String(data: data, encoding: .utf8) ?? "Request failed"
            throw ApiError.http(http.statusCode, msg)
        }
        return data
    }

    func requestJSON(
        path: String,
        method: String = "GET",
        body: [String: Any]? = nil,
        authed: Bool = false
    ) async throws -> [String: Any] {
        let data = try await request(path: path, method: method, body: body, authed: authed)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ApiError.decode
        }
        return json
    }

    /// Deduplicated refresh: concurrent 401s share a single in-flight refresh.
    private func refreshSession() async -> Bool {
        if let existing = refreshTask {
            return await existing.value
        }
        let task = Task<Bool, Never> { [weak self] in
            guard let self, let refreshToken = TokenStore.shared.refreshToken else { return false }
            var req = URLRequest(url: Self.baseURL.appendingPathComponent("auth/refresh"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: [
                "refreshToken": refreshToken, "refresh_token": refreshToken,
            ])
            guard let (data, response) = try? await self.session.data(for: req),
                  let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sessionObj = json["session"] as? [String: Any],
                  let access = (sessionObj["access_token"] as? String) ?? (sessionObj["accessToken"] as? String),
                  let refresh = (sessionObj["refresh_token"] as? String) ?? (sessionObj["refreshToken"] as? String)
            else {
                TokenStore.shared.logout()
                return false
            }
            TokenStore.shared.saveSession(access: access, refresh: refresh)
            await RealtimeClient.shared.updateAuth(access)
            return true
        }
        refreshTask = task
        let result = await task.value
        refreshTask = nil
        return result
    }

    /// Raw streaming request for SSE-like endpoints. No read timeout — the
    /// backend stream can run arbitrarily long.
    func streamRequest(path: String, body: [String: Any]) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        var req = URLRequest(url: Self.baseURL.appendingPathComponent(path), timeoutInterval: 3600)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        guard let token = TokenStore.shared.accessToken else { throw ApiError.noSession }
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 3600
        config.timeoutIntervalForResource = 3600
        let streamSession = URLSession(configuration: config)

        let (bytes, response) = try await streamSession.bytes(for: req)
        guard let http = response as? HTTPURLResponse else { throw ApiError.decode }
        if http.statusCode == 401 {
            _ = await refreshSession()
            guard let token2 = TokenStore.shared.accessToken else { throw ApiError.noSession }
            var retry = req
            retry.setValue("Bearer \(token2)", forHTTPHeaderField: "Authorization")
            let (bytes2, response2) = try await streamSession.bytes(for: retry)
            guard let http2 = response2 as? HTTPURLResponse else { throw ApiError.decode }
            return (bytes2, http2)
        }
        return (bytes, http)
    }

    /// Raw bytes / multipart request (for TTS audio, transcription upload).
    func rawRequest(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var request = req
        if let token = TokenStore.shared.accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ApiError.decode }
        if http.statusCode == 401 {
            if await refreshSession(), let token2 = TokenStore.shared.accessToken {
                var retry = request
                retry.setValue("Bearer \(token2)", forHTTPHeaderField: "Authorization")
                let (data2, response2) = try await session.data(for: retry)
                guard let http2 = response2 as? HTTPURLResponse else { throw ApiError.decode }
                return (data2, http2)
            }
        }
        return (data, http)
    }
}
