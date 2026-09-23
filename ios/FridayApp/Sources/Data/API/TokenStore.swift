import Foundation
import Security

/// Session storage — Keychain for secrets, UserDefaults for non-secret device-level prefs.
/// Mirrors android TokenStore: logout clears tokens/name/email but preserves voiceId/voiceName.
final class TokenStore {
    static let shared = TokenStore()
    private init() {}

    private let service = "com.friday.app.ios.tokens"
    private let defaults = UserDefaults.standard

    private enum Key {
        static let access = "accessToken"
        static let refresh = "refreshToken"
        static let userName = "userName"
        static let userEmail = "userEmail"
        static let voiceId = "voiceId"
        static let voiceName = "voiceName"
    }

    var accessToken: String? {
        get { readKeychain(Key.access) }
        set { writeKeychain(Key.access, newValue) }
    }

    var refreshToken: String? {
        get { readKeychain(Key.refresh) }
        set { writeKeychain(Key.refresh, newValue) }
    }

    var userName: String? {
        get { defaults.string(forKey: Key.userName) }
        set { defaults.set(newValue, forKey: Key.userName) }
    }

    var userEmail: String? {
        get { defaults.string(forKey: Key.userEmail) }
        set { defaults.set(newValue, forKey: Key.userEmail) }
    }

    var voiceId: String? {
        get { defaults.string(forKey: Key.voiceId) }
        set { defaults.set(newValue, forKey: Key.voiceId) }
    }

    var voiceName: String? {
        get { defaults.string(forKey: Key.voiceName) }
        set { defaults.set(newValue, forKey: Key.voiceName) }
    }

    func hasSession() -> Bool { accessToken != nil }

    func saveSession(access: String, refresh: String) {
        accessToken = access
        refreshToken = refresh
    }

    func logout() {
        writeKeychain(Key.access, nil)
        writeKeychain(Key.refresh, nil)
        defaults.removeObject(forKey: Key.userName)
        defaults.removeObject(forKey: Key.userEmail)
        // voiceId/voiceName intentionally preserved across logout.
    }

    // MARK: - Keychain plumbing

    private func readKeychain(_ account: String) -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        query.removeAll()
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeKeychain(_ account: String, _ value: String?) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard let value, let data = value.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
