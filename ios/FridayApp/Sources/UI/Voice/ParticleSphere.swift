import SwiftUI

/// Particles on a Fibonacci sphere that swell and ripple with the audio. Smoothing runs per
/// rendered frame (fast attack, slower decay, frame-rate independent) inside the Canvas, so the
/// motion stays fluid regardless of how often new audio levels arrive. Frequency bands map
/// along the sphere's vertical axis, so higher-pitched sound lifts the top and lower tones
/// stir the bottom — the sphere visibly follows voice tone, not just loudness.
struct ParticleSphere: View {
    var level: CGFloat // 0...1
    var bands: [CGFloat] // per-frequency-bin values, 0...1
    var voiceId: String?
    var pulsing: Bool = false // gentle idle breathing while "thinking"

    private static let particleCount = 700
    private static let bandCount = 24

    private final class State {
        var level: CGFloat = 0
        var bands = [CGFloat](repeating: 0, count: ParticleSphere.bandCount)
        var lastT: Double = 0
    }

    @SwiftUI.State private var state = State()
    private let points = ParticleSphere.fibonacciSphere(particleCount)

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let t = timeline.date.timeIntervalSinceReferenceDate
                let dt = state.lastT == 0 ? 1.0 / 60 : min(0.05, t - state.lastT)
                state.lastT = t

                let targetLevel: CGFloat = pulsing ? 0.16 + 0.1 * CGFloat(sin(t * 2.4)) : level
                let attack = CGFloat(1 - exp(-dt * 24)), decay = CGFloat(1 - exp(-dt * 7))
                state.level += (targetLevel - state.level) * (targetLevel > state.level ? attack : decay)
                for i in 0..<state.bands.count {
                    let target: CGFloat = pulsing ? state.level * 0.8 : (i < bands.count ? bands[i] : 0)
                    state.bands[i] += (target - state.bands[i]) * (target > state.bands[i] ? attack : decay)
                }

                let lvl = state.level
                let radius = min(size.width, size.height) / 2 * (0.6 + 0.2 * sqrt(lvl))
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let hue = hueForVoice(voiceId) / 360.0
                let rotY = t * (0.15 + Double(lvl) * 0.35)

                for p in points {
                    let bandIdx = min(state.bands.count - 1, max(0, Int((p.y + 1) / 2 * Double(state.bands.count - 1))))
                    let band = state.bands[bandIdx]
                    let expand = 1 + Double(band) * 0.32 + Double(lvl) * 0.06
                    let x = p.x * cos(rotY) - p.z * sin(rotY)
                    let z = p.x * sin(rotY) + p.z * cos(rotY)
                    let y = p.y
                    let perspective = 1.6 / (1.6 - z * 0.6)
                    let sx = center.x + CGFloat(x * expand) * radius * perspective * 0.62
                    let sy = center.y + CGFloat(y * expand) * radius * perspective * 0.62
                    let dotSize: CGFloat = max(1, (2.2 + band * 1.6) * perspective)
                    let sat = 0.55 + Double(lvl) * 0.35
                    let color = Color(hue: hue, saturation: sat, brightness: 0.72 + 0.22 * (z + 1) / 2)
                    let rect = CGRect(x: sx - dotSize / 2, y: sy - dotSize / 2, width: dotSize, height: dotSize)
                    context.fill(Path(ellipseIn: rect), with: .color(color.opacity(0.3 + 0.45 * ((z + 1) / 2))))
                }
            }
        }
    }

    private func hueForVoice(_ voiceId: String?) -> Double {
        guard let voiceId, !voiceId.isEmpty else { return 205 }
        let sum = voiceId.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return Double((sum * 31) % 360)
    }

    private static func fibonacciSphere(_ n: Int) -> [SIMD3<Double>] {
        var pts: [SIMD3<Double>] = []
        let phi = Double.pi * (3 - sqrt(5))
        for i in 0..<n {
            let y = 1 - (Double(i) / Double(n - 1)) * 2
            let r = sqrt(max(0, 1 - y * y))
            let theta = phi * Double(i)
            pts.append(SIMD3(cos(theta) * r, y, sin(theta) * r))
        }
        return pts
    }
}
