import Foundation

/// One quota window: tokens used / allowed and when it resets (backend services/quota — buckets carry their own resetAt).
struct UsageBucket {
    let used: Double
    let limit: Double
    let resetAt: String?
    /// Clamped both ways like the web: bonus grants/refunds can push a counter below 0 or above the limit.
    var pct: Int { limit > 0 ? max(0, min(100, Int((used / limit * 100).rounded()))) : 0 }
}

struct UsageBreakdownEntry: Hashable {
    let type: String
    let percent: Int
}

struct PlanEntitlements {
    let buildMode: Bool
    let buildMaxRounds: Int
    let deepResearchPerDay: Int
    let documentsPerDay: Int
    let customSkills: Int
    let libraryStorageMb: Int
    let teamUpModels: Int
    let mcpServers: Int
    let automations: Int
    let prioritySupport: Bool
}

struct UsageQuota {
    let plan: String?
    let isEnterprise: Bool
    let resetAt: String?
    let weekly: UsageBucket?
    let monthly: UsageBucket?
    let rolling: UsageBucket?
    let orgPool: UsageBucket?
    let orgSeats: Int
    let memberCap: UsageBucket?
    let breakdown: [UsageBreakdownEntry]
    let rollingBreakdown: [UsageBreakdownEntry]
    let monthlyBreakdown: [UsageBreakdownEntry]
    let entitlements: PlanEntitlements?
}

private func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

enum UsageApi {
    static func quota() async throws -> UsageQuota {
        let json = try await ApiClient.shared.requestJSON(path: "usage/quota", authed: true)
        // Newer servers nest the buckets under "status"; older ones put them at the top level.
        let status = json["status"] as? [String: Any]
        func bucket(_ key: String) -> UsageBucket? {
            let dict = (status?[key] as? [String: Any]) ?? (json[key] as? [String: Any])
            guard let dict, let used = num(dict["used"]), let limit = num(dict["limit"]) else { return nil }
            return UsageBucket(used: used, limit: limit, resetAt: dict["resetAt"] as? String)
        }
        func entries(_ key: String) -> [UsageBreakdownEntry] {
            (json[key] as? [[String: Any]] ?? []).map { UsageBreakdownEntry(type: $0["type"] as? String ?? "", percent: Int(num($0["percent"]) ?? 0)) }
        }
        let e = json["entitlements"] as? [String: Any]
        let org = status?["org"] as? [String: Any]
        return UsageQuota(
            plan: status?["plan"] as? String ?? json["plan"] as? String,
            isEnterprise: status?["isEnterprise"] as? Bool ?? false,
            resetAt: (status?["weekly"] as? [String: Any])?["resetAt"] as? String,
            weekly: bucket("weekly"),
            monthly: bucket("monthly"),
            rolling: bucket("rolling"),
            orgPool: bucket("org"),
            orgSeats: Int(num(org?["seatCount"]) ?? 0),
            memberCap: bucket("memberCap").map { UsageBucket(used: $0.used, limit: $0.limit, resetAt: org?["resetAt"] as? String) },
            breakdown: entries("breakdown"),
            rollingBreakdown: entries("rollingBreakdown"),
            monthlyBreakdown: entries("monthlyBreakdown"),
            entitlements: e.map {
                PlanEntitlements(
                    buildMode: $0["buildMode"] as? Bool ?? false, buildMaxRounds: Int(num($0["buildMaxRounds"]) ?? 0),
                    deepResearchPerDay: Int(num($0["deepResearchPerDay"]) ?? 0), documentsPerDay: Int(num($0["documentsPerDay"]) ?? 0),
                    customSkills: Int(num($0["customSkills"]) ?? 0), libraryStorageMb: Int(num($0["libraryStorageMb"]) ?? 0),
                    teamUpModels: Int(num($0["teamUpModels"]) ?? 0), mcpServers: Int(num($0["mcpServers"]) ?? 0),
                    automations: Int(num($0["automations"]) ?? 0), prioritySupport: $0["prioritySupport"] as? Bool ?? false
                )
            }
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
