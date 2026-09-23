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


/// Vendor logos ported from android res/drawable/ic_*.xml (24x24 viewport).
struct ModelLogo: View {
    let key: String
    var size: CGFloat = 14
    var dim: Bool = false

    static func brand(for key: String) -> String? {
        let s = key.lowercased()
        if s.contains("claude") || s.contains("fable") { return "anthropic" }
        if s.contains("gpt") { return "openai" }
        if s.contains("nemotron") || s.contains("nvidia") { return "nvidia" }
        if s.contains("glm") || s.contains("z-ai") { return "glm" }
        return nil
    }

    private static let data: [String: (UInt32, [String])] = [
        "anthropic": (0xD97757, [
            "M16.7,4.4h-3.3l6.1,15.4h3.3z",
            "M7.4,4.4L1.3,19.8h3.4l1.2,-3.2h6.3l1.2,3.2h3.4L10.1,4.4zM7,13.6l2.1,-5.6l2.1,5.6z",
        ]),
        "openai": (0x10A37F, [
            "M22.3,10.2c0.4,-1.2 0.3,-2.5 -0.4,-3.6c-1,-1.7 -3,-2.6 -4.9,-2.2c-0.9,-1 -2.2,-1.5 -3.5,-1.5c-2,0 -3.7,1.3 -4.3,3.1c-1.3,0.3 -2.4,1.1 -3.1,2.3c-1,1.7 -0.8,3.9 0.5,5.4c-0.4,1.2 -0.3,2.5 0.4,3.6c1,1.7 3,2.6 4.9,2.2c0.9,1 2.2,1.5 3.5,1.5c2,0 3.7,-1.3 4.3,-3.1c1.3,-0.3 2.4,-1.1 3.1,-2.3C23.7,13.9 23.6,11.7 22.3,10.2zM13.2,20c-0.9,0 -1.7,-0.3 -2.4,-0.9c0,0 0.1,-0.1 0.2,-0.1l3.9,-2.3c0.2,-0.1 0.3,-0.3 0.3,-0.5v-5.6l1.6,0.9c0,0 0,0.1 0,0.1v4.6C16.9,18.4 15.2,20 13.2,20zM5.9,16.4c-0.4,-0.7 -0.6,-1.6 -0.4,-2.4c0,0 0.1,0.1 0.2,0.1l3.9,2.3c0.2,0.1 0.4,0.1 0.6,0l4.7,-2.7v1.9c0,0 0,0.1 -0.1,0.1l-3.9,2.3C9.2,19,7,18.4 5.9,16.4zM4.9,8.6C5.3,7.9 6,7.3 6.8,7.1c0,0 0,0.1 0,0.2v4.6c0,0.2 0.1,0.4 0.3,0.5l4.7,2.7l-1.6,0.9c0,0 -0.1,0 -0.2,0L6.1,13.7C4.2,12.6 3.6,10.4 4.9,8.6zM18.6,11.9l-4.7,-2.7l1.6,-0.9c0,0 0.1,0 0.2,0l3.9,2.3c1.9,1.1 2.6,3.4 1.3,5.2c-0.4,0.7 -1.1,1.3 -1.9,1.5c0,0 0,-0.1 0,-0.2v-4.6C19,12.3 18.8,12 18.6,11.9zM20.2,9.3c0,0 -0.1,-0.1 -0.2,-0.1l-3.9,-2.3c-0.2,-0.1 -0.4,-0.1 -0.6,0l-4.7,2.7V7.7c0,0 0,-0.1 0.1,-0.1l3.9,-2.3c1.9,-1.1 4.1,-0.5 5.2,1.4C20.4,7.5 20.5,8.4 20.2,9.3zM9.9,12.9l-1.6,-0.9c0,0 0,-0.1 0,-0.1V7.4c0,-2.1 1.7,-3.8 3.8,-3.8c0.9,0 1.7,0.3 2.4,0.9c0,0 -0.1,0.1 -0.2,0.1l-3.9,2.3c-0.2,0.1 -0.3,0.3 -0.3,0.5V12.9z",
        ]),
        "nvidia": (0x76B900, [
            "M12,3C7,3 2.5,6.2 1,12c1.5,5.8 6,9 11,9s9.5,-3.2 11,-9C21.5,6.2 17,3 12,3zM12,17c-3.3,0 -6,-2.2 -7,-5c1,-2.8 3.7,-5 7,-5s6,2.2 7,5C18,14.8 15.3,17 12,17z",
            "M12,9.5c-1.4,0 -2.5,1.1 -2.5,2.5s1.1,2.5 2.5,2.5s2.5,-1.1 2.5,-2.5S13.4,9.5 12,9.5z",
        ]),
        "glm": (0x1F1F1F, [
            "M12.606,1.806l-1.677,2.388c-0.258,0.374 -0.697,0.606 -1.161,0.606h-9.162V1.794C0.594,1.806 12.606,1.806 12.606,1.806z",
            "M24,1.806L9.6,22.206 0,22.206 14.4,1.806z",
            "M11.394,22.206l1.69,-2.4c0.258,-0.374 0.697,-0.606 1.161,-0.606h9.149v3.006H11.394z",
        ]),
    ]

    var body: some View {
        if let b = Self.brand(for: key), let entry = Self.data[b] {
            ZStack {
                ForEach(0..<entry.1.count, id: \.self) { i in
                    SVGPathShape(d: entry.1[i], viewport: 24).fill(Color(hex: entry.0))
                }
            }
            .frame(width: size, height: size)
            .saturation(dim ? 0 : 1)
        } else {
            Image(systemName: "sparkles").font(.system(size: size * 0.9)).foregroundColor(FridayColor.muted)
        }
    }
}
