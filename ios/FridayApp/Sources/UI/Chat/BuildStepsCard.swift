import SwiftUI

private func formatDuration(_ total: Int) -> String {
    let s = max(0, total)
    return s >= 60 ? "\(s / 60)m \(s % 60)s" : "\(s)s"
}

private func formatBytes(_ bytes: Int) -> String {
    bytes >= 1024 * 1024 ? String(format: "%.2f MB", Double(bytes) / 1024 / 1024) : String(format: "%.2f KB", Double(bytes) / 1024)
}

/// Build Mode's task list, laid out like the reference product: while working, flat rows joined by
/// a thin vertical line plus "Working for 15s"; once finished it folds into one
/// "Worked for 7m 39s ›" line that expands to the same rows.
struct BuildStepsCard: View {
    @EnvironmentObject var vm: FridayViewModel
    let build: BuildInfo
    let streaming: Bool
    @State private var elapsed = 0
    @State private var expanded = false
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(build.steps) { StepRow(step: $0) }
        }
        .background(alignment: .leading) {
            Rectangle().fill(FridayColor.hairline).frame(width: 1).padding(.leading, 7).padding(.vertical, 10)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if streaming {
                rows
                HStack(spacing: 8) {
                    ProgressView().scaleEffect(0.6)
                    Text("Working for \(formatDuration(elapsed))")
                }
                .font(.system(size: 13)).foregroundColor(FridayColor.muted)
            } else {
                let seconds = (build.elapsedMs ?? 0) / 1000
                Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                    HStack(spacing: 4) {
                        Text(seconds > 0 ? "Worked for \(formatDuration(seconds))" : "\(build.steps.count) steps")
                        Image(systemName: "chevron.right").font(.system(size: 11)).rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    .font(.system(size: 13.5)).foregroundColor(FridayColor.muted)
                }
                if expanded { rows }
                if build.previewUrl != nil {
                    Button {
                        withAnimation(.spring(response: 0.26, dampingFraction: 0.88)) { vm.canvasOpen = true }
                    } label: {
                        Text("Open live preview")
                            .font(.system(size: 12.5)).foregroundColor(FridayColor.text)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(FridayColor.chip).clipShape(Capsule())
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onReceive(timer) { _ in if streaming { elapsed += 1 } }
    }
}

/// The downloadable project as a file card: "name.zip · Archive · 29.69 KB · Download".
struct ProjectZipCard: View {
    let build: BuildInfo
    let conversationId: String
    @State private var shareURL: URL?
    @State private var failed = false

    var body: some View {
        if let bytes = build.zipBytes {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 12) {
                    Image(systemName: "doc.zipper").font(.system(size: 28)).foregroundColor(FridayColor.muted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(build.zipName ?? "project.zip").font(.system(size: 14, weight: .medium)).foregroundColor(FridayColor.text).lineLimit(1)
                        Text("Archive · \(formatBytes(bytes))").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    }
                    Spacer()
                    Button {
                        Task {
                            if let url = await BuildApi.downloadZip(conversationId: conversationId) { shareURL = url } else { failed = true }
                        }
                    } label: {
                        Text("Download").font(.system(size: 13)).foregroundColor(FridayColor.text)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(FridayColor.chip).clipShape(Capsule())
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(FridayColor.surface).cornerRadius(16)
                if failed { Text("Couldn't download the project — check your connection.").font(.system(size: 12)).foregroundColor(FridayColor.error) }
            }
            .sheet(item: Binding(get: { shareURL.map { ZipShare(url: $0) } }, set: { if $0 == nil { shareURL = nil } })) { item in
                ZipActivityView(items: [item.url])
            }
        }
    }
}

private struct ZipShare: Identifiable { let url: URL; var id: String { url.absoluteString } }

private struct ZipActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
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
