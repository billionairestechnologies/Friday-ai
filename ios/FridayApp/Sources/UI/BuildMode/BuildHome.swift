import SwiftUI

/// Colour + label for a Build session status (running | needs_input | done | error | idle).
func buildStatusMeta(_ status: String?) -> (color: Color, label: String)? {
    switch status {
    case "needs_input": return (Color(red: 0.85, green: 0.47, blue: 0.02), "Needs input")
    case "running": return (FridayColor.search, "Running")
    case "done": return (FridayColor.muted, "Done")
    case "error": return (FridayColor.error, "Error")
    case "idle": return (FridayColor.hairline, "Stopped")
    default: return nil
    }
}

/// Starting points on the Build home — each starts the question/plan round (nothing is built until
/// the plan is approved).
let buildTemplates: [(label: String, hint: String, prompt: String)] = [
    ("Next.js app", "App Router · TypeScript · Tailwind", "Start a new Next.js app (App Router, TypeScript, Tailwind CSS)."),
    ("React + Vite", "TypeScript · Tailwind", "Start a new React + Vite app (TypeScript, Tailwind CSS)."),
    ("Python API", "FastAPI · pytest", "Start a new Python API with FastAPI (uvicorn, pydantic models, pytest tests)."),
    ("Landing page", "Hero · pricing · waitlist", "Build a modern, responsive landing page with a hero, features, pricing, FAQ and a waitlist form."),
]

func buildRelativeTime(_ date: Date?) -> String {
    guard let date else { return "" }
    let m = Int(Date().timeIntervalSince(date) / 60)
    if m < 1 { return "just now" }
    if m < 60 { return "\(m)m ago" }
    if m < 60 * 24 { return "\(m / 60)h ago" }
    if m < 60 * 24 * 7 { return "\(m / 60 / 24)d ago" }
    return "\(m / 60 / 24 / 7)w ago"
}

/// Build workspace home (Claude Code layout): welcome, Sessions with live status, Pull requests.
struct BuildHomeView: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var showAll = false

    private var ordered: [BuildSessionSummary] {
        vm.buildSessions.sorted {
            let rank: (BuildSessionSummary) -> Int = { $0.status == "needs_input" ? 0 : $0.status == "running" ? 1 : 2 }
            if rank($0) != rank($1) { return rank($0) < rank($1) }
            return ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "hammer.fill").font(.system(size: 14)).foregroundColor(FridayColor.text)
                        .frame(width: 34, height: 34).background(FridayColor.surface).cornerRadius(10)
                    Text(firstName.map { "Welcome back, \($0)" } ?? "Welcome to Build")
                        .font(.system(size: 22, weight: .semibold)).foregroundColor(FridayColor.text)
                }

                Text("Start from a template").font(.system(size: 14, weight: .medium)).foregroundColor(FridayColor.text)
                    .padding(.top, 24).padding(.bottom, 8)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                    ForEach(buildTemplates, id: \.label) { t in
                        Button { vm.send(text: t.prompt) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(t.label).font(.system(size: 13.5, weight: .medium)).foregroundColor(FridayColor.text)
                                Text(t.hint).font(.system(size: 11.5)).foregroundColor(FridayColor.muted).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .background(FridayColor.surface).cornerRadius(12)
                        }
                    }
                }

                HStack {
                    Text("Sessions").font(.system(size: 14, weight: .medium)).foregroundColor(FridayColor.text)
                    Spacer()
                    if ordered.count > 3 {
                        Button(showAll ? "Show less" : "Show \(ordered.count - 3) more") { showAll.toggle() }
                            .font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    }
                }
                .padding(.top, 28).padding(.bottom, 8)

                if let error = vm.buildSessionsError {
                    Button { Task { await vm.loadBuildSessions() } } label: {
                        Text(error).font(.system(size: 13)).foregroundColor(FridayColor.error)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                            .background(FridayColor.surface).cornerRadius(12)
                    }
                } else if !vm.buildSessionsLoaded {
                    ForEach(0..<3, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: 12).fill(FridayColor.surface).frame(height: 56).padding(.bottom, 8)
                    }
                } else if ordered.isEmpty {
                    Text("No builds yet. Describe an app below — Friday plans it with you, then builds, runs and previews it.")
                        .font(.system(size: 13)).foregroundColor(FridayColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        .background(FridayColor.surface).cornerRadius(12)
                } else {
                    ForEach(showAll ? ordered : Array(ordered.prefix(3))) { s in
                        Button { vm.selectChat(s.id) } label: { sessionRow(s) }
                            .padding(.bottom, 8)
                    }
                }

                let prs = vm.buildSessions.filter { $0.prUrl != nil }
                if !prs.isEmpty {
                    Text("Pull requests").font(.system(size: 14, weight: .medium)).foregroundColor(FridayColor.text)
                        .padding(.top, 20).padding(.bottom, 8)
                    ForEach(prs) { s in
                        Button {
                            if let u = s.prUrl.flatMap(URL.init(string:)) { UIApplication.shared.open(u) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(s.title).font(.system(size: 14, weight: .medium)).foregroundColor(FridayColor.text).lineLimit(1)
                                    Text([s.repo, buildRelativeTime(s.updatedAt)].compactMap { $0 }.joined(separator: " · "))
                                        .font(.system(size: 12)).foregroundColor(FridayColor.muted)
                                }
                                Spacer()
                                Image(systemName: "arrow.up.right").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                            }
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(FridayColor.surface).cornerRadius(12)
                        }
                        .padding(.bottom, 8)
                    }
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 24)
        }
        .task { await vm.loadBuildSessions() }
        .refreshable { await vm.loadBuildSessions() }
    }

    private var firstName: String? {
        vm.user?.name.split(separator: " ").first.map(String.init)
    }

    private func sessionRow(_ s: BuildSessionSummary) -> some View {
        let meta = buildStatusMeta(s.status)
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let meta {
                        Circle().fill(meta.color).frame(width: 6, height: 6)
                        Text(meta.label).font(.system(size: 12, weight: .medium))
                            .foregroundColor(s.status == "needs_input" || s.status == "error" ? meta.color : FridayColor.muted)
                    }
                    Text(buildRelativeTime(s.updatedAt)).font(.system(size: 12)).foregroundColor(FridayColor.muted)
                }
                Text(s.title).font(.system(size: 14.5, weight: .medium)).foregroundColor(FridayColor.text).lineLimit(1)
                Text(s.activity).font(.system(size: 12.5)).foregroundColor(FridayColor.muted).lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(FridayColor.muted)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(FridayColor.surface).cornerRadius(12)
    }
}

/// Above the Build composer: what the agent may do without asking.
struct BuildPermissionChip: View {
    @EnvironmentObject var vm: FridayViewModel
    private let options: [(id: String, label: String)] = [
        ("full_auto", "Full auto · runs everything in the sandbox"), ("auto_edit", "Auto-edit · asks before commands"), ("ask", "Ask every time"),
    ]

    var body: some View {
        Menu {
            ForEach(options, id: \.id) { o in
                Button { vm.buildPermissionMode = o.id } label: {
                    if o.id == vm.buildPermissionMode { Label(o.label, systemImage: "checkmark") } else { Text(o.label) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "shield").font(.system(size: 12))
                Text(vm.buildPermissionMode == "ask" ? "Ask every time" : vm.buildPermissionMode == "auto_edit" ? "Auto-edit" : "Full auto").font(.system(size: 12.5))
                Image(systemName: "chevron.down").font(.system(size: 9))
            }
            .foregroundColor(FridayColor.text)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(FridayColor.surface).cornerRadius(10)
        }
    }
}

/// Above the Build composer: how hard the agent works (the model picker is in the composer).
struct BuildEffortChip: View {
    @EnvironmentObject var vm: FridayViewModel
    private let options: [(id: String, label: String)] = [
        ("low", "Low · quick, fewer checks"), ("medium", "Medium · balanced"), ("high", "High · extra verification"),
    ]

    var body: some View {
        Menu {
            ForEach(options, id: \.id) { o in
                Button { vm.buildEffort = o.id } label: {
                    if o.id == vm.buildEffort { Label(o.label, systemImage: "checkmark") } else { Text(o.label) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "gauge.with.dots.needle.33percent").font(.system(size: 12))
                Text("\(vm.buildEffort.capitalized) effort").font(.system(size: 12.5))
                Image(systemName: "chevron.down").font(.system(size: 9))
            }
            .foregroundColor(FridayColor.text)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(FridayColor.surface).cornerRadius(10)
        }
    }
}
