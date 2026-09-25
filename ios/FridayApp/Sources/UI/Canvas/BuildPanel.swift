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
                ForEach([("preview", "globe"), ("files", "square.stack.3d.up")], id: \.0) { id, icon in
                    Button { tab = id } label: {
                        Image(systemName: icon).font(.system(size: 17))
                            .foregroundColor(tab == id ? FridayColor.text : FridayColor.muted)
                            .frame(width: 36, height: 34)
                            .background(tab == id ? FridayColor.surface : Color.clear)
                            .cornerRadius(10)
                    }
                }
                Spacer()
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

            if tab == "preview" {
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
