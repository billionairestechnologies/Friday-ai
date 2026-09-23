import Foundation
import SwiftUI

/// Ported verbatim from android ThinkingLines.kt — the rotating phrase pools
/// shown while a reply streams.
enum ThinkingLines {
    static let activeThink = [
        "Consulting my inner monologue…", "Turning this over a few times…",
        "Untangling this properly…", "Reasoning through it…",
    ]
    static let activeSearch = [
        "Digging through the results…", "Cross-checking sources…", "Piecing it together…",
    ]
    static let activeCanvas = [
        "Writing the code…", "Putting it together…", "Sketching it out…",
    ]
    static let pillThink = [
        "Connecting the dots…", "Working through the angles…", "Mapping the pieces…",
    ]
    static let pillSearch = [
        "Chasing down the latest on this…", "Scanning for the details…", "Lining up the sources…",
    ]
    static let pillCanvas = [
        "Shaping the layout…", "Refining the structure…",
    ]

    static func activePool(for modes: Set<Mode>) -> [String] {
        if modes.contains(.canvas) { return activeCanvas }
        if modes.contains(.search) { return activeSearch }
        return activeThink
    }

    static func pillPool(for modes: Set<Mode>) -> [String] {
        if modes.contains(.canvas) { return pillCanvas }
        if modes.contains(.search) { return pillSearch }
        return pillThink
    }
}

/// Cross-fades through a phrase pool on a timer — used by ThinkingPill and
/// the ThoughtCard's live active-step row.
struct RotatingPhrase: View {
    let pool: [String]
    let interval: TimeInterval
    let font: Font
    let color: Color

    @State private var index = 0

    var body: some View {
        Text(pool.isEmpty ? "" : pool[index % pool.count])
            .font(font)
            .foregroundColor(color)
            .id(index)
            .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .bottom)), removal: .opacity))
            .onAppear { schedule() }
    }

    private func schedule() {
        guard !pool.isEmpty else { return }
        Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { timer in
            Task { @MainActor in
                withAnimation(.easeInOut(duration: 0.25)) { index += 1 }
            }
        }
    }
}
