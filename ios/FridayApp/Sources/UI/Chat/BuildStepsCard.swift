import SwiftUI

/// Spinning multicolor ring — the "working" symbol next to steps and "Working for 26s".
struct BuildOrb: View {
    var size: CGFloat = 14
    @State private var spin = false
    var body: some View {
        Circle()
            .strokeBorder(
                AngularGradient(colors: [Color(hex: 0x4F8CFF), Color(hex: 0xA855F7), Color(hex: 0xFF6B6B), Color(hex: 0xFFB547), Color(hex: 0x34D399), Color(hex: 0x4F8CFF)], center: .center),
                lineWidth: size * 0.22
            )
            .frame(width: size, height: size)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(.linear(duration: 0.9).repeatForever(autoreverses: false), value: spin)
            .onAppear { spin = true }
    }
}

/// "Build Mode" start-up card shown the instant a build begins (before any step exists).
struct BuildBanner: View {
    @State private var phase: CGFloat = -0.4
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "hammer.fill").font(.system(size: 16)).foregroundColor(FridayColor.text)
                .frame(width: 36, height: 36).background(FridayColor.chip).cornerRadius(10)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text("Build Mode").font(.system(size: 14.5, weight: .semibold)).foregroundColor(FridayColor.text)
                    BuildOrb()
                }
                Text("Spinning up a sandbox to build, install, run and test your project…").font(.system(size: 12)).foregroundColor(FridayColor.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            GeometryReader { geo in
                LinearGradient(colors: [FridayColor.surface, Color(hex: 0x788CFF).opacity(0.18), FridayColor.surface], startPoint: .leading, endPoint: .trailing)
                    .frame(width: geo.size.width * 2)
                    .offset(x: geo.size.width * (phase * 2 - 0.5))
            }
            .background(FridayColor.surface)
            .clipped()
        )
        .cornerRadius(16)
        .onAppear { withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) { phase = 0.6 } }
    }
}

private func formatDuration(_ total: Int) -> String {
    let s = max(0, total)
    return s >= 60 ? "\(s / 60)m \(s % 60)s" : "\(s)s"
}

private func formatBytes(_ bytes: Int) -> String {
    bytes >= 1024 * 1024 ? String(format: "%.2f MB", Double(bytes) / 1024 / 1024) : String(format: "%.2f KB", Double(bytes) / 1024)
}

/// The architecture + todo checklist Build Mode drafts before coding, ticked off live as items finish.
private struct PlanCard: View {
    let plan: BuildPlan
    @State private var showArch = false

    var body: some View {
        let done = plan.items.filter { $0.state == "done" }.count
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Plan").font(.system(size: 14.5, weight: .semibold)).foregroundColor(FridayColor.text)
                Spacer()
                Text("\(done)/\(plan.items.count)").font(.system(size: 12)).foregroundColor(FridayColor.muted)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(FridayColor.chip)
                    Capsule().fill(FridayColor.text)
                        .frame(width: plan.items.isEmpty ? 0 : geo.size.width * CGFloat(done) / CGFloat(plan.items.count))
                        .animation(.easeOut(duration: 0.4), value: done)
                }
            }
            .frame(height: 4)
            if !plan.architecture.isEmpty {
                Button { withAnimation(.easeOut(duration: 0.15)) { showArch.toggle() } } label: {
                    HStack(spacing: 4) {
                        Text("Architecture").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                        Image(systemName: "chevron.right").font(.system(size: 9)).foregroundColor(FridayColor.muted).rotationEffect(.degrees(showArch ? 90 : 0))
                    }
                }
                if showArch { Text(plan.architecture).font(.system(size: 12)).foregroundColor(FridayColor.muted) }
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(plan.items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 8) {
                        Group {
                            if item.state == "done" {
                                Image(systemName: "checkmark.circle.fill").font(.system(size: 15)).foregroundColor(FridayColor.text)
                            } else if item.state == "doing" {
                                BuildOrb(size: 14)
                            } else {
                                Circle().stroke(FridayColor.hairline, lineWidth: 1.5).frame(width: 14, height: 14)
                            }
                        }
                        .frame(width: 16, height: 16)
                        Text(item.text).font(.system(size: 13.5))
                            .foregroundColor(item.state == "done" ? FridayColor.muted : FridayColor.text)
                            .strikethrough(item.state == "done")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(FridayColor.surface)
        .cornerRadius(16)
    }
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

    /// Consecutive file writes fold into one "Edited 9 files" row, like the reference product.
    private var groups: [[BuildStep]] {
        var out: [[BuildStep]] = []
        for step in build.steps {
            if step.kind == "write", let last = out.last, last.first?.kind == "write" { out[out.count - 1].append(step) } else { out.append([step]) }
        }
        return out
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(groups, id: \.first!.id) { g in
                if g.first!.kind == "write" { WriteGroup(steps: g) } else { StepRow(step: g[0]) }
            }
        }
        .background(alignment: .leading) {
            Rectangle().fill(FridayColor.hairline).frame(width: 1).padding(.leading, 7).padding(.vertical, 10)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let plan = build.plan { PlanCard(plan: plan) }
            if streaming {
                HStack(spacing: 6) {
                    Image(systemName: "hammer.fill").font(.system(size: 10))
                    Text("Build Mode").font(.system(size: 12, weight: .medium))
                }
                .foregroundColor(FridayColor.text)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(FridayColor.chip).clipShape(Capsule())
                rows
                HStack(spacing: 8) {
                    BuildOrb(size: 13)
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
        case "write", "read": return "pencil"
        case "start": return "play.fill"
        default: return "terminal"
        }
    }

    var body: some View {
        if step.kind == "note" {
            // Narration between actions — a plain thought line, not a command.
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "lightbulb").font(.system(size: 12)).foregroundColor(FridayColor.muted).frame(width: 14).padding(.top, 3)
                Text(step.label).font(.system(size: 13.5)).foregroundColor(FridayColor.text)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 5)
        } else {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if step.detail != nil { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } }
            } label: {
                HStack(spacing: 8) {
                    if step.state == "running" {
                        BuildOrb(size: 14).frame(width: 14, height: 14)
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
}

private struct WriteGroup: View {
    let steps: [BuildStep]
    @State private var open = false

    var body: some View {
        let running = steps.contains { $0.state == "running" }
        let failed = steps.contains { $0.state == "error" }
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    if running { BuildOrb(size: 14).frame(width: 14, height: 14) }
                    else if failed { Image(systemName: "exclamationmark.circle.fill").font(.system(size: 13)).foregroundColor(FridayColor.error).frame(width: 14) }
                    else { Image(systemName: "pencil").font(.system(size: 12)).foregroundColor(FridayColor.muted).frame(width: 14) }
                    Text("\(running ? "Editing" : "Edited") \(steps.count) file\(steps.count == 1 ? "" : "s")").foregroundColor(FridayColor.text)
                    Text(steps.map { $0.label.replacingOccurrences(of: "Wrote ", with: "") }.joined(separator: ", "))
                        .foregroundColor(FridayColor.muted).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(.system(size: 13.5))
                .padding(.vertical, 5)
            }
            .buttonStyle(.plain)
            if open {
                Text(steps.map { $0.label.replacingOccurrences(of: "Wrote ", with: "") }.joined(separator: "\n"))
                    .font(.system(size: 11, design: .monospaced)).foregroundColor(FridayColor.muted)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(FridayColor.chip).cornerRadius(8)
                    .padding(.leading, 22).padding(.bottom, 6)
            }
        }
    }
}
