import SwiftUI

/// "Creating image": a soft dot grid that ripples outward from the centre until the real image lands,
/// with a simulated completion percentage — matches web's ImageDotGrid and Android's GeneratingImagePill.
/// Image generation is one blocking server call with no real progress, so the percentage just climbs
/// and decelerates toward (never reaching) 92.
struct ImageGeneratingView: View {
    @State private var started = Date()

    private let grid = 13

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TimelineView(.periodic(from: .now, by: 0.5)) { timeline in
                let elapsed = timeline.date.timeIntervalSince(started)
                let pct = Int(92 * (1 - exp(-elapsed / 12)))
                HStack(spacing: 8) {
                    Text("Creating image").font(.system(size: 15, weight: .medium)).foregroundColor(FridayColor.text)
                    Text("\(pct)%").font(.system(size: 15)).foregroundColor(FridayColor.muted).monospacedDigit()
                }
            }
            TimelineView(.animation) { timeline in
                let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                Canvas { context, size in
                    let cell = size.width / CGFloat(grid)
                    let centre = CGFloat(grid - 1) / 2
                    let maxDist = (centre * centre + centre * centre).squareRoot()
                    for row in 0..<grid {
                        for col in 0..<grid {
                            let dx = CGFloat(col) - centre, dy = CGFloat(row) - centre
                            let d = (dx * dx + dy * dy).squareRoot() / maxDist
                            // Each dot pulses once per cycle, delayed by its distance from the centre.
                            var t = phase - Double(d) * 0.6 + 1
                            t = t.truncatingRemainder(dividingBy: 1)
                            let wave = max(0, sin(t * Double.pi))
                            let radius = cell * CGFloat(0.1 + 0.2 * wave)
                            let centreX = cell * (CGFloat(col) + 0.5), centreY = cell * (CGFloat(row) + 0.5)
                            let rect = CGRect(x: centreX - radius, y: centreY - radius, width: radius * 2, height: radius * 2)
                            context.fill(Path(ellipseIn: rect), with: .color(FridayColor.think.opacity(0.2 + 0.75 * wave)))
                        }
                    }
                }
            }
            .frame(width: 200, height: 200)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Creating image")
    }
}
