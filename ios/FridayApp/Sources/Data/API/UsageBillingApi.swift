import Foundation

struct UsageBucket {
    let used: Int
    let limit: Int
    var pct: Int { limit > 0 ? Int((Double(used) / Double(limit)) * 100) : 0 }
}

struct UsageQuota {
    let plan: String?
    let resetAt: String?
    let weekly: UsageBucket?
    let monthly: UsageBucket?
    let rolling: UsageBucket?
}

enum UsageApi {
    static func quota() async throws -> UsageQuota {
        let json = try await ApiClient.shared.requestJSON(path: "usage/quota", authed: true)
        // Breakdown may live at top level or nested under "status" — check both.
        let status = json["status"] as? [String: Any]
        func bucket(_ key: String) -> UsageBucket? {
            let dict = (json[key] as? [String: Any]) ?? (status?[key] as? [String: Any])
            guard let dict, let used = dict["used"] as? Int, let limit = dict["limit"] as? Int else { return nil }
            return UsageBucket(used: used, limit: limit)
        }
        return UsageQuota(
            plan: status?["plan"] as? String ?? json["plan"] as? String,
            resetAt: (status?["resetAt"] as? String) ?? (status?["reset_at"] as? String),
            weekly: bucket("weekly"),
            monthly: bucket("monthly"),
            rolling: bucket("rolling")
        )
    }
}

struct BillingOrder: Identifiable {
    let id: String
    let plan: String
    let amountPaise: Int
    let status: String
    let createdAt: String?
}

enum BillingApi {
    static func config() async throws -> (keyId: String, currency: String) {
        let json = try await ApiClient.shared.requestJSON(path: "billing/config")
        return (json["keyId"] as? String ?? "", json["currency"] as? String ?? "INR")
    }

    static func orders() async throws -> [BillingOrder] {
        let json = try await ApiClient.shared.requestJSON(path: "billing/orders", authed: true)
        guard let arr = json["orders"] as? [[String: Any]] else { return [] }
        return arr.map {
            BillingOrder(
                id: $0["id"] as? String ?? "",
                plan: $0["plan"] as? String ?? "",
                amountPaise: $0["amountPaise"] as? Int ?? 0,
                status: $0["status"] as? String ?? "",
                createdAt: $0["createdAt"] as? String
            )
        }
    }

    static func createOrder(planId: String, billingCycle: String, seats: Int?, organizationId: String?) async throws -> [String: Any] {
        var body: [String: Any] = ["planId": planId, "billingCycle": billingCycle]
        if let seats { body["seats"] = seats }
        if let organizationId { body["organizationId"] = organizationId }
        return try await ApiClient.shared.requestJSON(path: "billing/orders", method: "POST", body: body, authed: true)
    }

    /// Polls up to 10x @ 1.5s for the order to flip to "paid" — there is no
    /// client-verification endpoint; confirmation happens server-side via webhook.
    static func pollUntilPaid(orderId: String) async -> Bool {
        for _ in 0..<10 {
            if let order = try? await orders().first(where: { $0.id == orderId }), order.status == "paid" {
                return true
            }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
        return false
    }
}

enum SandboxApi {
    struct RunResult {
        let ok: Bool
        let output: String
        let code: String
        let attempts: Int
    }

    static func run(language: String, code: String) async throws -> RunResult {
        let json = try await ApiClient.shared.requestJSON(path: "sandbox/run", method: "POST", body: [
            "language": language, "code": code, "autoFix": true,
        ], authed: true)
        return RunResult(
            ok: json["ok"] as? Bool ?? false,
            output: json["output"] as? String ?? "",
            code: json["code"] as? String ?? code,
            attempts: (json["attempts"] as? [[String: Any]])?.count ?? 1
        )
    }
}

enum UpdateApi {
    struct Info {
        let version: String
        let url: String
        let notes: String?
    }

    static func check(currentVersion: String) async -> Info? {
        guard let json = try? await ApiClient.shared.requestJSON(path: "app/version?platform=ios") else { return nil }
        guard let version = (json["latestVersion"] as? String) ?? (json["version"] as? String),
              let url = (json["url"] as? String) ?? (json["downloadUrl"] as? String)
        else { return nil }
        guard isNewer(version, than: currentVersion) else { return nil }
        return Info(version: version, url: url, notes: json["notes"] as? String)
    }

    private static func isNewer(_ remote: String, than local: String) -> Bool {
        func parts(_ s: String) -> [Int] {
            s.split(separator: "-").first.map(String.init).map { v in
                v.split(separator: ".").map { Int($0) ?? 0 }
            } ?? []
        }
        let r = parts(remote), l = parts(local)
        for i in 0..<max(r.count, l.count) {
            let rv = i < r.count ? r[i] : 0
            let lv = i < l.count ? l[i] : 0
            if rv != lv { return rv > lv }
        }
        return false
    }
}
