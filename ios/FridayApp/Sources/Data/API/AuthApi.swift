import Foundation

struct AuthSession {
    let accessToken: String
    let refreshToken: String
}

struct AuthResult {
    let user: FridayUser
    let session: AuthSession
}

enum AuthApi {
    static func signup(name: String, email: String, password: String, phone: String?, birthday: String?) async throws {
        _ = try await ApiClient.shared.requestJSON(path: "auth/signup", method: "POST", body: [
            "name": name, "email": email, "password": password,
            "phone": phone ?? "", "birthday": birthday ?? "",
        ])
    }

    static func login(email: String, password: String) async throws {
        _ = try await ApiClient.shared.requestJSON(path: "auth/login", method: "POST", body: [
            "email": email, "password": password,
        ])
    }

    static func resendOtp(email: String) async throws {
        _ = try await ApiClient.shared.requestJSON(path: "auth/resend-otp", method: "POST", body: ["email": email])
    }

    static func verifyOtp(email: String, code: String) async throws -> AuthResult {
        let json = try await ApiClient.shared.requestJSON(path: "auth/verify-otp", method: "POST", body: [
            "email": email, "code": code, "otp": code,
        ])
        return try parseAuthResult(json)
    }

    static func me() async throws -> FridayUser {
        let json = try await ApiClient.shared.requestJSON(path: "auth/me", authed: true)
        guard let userJson = json["user"] as? [String: Any] else { throw ApiError.decode }
        return parseUser(userJson)
    }

    static func logout() async {
        _ = try? await ApiClient.shared.requestJSON(path: "auth/logout", method: "POST", authed: true)
    }

    static func updateProfile(phone: String?, birthday: String?, instructions: String?) async throws -> FridayUser {
        var body: [String: Any] = [:]
        if let phone { body["phone"] = phone }
        if let birthday { body["birthday"] = birthday }
        if let instructions { body["instructions"] = instructions; body["customInstructions"] = instructions }
        let json = try await ApiClient.shared.requestJSON(path: "auth/profile", method: "PATCH", body: body, authed: true)
        return parseUser(json)
    }

    static func exportData() async throws -> Data {
        try await ApiClient.shared.request(path: "auth/export", authed: true)
    }

    static func deleteAccount() async throws {
        _ = try await ApiClient.shared.requestJSON(path: "auth/account", method: "DELETE", authed: true)
    }

    /// `app=ios` makes the web mobile-auth-bridge redirect to com.friday.app.ios://
    /// (Android's `app=main` maps to com.friday.app://) — do not omit it.
    static func googleStartURL() async throws -> URL {
        let json = try await ApiClient.shared.requestJSON(path: "auth/google/start?returnTo=/mobile-auth-bridge%3Fapp%3Dios")
        guard let s = json["url"] as? String, let url = URL(string: s) else { throw ApiError.decode }
        return url
    }

    static func githubStartURL() async throws -> URL {
        let json = try await ApiClient.shared.requestJSON(path: "auth/github/start?returnTo=/mobile-auth-bridge%3Fapp%3Dios")
        guard let s = json["url"] as? String, let url = URL(string: s) else { throw ApiError.decode }
        return url
    }

    static func parseUser(_ json: [String: Any]) -> FridayUser {
        FridayUser(
            name: json["name"] as? String ?? nameFromEmail(json["email"] as? String ?? ""),
            email: json["email"] as? String ?? "",
            phone: json["phone"] as? String,
            birthday: json["birthday"] as? String,
            instructions: (json["instructions"] as? String) ?? (json["customInstructions"] as? String)
        )
    }

    static func parseAuthResult(_ json: [String: Any]) throws -> AuthResult {
        guard let userJson = json["user"] as? [String: Any],
              let sessionJson = json["session"] as? [String: Any],
              let access = (sessionJson["access_token"] as? String) ?? (sessionJson["accessToken"] as? String),
              let refresh = (sessionJson["refresh_token"] as? String) ?? (sessionJson["refreshToken"] as? String)
        else { throw ApiError.decode }
        return AuthResult(user: parseUser(userJson), session: AuthSession(accessToken: access, refreshToken: refresh))
    }

    /// Decodes the `friday_session=<base64url json>` fragment produced by the
    /// OAuth callback redirect.
    static func decodeOAuthCallback(fragment: String) -> AuthResult? {
        guard let range = fragment.range(of: "friday_session=") else { return nil }
        var b64 = String(fragment[range.upperBound...])
        if let amp = b64.firstIndex(of: "&") { b64 = String(b64[..<amp]) }
        b64 = b64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return try? parseAuthResult(json)
    }
}
