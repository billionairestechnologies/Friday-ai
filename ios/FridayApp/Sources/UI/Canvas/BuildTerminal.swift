import SwiftUI

/// Everything the build ran, as one continuous terminal session (web parity: SessionTerminal in build-preview.tsx): each
/// command with its output and how it ended, file writes as dim comment lines, the running command live at the bottom.
struct BuildTerminal: View {
    let steps: [BuildStep]
    let building: Bool

    private let bg = Color(hex: 0x0C0C0D)
    private let fg = Color(hex: 0xC9CCD1)
    private let dim = Color(hex: 0x5C6370)

    private var entries: [BuildStep] {
        steps.filter { ($0.cmd != nil && ($0.kind == "run" || $0.kind == "start")) || ($0.kind == "write" && $0.state != "running" && $0.path != nil) }
    }

    private func duration(_ ms: Int) -> String { ms < 1000 ? "\(ms)ms" : String(format: "%.1fs", Double(ms) / 1000) }

    var body: some View {
        if entries.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "terminal").font(.system(size: 20))
                Text(building ? "Waiting for the first command…" : "Commands Friday runs for this project show up here.")
                    .font(.system(size: 12, design: .monospaced)).multilineTextAlignment(.center)
            }
            .foregroundColor(Color(hex: 0x6B7078)).padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(bg)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(entries) { st in entry(st).id(st.id) }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(bg)
                // Follows new output as it streams in.
                .onChange(of: entries.map { "\($0.id):\($0.state):\($0.output?.count ?? 0)" }) { _ in
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("end", anchor: .bottom) }
                }
            }
        }
    }

    @ViewBuilder private func entry(_ st: BuildStep) -> some View {
        if st.kind == "write" {
            HStack(spacing: 4) {
                Text("# \(st.lang == "diff" ? "edited" : "wrote") \(st.path ?? "")").foregroundColor(dim)
                if let a = st.added, a > 0 { Text("+\(a)").foregroundColor(Color.green.opacity(0.7)) }
                if let r = st.removed, r > 0 { Text("−\(r)").foregroundColor(Color.red.opacity(0.7)) }
            }
            .font(.system(size: 12, design: .monospaced))
        } else {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .top, spacing: 0) {
                    Text("$ ").foregroundColor(st.state == "error" ? Color.red.opacity(0.9) : Color.green.opacity(0.9))
                    Text(st.cmd ?? "").foregroundColor(Color(hex: 0xE8EAED))
                }
                .font(.system(size: 12, design: .monospaced))
                let out = (st.output ?? (st.state != "running" ? st.detail : nil) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !out.isEmpty {
                    Text(out).font(.system(size: 12, design: .monospaced)).foregroundColor(Color(hex: 0xAEB3BA)).textSelection(.enabled)
                }
                if st.state == "running" {
                    Text("▍").font(.system(size: 12, design: .monospaced)).foregroundColor(fg)
                } else {
                    let ended = st.kind == "start" ? (st.state == "ok" ? "✓ server running" : "✗ server failed to start") : "exit \(st.exitCode ?? (st.state == "ok" ? 0 : 1))"
                    Text(ended + (st.ms.map { " · " + duration($0) } ?? ""))
                        .font(.system(size: 11, design: .monospaced)).foregroundColor(st.state == "error" ? Color.red.opacity(0.9) : dim)
                }
            }
        }
    }
}
