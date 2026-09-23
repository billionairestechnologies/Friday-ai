import SwiftUI

/// ~900 particles on a Fibonacci sphere, slowly rotating at rest, reacting
/// to (level, bands) fed every frame with asymmetric VU-meter-style
/// smoothing. Ported conceptually from android ParticleSphere.kt using
/// SwiftUI Canvas + TimelineView instead of a custom Compose drawer.
struct ParticleSphere: View {
    var level: CGFloat // 0...1
    var bands: [CGFloat] // coarse per-frequency-bin values, 0...1
    var voiceId: String?

    private static let particleCount = 900
    @State private var points: [SIMD3<Double>] = ParticleSphere.fibonacciSphere(particleCount)
    @State private var smoothedLevel: CGFloat = 0
    @State private var smoothedBands: [CGFloat] = Array(repeating: 0, count: 24)

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let t = timeline.date.timeIntervalSinceReferenceDate
                let radius = min(size.width, size.height) / 2 * (0.62 + 0.22 * sqrt(smoothedLevel))
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let hue = hueForVoice(voiceId) / 360.0
                let rotY = t * 0.15

                for (i, p) in points.enumerated() {
                    let band = smoothedBands[i % smoothedBands.count]
                    let jitter = 1 + Double(band) * 0.18
                    let x = p.x * cos(rotY) - p.z * sin(rotY)
                    let z = p.x * sin(rotY) + p.z * cos(rotY)
                    let y = p.y
                    let perspective = 1.6 / (1.6 - z * 0.6)
                    let sx = center.x + CGFloat(x * jitter) * radius * perspective * 0.6
                    let sy = center.y + CGFloat(y * jitter) * radius * perspective * 0.6
                    let dotSize: CGFloat = max(1, 2.4 * perspective)
                    let sat = 0.55 + Double(smoothedLevel) * 0.35
                    let color = Color(hue: hue, saturation: sat, brightness: 0.75 + 0.2 * (z + 1) / 2)
                    let rect = CGRect(x: sx - dotSize / 2, y: sy - dotSize / 2, width: dotSize, height: dotSize)
                    context.fill(Path(ellipseIn: rect), with: .color(color.opacity(0.35 + 0.4 * ((z + 1) / 2))))
                }
            }
            .onChange(of: level) { _ in updateSmoothing() }
            .onChange(of: bands) { _ in updateSmoothing() }
        }
    }

    private func updateSmoothing() {
        // Fast attack, slow decay.
        let attack: CGFloat = 0.28, decay: CGFloat = 0.08
        let coeff = level > smoothedLevel ? attack : decay
        smoothedLevel += (level - smoothedLevel) * coeff
        for i in 0..<smoothedBands.count {
            let target = i < bands.count ? bands[i] : 0
            let c = target > smoothedBands[i] ? attack : decay
            smoothedBands[i] += (target - smoothedBands[i]) * c
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
