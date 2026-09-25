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

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Live project").font(.system(size: 15, weight: .semibold)).foregroundColor(FridayColor.canvas)
                Spacer()
                Button { if url != nil { reloadTick += 1 } else { Task { await ensure() } } } label: { Image(systemName: "arrow.clockwise") }
                if let url, let u = URL(string: url) {
                    Button { UIApplication.shared.open(u) } label: { Image(systemName: "safari") }
                }
                Button { Task { await download() } } label: { Image(systemName: "square.and.arrow.up") }
                Button { withAnimation(.spring(response: 0.26, dampingFraction: 0.88)) { vm.canvasOpen = false } } label: { Image(systemName: "xmark") }
            }
            .foregroundColor(FridayColor.text)
            .padding(.horizontal, 16).padding(.vertical, 12)

            Picker("", selection: $tab) {
                Text("Preview").tag("preview")
                Text("Files").tag("files")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 12).padding(.bottom, 8)

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
                    BuildWebView(url: url, reloadTick: reloadTick)
                }
            } else if let files {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(files.keys.sorted(), id: \.self) { path in
                            Button { selected = path } label: {
                                Text(path).font(.system(size: 12)).lineLimit(1)
                                    .foregroundColor(path == selected ? FridayColor.text : FridayColor.muted)
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(path == selected ? FridayColor.surface : Color.clear)
                                    .cornerRadius(8)
                            }
                        }
                    }.padding(.horizontal, 12)
                }
                ScrollView([.horizontal, .vertical]) {
                    Text(selected.flatMap { files[$0] } ?? "")
                        .font(.system(size: 12, design: .monospaced)).foregroundColor(FridayColor.text).padding(14)
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
            selected = files?.keys.sorted().first
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
