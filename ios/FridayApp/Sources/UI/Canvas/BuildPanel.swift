import SwiftUI
import WebKit

/// Canvas view for a Build Mode project — mirrors the web/Android BuildPanel: the running app (a
/// WKWebView on the sandbox's public URL) plus its file tree. Sandboxes are short-lived, so unless
/// the URL just came from the live turn the backend is asked to make sure it's alive first (it
/// restores the snapshot and restarts the server if it expired).
struct BuildPanel: View {
    @EnvironmentObject var vm: FridayViewModel
    let conversationId: String
    let liveUrl: String?

    @State private var url: String?
    @State private var loading = true
    @State private var error: String?
    @State private var tab = "preview"
    @State private var reloadTick = 0
    @State private var files: [String: String]?
    @State private var selected: String?
    @State private var shareItem: URL?

    @State private var showTree = true
    @State private var mobile = false
    @State private var openDirs: Set<String> = []

    private struct TreeRowItem: Identifiable { let path: String; let isDir: Bool; let depth: Int; var id: String { path } }

    private func treeRows(_ paths: [String]) -> [TreeRowItem] {
        var out: [TreeRowItem] = []
        func walk(_ prefix: String, _ depth: Int) {
            let direct = paths.filter { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)).components(separatedBy: "/") }
            let dirs = Array(Set(direct.filter { $0.count > 1 }.map { $0[0] })).sorted()
            let fileNames = direct.filter { $0.count == 1 }.map { $0[0] }.sorted()
            for d in dirs {
                let p = prefix + d + "/"
                out.append(TreeRowItem(path: p, isDir: true, depth: depth))
                if openDirs.contains(p) || (depth == 0 && openDirs.isEmpty) { walk(p, depth + 1) }
            }
            for f in fileNames { out.append(TreeRowItem(path: prefix + f, isDir: false, depth: depth)) }
        }
        walk("", 0)
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            // Icon tabs: globe = running preview, stack = project files.
            HStack(spacing: 4) {
                ForEach([("preview", "globe"), ("files", "square.stack.3d.up"), ("diff", "plusminus"), ("terminal", "terminal"), ("secrets", "key")], id: \.0) { id, icon in
                    Button { tab = id } label: {
                        Image(systemName: icon).font(.system(size: 17))
                            .foregroundColor(tab == id ? FridayColor.text : FridayColor.muted)
                            .frame(width: 36, height: 34)
                            .background(tab == id ? FridayColor.surface : Color.clear)
                            .cornerRadius(10)
                    }
                }
                Spacer()
                DeployButton(conversationId: conversationId)
                Button { withAnimation(.spring(response: 0.26, dampingFraction: 0.88)) { vm.canvasOpen = false } } label: {
                    Image(systemName: "xmark").foregroundColor(FridayColor.text).padding(8)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)

            HStack(spacing: 10) {
                if tab == "preview" {
                    Button { if url != nil { reloadTick += 1 } else { Task { await ensure() } } } label: { Image(systemName: "arrow.clockwise") }
                    Text((url ?? "").replacingOccurrences(of: "https://", with: "")).font(.system(size: 12)).foregroundColor(FridayColor.muted).lineLimit(1)
                    Spacer()
                    if let url, let u = URL(string: url) { Button { UIApplication.shared.open(u) } label: { Image(systemName: "safari") } }
                    Button { mobile.toggle() } label: { Image(systemName: "iphone").foregroundColor(mobile ? FridayColor.text : FridayColor.muted) }
                } else if tab == "secrets" {
                    Text("Project secrets").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    Spacer()
                } else if tab == "diff" {
                    Text("Changes in this build").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    Spacer()
                } else if tab == "terminal" {
                    Text("Commands this build ran").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    Spacer()
                } else {
                    Button { showTree.toggle() } label: { Image(systemName: "list.bullet.indent").foregroundColor(showTree ? FridayColor.text : FridayColor.muted) }
                    Text(selected ?? "").font(.system(size: 13)).foregroundColor(FridayColor.text).lineLimit(1)
                    Spacer()
                    Button { Task { await download() } } label: { Image(systemName: "square.and.arrow.up") }
                }
            }
            .foregroundColor(FridayColor.text)
            .padding(.horizontal, 16).padding(.vertical, 6)
            Divider().background(FridayColor.hairline)

            if tab == "secrets" {
                SecretsTab(conversationId: conversationId)
            } else if tab == "diff" {
                BuildDiffList(steps: vm.currentChat?.messages.flatMap { $0.build?.steps ?? [] } ?? [])
            } else if tab == "terminal" {
                BuildTerminal(steps: vm.currentChat?.messages.flatMap { $0.build?.steps ?? [] } ?? [], building: vm.currentChat?.messages.last?.isStreaming ?? false)
            } else if tab == "preview" {
                if loading {
                    VStack(spacing: 12) {
                        Spacer()
                        ProgressView()
                        Text("Starting your project… restoring files and dependencies can take a minute.")
                            .font(.system(size: 14)).foregroundColor(FridayColor.muted).multilineTextAlignment(.center).padding(.horizontal, 32)
                        Spacer()
                    }
                } else if let error {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(error).font(.system(size: 12, design: .monospaced)).foregroundColor(FridayColor.error)
                        Button("Try again") { Task { await ensure() } }
                        Spacer()
                    }.padding(20)
                } else if let url {
                    ZStack {
                        if mobile { FridayColor.surface }
                        BuildWebView(url: url, reloadTick: reloadTick)
                            .frame(maxWidth: mobile ? 390 : .infinity)
                    }
                }
            } else if let files {
                HStack(spacing: 0) {
                    if showTree {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) {
                                Text("Files").font(.system(size: 12)).foregroundColor(FridayColor.muted).padding(.leading, 6).padding(.bottom, 4)
                                ForEach(treeRows(Array(files.keys))) { row in
                                    let name = row.path.split(separator: "/").last.map(String.init) ?? row.path
                                    let open = row.isDir && (openDirs.contains(row.path) || (row.depth == 0 && openDirs.isEmpty))
                                    Button {
                                        if row.isDir {
                                            if openDirs.isEmpty, row.depth == 0 { openDirs = [row.path] }
                                            if open { openDirs.remove(row.path) } else { openDirs.insert(row.path) }
                                        } else { selected = row.path }
                                    } label: {
                                        HStack(spacing: 6) {
                                            Image(systemName: row.isDir ? (open ? "folder.fill" : "folder") : "doc.text").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                                            Text(name).font(.system(size: 12.5)).lineLimit(1)
                                                .foregroundColor(!row.isDir && row.path == selected ? FridayColor.text : FridayColor.muted)
                                            Spacer(minLength: 0)
                                        }
                                        .padding(.leading, CGFloat(6 + row.depth * 12)).padding(.vertical, 6).padding(.trailing, 4)
                                        .background(!row.isDir && row.path == selected ? FridayColor.surface : Color.clear)
                                        .cornerRadius(8)
                                    }
                                }
                            }
                            .padding(8)
                        }
                        .frame(width: 150)
                        Divider().background(FridayColor.hairline)
                    }
                    ScrollView([.horizontal, .vertical]) {
                        let lines = (selected.flatMap { files[$0] } ?? "").components(separatedBy: "\n")
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                                HStack(alignment: .top, spacing: 8) {
                                    Text("\(i + 1)").font(.system(size: 11, design: .monospaced)).foregroundColor(FridayColor.muted).frame(width: 30, alignment: .trailing)
                                    Text(line.isEmpty ? " " : line).font(.system(size: 12, design: .monospaced)).foregroundColor(FridayColor.text)
                                }
                            }
                        }
                        .padding(.vertical, 8)
                    }
                }
            } else {
                VStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .background(FridayColor.bg.ignoresSafeArea())
        .task(id: liveUrl ?? conversationId) {
            if let liveUrl {
                url = liveUrl
                loading = false
            } else if url == nil {
                await ensure()
            }
        }
        .task(id: tab) {
            guard tab == "files", files == nil else { return }
            files = await BuildApi.files(conversationId: conversationId) ?? [:]
            selected = files?.keys.first(where: { $0.range(of: #"(^|/)(App|main|index)\.(jsx|tsx|js|ts|html|py)$"#, options: .regularExpression) != nil }) ?? files?.keys.sorted().first
        }
        .sheet(item: Binding(get: { shareItem.map { ShareURL(url: $0) } }, set: { if $0 == nil { shareItem = nil } })) { item in
            ActivityView(items: [item.url])
        }
    }

    private func ensure() async {
        loading = true
        error = nil
        switch await BuildApi.ensurePreview(conversationId: conversationId) {
        case .ready(let u): url = u
        case .failed(let message): error = message
        }
        loading = false
    }

    private func download() async {
        if let zip = await BuildApi.downloadZip(conversationId: conversationId) {
            shareItem = zip
        } else {
            error = "Couldn't download the project — check your connection."
            tab = "preview"
        }
    }
}

private struct ShareURL: Identifiable { let url: URL; var id: String { url.absoluteString } }

private struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

private struct BuildWebView: UIViewRepresentable {
    let url: String
    let reloadTick: Int

    func makeUIView(context: Context) -> WKWebView { WKWebView(frame: .zero, configuration: WKWebViewConfiguration()) }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let tag = "\(url)#\(reloadTick)"
        if webView.accessibilityIdentifier != tag, let u = URL(string: url) {
            webView.accessibilityIdentifier = tag
            webView.load(URLRequest(url: u))
        }
    }
}

/// Every file the agent wrote or edited, newest first, with +/- counts and the changed lines —
/// built from the steps already streamed (same as the web's Diff tab).
struct BuildDiffList: View {
    let steps: [BuildStep]
    @State private var open: [String: Bool] = [:]

    private struct Change: Identifiable {
        let path: String
        let code: String
        let added: Int
        let removed: Int
        let isNew: Bool
        var id: String { path }
    }

    private var changes: [Change] {
        var order: [String] = []
        var byPath: [String: Change] = [:]
        for st in steps where st.kind == "write" && st.state == "ok" {
            guard let path = st.path else { continue }
            let prev = byPath[path]
            order.removeAll { $0 == path }
            order.append(path)
            byPath[path] = Change(
                path: path, code: st.code ?? "",
                added: (prev?.added ?? 0) + (st.added ?? 0),
                removed: (prev?.removed ?? 0) + (st.removed ?? 0),
                isNew: prev?.isNew ?? st.label.hasPrefix("Wrote ")
            )
        }
        return order.reversed().compactMap { byPath[$0] }
    }

    var body: some View {
        let list = changes
        if list.isEmpty {
            VStack {
                Spacer()
                Text("No changes yet — files Friday writes or edits show up here.")
                    .font(.system(size: 13)).foregroundColor(FridayColor.muted).multilineTextAlignment(.center).padding(.horizontal, 32)
                Spacer()
            }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("\(list.count) file\(list.count == 1 ? "" : "s") changed  +\(list.reduce(0) { $0 + $1.added })  −\(list.reduce(0) { $0 + $1.removed })")
                        .font(.system(size: 12)).foregroundColor(FridayColor.muted).padding(.horizontal, 16).padding(.vertical, 8)
                    ForEach(list) { c in
                        let expanded = open[c.path] ?? (list.count <= 3)
                        Button { open[c.path] = !expanded } label: {
                            HStack(spacing: 6) {
                                Text(c.path).font(.system(size: 12, design: .monospaced)).foregroundColor(FridayColor.text).lineLimit(1)
                                Spacer()
                                if c.isNew { Text("new").font(.system(size: 11)).foregroundColor(FridayColor.muted) }
                                Text("+\(c.added)").font(.system(size: 11, design: .monospaced)).foregroundColor(.green)
                                Text("−\(c.removed)").font(.system(size: 11, design: .monospaced)).foregroundColor(FridayColor.error)
                            }
                            .padding(.horizontal, 16).padding(.vertical, 8)
                        }
                        if expanded && !c.code.isEmpty {
                            ScrollView(.horizontal) {
                                VStack(alignment: .leading, spacing: 0) {
                                    ForEach(Array(c.code.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                                        let kind: Character = c.isNew ? "+" : line.hasPrefix("+ ") ? "+" : line.hasPrefix("- ") ? "-" : " "
                                        let text = !c.isNew && kind != " " ? String(line.dropFirst(2)) : line
                                        Text("\(String(kind)) \(text)")
                                            .font(.system(size: 11.5, design: .monospaced))
                                            .foregroundColor(kind == "+" ? .green : kind == "-" ? FridayColor.error : FridayColor.text)
                                            .fixedSize()
                                    }
                                }
                                .padding(.horizontal, 16).padding(.vertical, 6)
                            }
                            .background(FridayColor.surface)
                        }
                        Divider().background(FridayColor.hairline)
                    }
                }
            }
        }
    }
}

/// One-click deploy to Vercel (connected account). Opens the live URL, or shows what went wrong.
private struct DeployButton: View {
    let conversationId: String
    @State private var busy = false
    @State private var message: String?

    var body: some View {
        Button {
            busy = true
            Task {
                do {
                    let url = try await BuildApi.deploy(conversationId: conversationId)
                    if let u = URL(string: url) { await UIApplication.shared.open(u) }
                    message = "Live on Vercel: \(url)"
                } catch {
                    message = error.localizedDescription
                }
                busy = false
            }
        } label: {
            HStack(spacing: 4) {
                if busy { ProgressView().scaleEffect(0.7) } else { Image(systemName: "paperplane.fill").font(.system(size: 11)) }
                Text(busy ? "Deploying…" : "Deploy").font(.system(size: 12.5, weight: .medium))
            }
            .foregroundColor(busy ? FridayColor.text : FridayColor.bg)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(busy ? FridayColor.surface : FridayColor.text).cornerRadius(10)
        }
        .disabled(busy)
        .alert("Deploy", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
    }
}

/// Project secrets (names only — values are write-only): env vars for the app, set on Vercel on deploy,
/// never shown to the AI or printed in output.
private struct SecretsTab: View {
    let conversationId: String
    @State private var names: [String]?
    @State private var name = ""
    @State private var value = ""
    @State private var error: String?
    @State private var busy = false

    private var validName: Bool { name.range(of: "^[A-Z][A-Z0-9_]{0,63}$", options: .regularExpression) != nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("API keys and other private values for this project. The app reads them as environment variables; they're also set on Vercel when you deploy, and never shown to the AI.")
                    .font(.system(size: 12.5)).foregroundColor(FridayColor.muted)
                TextField("NAME (e.g. OPENAI_API_KEY)", text: $name)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .font(.system(size: 13, design: .monospaced))
                    .padding(10).background(FridayColor.surface).cornerRadius(10)
                    .onChange(of: name) { v in
                        let cleaned = String(v.uppercased().map { $0.isLetter || $0.isNumber || $0 == "_" ? $0 : "_" })
                        if cleaned != v { name = cleaned }
                    }
                SecureField("Value", text: $value)
                    .padding(10).background(FridayColor.surface).cornerRadius(10)
                Button {
                    busy = true
                    Task {
                        do {
                            try await BuildApi.setSecret(conversationId: conversationId, name: name, value: value)
                            name = ""
                            value = ""
                            error = nil
                            await reload()
                        } catch {
                            self.error = error.localizedDescription
                        }
                        busy = false
                    }
                } label: {
                    Text(busy ? "Saving…" : "Save secret").font(.system(size: 13.5, weight: .semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .foregroundColor(FridayColor.bg).background(FridayColor.text).cornerRadius(10)
                }
                .disabled(busy || !validName || value.isEmpty)
                .opacity(busy || !validName || value.isEmpty ? 0.4 : 1)
                if let error { Text(error).font(.system(size: 12)).foregroundColor(FridayColor.error) }
                if let names {
                    if names.isEmpty {
                        Text("No secrets yet.").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                    }
                    ForEach(names, id: \.self) { n in
                        HStack {
                            Text(n).font(.system(size: 12.5, design: .monospaced)).foregroundColor(FridayColor.text)
                            Spacer()
                            Text("••••••").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                            Button {
                                Task {
                                    do { try await BuildApi.deleteSecret(conversationId: conversationId, name: n) } catch { self.error = error.localizedDescription }
                                    await reload()
                                }
                            } label: { Image(systemName: "trash").font(.system(size: 12)).foregroundColor(FridayColor.muted) }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(FridayColor.surface).cornerRadius(8)
                    }
                } else {
                    Text("Loading…").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                }
            }
            .padding(16)
        }
        .task { await reload() }
    }

    private func reload() async {
        do { names = try await BuildApi.secrets(conversationId: conversationId) } catch { self.error = "Couldn't load secrets: \(error.localizedDescription)" }
    }
}
