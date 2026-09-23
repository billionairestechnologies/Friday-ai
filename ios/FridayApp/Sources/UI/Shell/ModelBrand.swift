import SwiftUI

/// Model→vendor branding resolution — mirrors android ModelBrand.kt.
enum ModelBrand {
    static func systemIcon(for modelIdAndName: String) -> String {
        let s = modelIdAndName.lowercased()
        if s.contains("claude") || s.contains("fable") { return "a.circle.fill" }
        if s.contains("gpt") { return "o.circle.fill" }
        if s.contains("nemotron") || s.contains("nvidia") { return "n.circle.fill" }
        if s.contains("glm") || s.contains("z-ai") { return "z.circle.fill" }
        return "sparkles"
    }

    static func displayLabel(_ name: String) -> String {
        var s = name
        for prefix in ["Claude ", "Z.ai: ", "NVIDIA: "] {
            if s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
        }
        return s
    }

    static func iconFor(modelId: String) -> String {
        if modelId == AUTO_MODEL_ID { return "bolt.fill" }
        if modelId == TEAMUP_MODEL_ID { return "person.3.fill" }
        return "sparkles"
    }

    /// Plan tier ranking — mirrors backend's PLAN_RANK in tierConfig.ts (free:0, pro:1, premium:2).
    private static let planRank: [String: Int] = ["free": 0, "pro": 1, "premium": 2]

    static func planSatisfies(_ plan: String, minTier: String?) -> Bool {
        guard let minTier, !minTier.isEmpty else { return true }
        let userRank = planRank[plan.lowercased()] ?? 0
        let requiredRank = planRank[minTier.lowercased()] ?? 0
        return userRank >= requiredRank
    }

    /// Brand tint — mirrors android ModelBrand.kt's logo colors (ic_anthropic/openai/nvidia/glm).
    static func color(for modelIdAndName: String) -> Color {
        let s = modelIdAndName.lowercased()
        if s.contains("claude") || s.contains("fable") { return Color(hex: 0xD97757) }
        if s.contains("gpt") { return Color(hex: 0x10A37F) }
        if s.contains("nemotron") || s.contains("nvidia") { return Color(hex: 0x76B900) }
        if s.contains("glm") || s.contains("z-ai") { return FridayColor.text }
        return FridayColor.muted
    }
}
