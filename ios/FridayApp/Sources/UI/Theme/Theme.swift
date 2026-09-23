import SwiftUI

/// Friday design tokens — ported 1:1 from android/app/src/main/java/com/friday/app/ui/theme/Color.kt.
/// The app is light-mode only except Plans and the Auth landing bottom card, which are intentionally dark.
enum FridayColor {
    static let bg = Color(hex: 0xFFFFFF)
    static let sidebar = Color(hex: 0xF0F4F9)
    static let surface = Color(hex: 0xF4F4F5)
    static let text = Color(hex: 0x1F1F1F)
    static let muted = Color(hex: 0x5F6368)
    static let glow = Color(hex: 0xD3E3FD)
    static let search = Color(hex: 0x2563EB)
    static let think = Color(hex: 0x7C3AED)
    static let canvas = Color(hex: 0xEA580C)
    static let softBlue = Color(hex: 0xC2E7FF)
    static let codeBg = Color(hex: 0x151515)
    static let codeFg = Color(hex: 0xE8EAED)
    static let codeTag = Color(hex: 0x8AB4F8)
    static let codeAttr = Color(hex: 0xF9A8D4)
    static let codeString = Color(hex: 0xB8E994)
    static let codeComment = Color(hex: 0x9AA0A6)
    static let stop = Color(hex: 0x1A73E8)
    static let success = Color(hex: 0x16A34A)
    static let error = Color(hex: 0xDC2626)
    static let chip = Color(hex: 0xE9EEF6)
    static let hairline = Color(hex: 0x1F1F1F).opacity(0.08)
    static let scrim = Color(hex: 0x202124).opacity(0.32)

    // Plans screen — always dark.
    static let planBg = Color(hex: 0x000000)
    static let planSurface = Color(hex: 0x1C1C1E)
    static let planSurfaceRaised = Color(hex: 0x232326)
    static let planText = Color(hex: 0xFFFFFF)
    static let planMuted = Color(hex: 0x98989D)
    static let planAccent = Color(hex: 0x0A84FF)
    static let planHairline = Color.white.opacity(0.12)

    // Auth landing bottom card — always dark.
    static let landingCard = Color(hex: 0x0D0D0D)
    static let landingPill = Color(hex: 0x2A2A2A)
}

enum FridayRadius {
    static let composer: CGFloat = 28
    static let bubble: CGFloat = 20
    static let code: CGFloat = 14
    static let sheet: CGFloat = 20
}

enum FridayType {
    static func display() -> Font { .system(size: 32, weight: .medium) }
    static func title() -> Font { .system(size: 17, weight: .medium) }
    static func body() -> Font { .system(size: 15.5) }
    static func bodyMedium() -> Font { .system(size: 13.5) }
    static func labelMedium() -> Font { .system(size: 13, weight: .medium) }
    static func labelSmall() -> Font { .system(size: 12, weight: .medium) }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

/// Whether entrance/decorative animations should play — mirrors Android's
/// `Settings.Global.ANIMATOR_DURATION_SCALE == 0f` check.
enum Motion {
    static var reduced: Bool { UIAccessibility.isReduceMotionEnabled }
}
