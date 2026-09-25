import SwiftUI
import WebKit

struct CanvasPanel: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var tab = "preview"
    @State private var runResult: SandboxApi.RunResult?
    @State private var running = false

    private var latestArtifact: DetectedArtifact? {
        guard let last = vm.currentChat?.messages.last(where: { $0.role == .assistant }) else { return nil }
        return ArtifactDetect.detect(in: last.content)
    }

    /// Build Mode: a running project newer than any single-file artifact takes over the panel.
    private var buildTarget: (conversationId: String, message: ChatMessage)? {
        guard let chat = vm.currentChat, UUID(uuidString: chat.id) != nil else { return nil }
        let messages = chat.messages
        guard let buildIdx = messages.lastIndex(where: { $0.build?.previewUrl != nil }) else { return nil }
        let artifactIdx = messages.lastIndex(where: { $0.role == .assistant && ArtifactDetect.detect(in: $0.content) != nil }) ?? -1
        return buildIdx > artifactIdx ? (chat.id, messages[buildIdx]) : nil
    }

    var body: some View {
        if let target = buildTarget {
            BuildPanel(
                conversationId: target.conversationId,
                liveUrl: vm.freshBuildMessageIds.contains(target.message.id) ? target.message.build?.previewUrl : nil
            )
        } else {
            artifactBody
        }
    }

    private var artifactBody: some View {
        VStack(spacing: 0) {
            header
            Divider().background(FridayColor.hairline)

            if let artifact = latestArtifact {
                content(for: artifact)
            } else if vm.isStreamingCurrent {
                loadingState
            } else {
                VStack {
                    Spacer()
                    Text("Turn on Canvas and ask Friday to build something…")
                        .font(.system(size: 14))
                        .foregroundColor(FridayColor.muted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    Spacer()
                }
            }
        }
        .background(FridayColor.bg.ignoresSafeArea())
    }

    private var header: some View {
        HStack {
            Text("Canvas").font(.system(size: 15, weight: .semibold)).foregroundColor(FridayColor.canvas)
            Spacer()
            if let artifact = latestArtifact, isWebKind(artifact) {
                Button { openInBrowser(artifact) } label: { Image(systemName: "safari") }
            }
            Button { share() } label: { Image(systemName: "square.and.arrow.up") }
            Button { vm.canvasOpen = false } label: { Image(systemName: "xmark") }
        }
        .foregroundColor(FridayColor.text)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func isWebKind(_ artifact: DetectedArtifact) -> Bool {
        switch artifact.kind {
        case .html, .react: return true
        case .runnable, .code: return false
        }
    }

    @ViewBuilder
    private func content(for artifact: DetectedArtifact) -> some View {
        switch artifact.kind {
        case .html, .react:
            VStack(spacing: 0) {
                Picker("", selection: $tab) {
                    Text("Preview").tag("preview")
                    Text("Code").tag("code")
                }
                .pickerStyle(.segmented)
                .padding(12)

                if tab == "preview" {
                    WebPreview(html: ArtifactDetect.renderableHTML(artifact))
                } else {
                    codeView(artifact.code)
                }
            }
        case .code:
            ScrollView { codeView(artifact.code).padding(16) }
        case .runnable(let language):
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    codeView(artifact.code)
                    runStateView
                }
                .padding(16)
            }
            .onChange(of: artifact.complete) { complete in
                if complete { runNow(language: language, code: artifact.code) }
            }
        }
    }

    private func codeView(_ code: String) -> some View {
        ScrollView([.horizontal, .vertical]) {
            Text(code)
                .font(.system(size: 13, design: .monospaced))
                .foregroundColor(FridayColor.codeFg)
                .padding(12)
        }
        .background(FridayColor.codeBg)
        .cornerRadius(FridayRadius.code)
    }

    @ViewBuilder
    private var runStateView: some View {
        if running {
            HStack(spacing: 8) {
                ProgressView().scaleEffect(0.7)
                Text("Running…").font(.system(size: 13)).foregroundColor(FridayColor.muted)
            }
        } else if let result = runResult {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: result.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundColor(result.ok ? FridayColor.success : FridayColor.error)
                    Text(result.ok
                        ? (result.attempts > 1 ? "Fixed automatically and ran successfully" : "Ran successfully")
                        : "Error")
                        .font(.system(size: 13, weight: .medium))
                }
                Text(result.output)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(FridayColor.muted)
                    .textSelection(.enabled)
                Button("Run again") { runNow(language: "", code: result.code, forceLanguage: currentLanguage) }
                    .font(.system(size: 12, weight: .medium))
            }
        }
    }

    private var currentLanguage: String {
        if case .runnable(let lang)? = latestArtifact?.kind { return lang }
        return "python"
    }

    private func runNow(language: String, code: String, forceLanguage: String? = nil) {
        running = true
        Task {
            let lang = forceLanguage ?? language
            let result = try? await SandboxApi.run(language: lang, code: code)
            await MainActor.run {
                running = false
                runResult = result
            }
        }
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            Spacer()
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 6).fill(FridayColor.surface).frame(height: 14)
            }
            Text("Analyzing the request").font(.system(size: 13)).foregroundColor(FridayColor.muted)
            Spacer()
        }
        .padding(24)
    }

    private func openInBrowser(_ artifact: DetectedArtifact) {
        guard let url = writeTempFile(artifact) else { return }
        UIApplication.shared.open(url)
    }

    private func share() {
        guard let artifact = latestArtifact, let url = writeTempFile(artifact) else { return }
        let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.keyWindow?.rootViewController?.present(av, animated: true)
    }

    private func writeTempFile(_ artifact: DetectedArtifact) -> URL? {
        let ext: String
        switch artifact.kind {
        case .html, .react: ext = "html"
        case .runnable(let lang): ext = lang
        case .code:
            let map = ["css": "css", "json": "json", "sql": "sql", "go": "go", "php": "php", "rust": "rs", "rs": "rs", "kotlin": "kt", "kt": "kt", "swift": "swift", "c": "c", "cpp": "cpp", "yaml": "yml", "yml": "yml"]
            ext = map[artifact.language] ?? "txt"
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("canvas-artifact.\(ext)")
        let content: String
        switch artifact.kind {
        case .html, .react: content = ArtifactDetect.renderableHTML(artifact)
        case .runnable, .code: content = artifact.code
        }
        try? content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}

private struct WebPreview: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptEnabled = true
        return WKWebView(frame: .zero, configuration: config)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(html, baseURL: nil)
    }
}
