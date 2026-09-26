import SwiftUI
import WebKit

/// Renders a ```mermaid fence as a diagram via mermaid.js in a WKWebView.
/// Falls back to the plain CodeBlock while streaming, while loading, and on
/// any render failure/timeout (offline, syntax error) so no error ever flashes.
struct MermaidBlock: View {
    let source: String
    let complete: Bool

    @Environment(\.colorScheme) private var scheme
    @State private var debounced: String = ""
    @State private var phase: MermaidCache.Phase = .loading
    @State private var height: CGFloat = 200
    @State private var copied = false

    var body: some View {
        Group {
            if !complete || phase == .failed || debounced.isEmpty {
                CodeBlock(language: "mermaid", code: source)
            } else {
                ZStack(alignment: .top) {
                    if phase != .ready {
                        CodeBlock(language: "mermaid", code: source)
                    }
                    card
                        .opacity(phase == .ready ? 1 : 0)
                        .frame(height: phase == .ready ? nil : 0)
                        .clipped()
                }
            }
        }
        .task(id: source + (complete ? "1" : "0")) {
            guard complete else { return }
            if debounced == source { return }
            try? await Task.sleep(nanoseconds: 350_000_000)
            if Task.isCancelled { return }
            let key = MermaidCache.key(source, dark: scheme == .dark)
            if let hit = MermaidCache.results[key] {
                height = hit.height; phase = hit.ok ? .ready : .failed
            } else {
                phase = .loading
            }
            debounced = source
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("diagram")
                    .font(.system(size: 12))
                    .foregroundColor(FridayColor.codeComment)
                Spacer()
                Button {
                    UIPasteboard.general.string = source
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
                } label: {
                    Text(copied ? "Copied" : "Copy")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(FridayColor.codeTag)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 6)

            MermaidWebView(source: debounced, dark: scheme == .dark) { result in
                switch result {
                case .height(let h):
                    height = max(h, 40); phase = .ready
                    MermaidCache.results[MermaidCache.key(debounced, dark: scheme == .dark)] = (true, height)
                case .failed:
                    phase = .failed
                    MermaidCache.results[MermaidCache.key(debounced, dark: scheme == .dark)] = (false, 0)
                }
            }
            .frame(height: height)
            .padding(.horizontal, 8)
            .padding(.bottom, 10)
        }
        .background(FridayColor.codeBg)
        .cornerRadius(FridayRadius.code)
    }
}

enum MermaidCache {
    enum Phase { case loading, ready, failed }
    static var results: [String: (ok: Bool, height: CGFloat)] = [:]
    static func key(_ s: String, dark: Bool) -> String { (dark ? "d:" : "l:") + s }
}

enum MermaidResult { case height(CGFloat), failed }

struct MermaidWebView: UIViewRepresentable {
    let source: String
    let dark: Bool
    let onResult: (MermaidResult) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(WeakHandler(context.coordinator), name: "mermaid")
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        context.coordinator.web = web
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let c = context.coordinator
        c.onResult = onResult
        let key = MermaidCache.key(source, dark: dark)
        guard c.loadedKey != key else { return }
        c.loadedKey = key
        c.timeout?.cancel()
        let work = DispatchWorkItem { [weak c] in
            guard c?.done == false else { return }
            c?.done = true
            c?.onResult(.failed)
        }
        c.done = false
        c.timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
        web.loadHTMLString(Self.html(source: source, dark: dark), baseURL: URL(string: "https://cdn.jsdelivr.net/"))
    }

    static func html(source: String, dark: Bool) -> String {
        let json = (try? JSONSerialization.data(withJSONObject: [source], options: []))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        let fg = dark ? "#e6e6e6" : "#1a1a1a"
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body{margin:0;padding:0;background:transparent;color:\(fg)}
        #out{display:flex;justify-content:center;overflow-x:auto}
        #out svg{max-width:100%;height:auto}</style></head>
        <body><div id="out"></div>
        <script type="module">
        import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
        const post = (o) => window.webkit.messageHandlers.mermaid.postMessage(o);
        try {
          mermaid.initialize({ startOnLoad: false, theme: '\(dark ? "dark" : "neutral")', securityLevel: 'strict' });
          const src = \(json)[0];
          const { svg } = await mermaid.render('g' + Date.now(), src);
          if (/Syntax error/i.test(svg) && /error/i.test(svg.slice(0, 400))) throw new Error('syntax');
          document.getElementById('out').innerHTML = svg;
          const h = Math.ceil(document.getElementById('out').getBoundingClientRect().height);
          post({ h });
        } catch (e) { post({ error: String(e) }); }
        </script></body></html>
        """
    }

    final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: Coordinator?
        init(_ t: Coordinator) { target = t }
        func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
            target?.handle(m.body)
        }
    }

    final class Coordinator {
        weak var web: WKWebView?
        var onResult: (MermaidResult) -> Void = { _ in }
        var loadedKey: String?
        var timeout: DispatchWorkItem?
        var done = false

        func handle(_ body: Any) {
            guard !done, let d = body as? [String: Any] else { return }
            done = true
            timeout?.cancel()
            if let h = d["h"] as? Double { onResult(.height(CGFloat(h))) } else { onResult(.failed) }
        }
    }
}
