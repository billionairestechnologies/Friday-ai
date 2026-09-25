import SwiftUI

/// Build Mode's live task list, matching the web/Android UI: one row per step with a state icon,
/// tap to expand its output, "Working for 1m 21s" while it runs, and an "Open preview" card once
/// the app is up.
struct BuildStepsCard: View {
    @EnvironmentObject var vm: FridayViewModel
    let build: BuildInfo
    let streaming: Bool
    @State private var elapsed = 0
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var done: Int { build.steps.filter { $0.state == "ok" }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(build.steps) { StepRow(step: $0) }
            Group {
                if streaming {
                    HStack(spacing: 8) {
                        ProgressView().scaleEffect(0.6)
                        Text("Working for \(elapsed >= 60 ? "\(elapsed / 60)m \(elapsed % 60)s" : "\(elapsed)s")")
                    }
                } else {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark").font(.system(size: 10))
                        Text("\(done) step\(done == 1 ? "" : "s") completed")
                    }
                }
            }
            .font(.system(size: 12))
            .foregroundColor(FridayColor.muted)
            .padding(.top, 4)

            if build.previewUrl != nil {
                Button {
                    withAnimation(.spring(response: 0.26, dampingFraction: 0.88)) { vm.canvasOpen = true }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "play.rectangle").font(.system(size: 14))
                        Text("Live preview is ready").font(.system(size: 14))
                        Spacer()
                        Text("Open").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    }
                    .foregroundColor(FridayColor.text)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(FridayColor.chip)
                    .cornerRadius(12)
                }
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(FridayColor.surface)
        .cornerRadius(16)
        .onReceive(timer) { _ in if streaming { elapsed += 1 } }
    }
}

private struct StepRow: View {
    let step: BuildStep
    @State private var open = false

    private var verb: String {
        switch step.kind {
        case "run": return step.state == "running" ? "Running command" : "Ran command"
        case "start": return step.state == "running" ? "Starting server" : "Started server"
        default: return ""
        }
    }

    private var icon: String {
        switch step.kind {
        case "write", "read": return "doc.text"
        case "start": return "play.fill"
        default: return "terminal"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if step.detail != nil { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } }
            } label: {
                HStack(spacing: 8) {
                    if step.state == "running" {
                        ProgressView().scaleEffect(0.6).frame(width: 14, height: 14)
                    } else if step.state == "error" {
                        Image(systemName: "exclamationmark.circle.fill").font(.system(size: 13)).foregroundColor(FridayColor.error).frame(width: 14)
                    } else {
                        Image(systemName: icon).font(.system(size: 12)).foregroundColor(FridayColor.muted).frame(width: 14)
                    }
                    if !verb.isEmpty { Text(verb).foregroundColor(FridayColor.text) }
                    Text(step.label)
                        .foregroundColor(step.state == "error" ? FridayColor.error : FridayColor.muted)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(.system(size: 13.5))
                .padding(.vertical, 5)
            }
            .buttonStyle(.plain)

            if open, let detail = step.detail {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(detail).font(.system(size: 11, design: .monospaced)).foregroundColor(FridayColor.muted).padding(8)
                }
                .background(FridayColor.chip)
                .cornerRadius(8)
                .padding(.leading, 22).padding(.bottom, 6)
            }
        }
    }
}
