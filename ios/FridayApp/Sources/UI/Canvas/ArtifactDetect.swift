import Foundation

enum ArtifactKind {
    case html, react, runnable(language: String), code
}

struct DetectedArtifact {
    let kind: ArtifactKind
    let language: String
    let code: String
    let complete: Bool
    /// Separate ```css fence(s) from the same reply (App.jsx + App.css), applied to the preview.
    var css: String? = nil
}

/// No dedicated backend artifact/SSE event exists — Canvas content is derived purely by scanning
/// the accumulated text for fenced code blocks. Mirrors android ArtifactDetect.kt and the web
/// app's extractArtifact(): html page, then React, then runnable code, then any other code shown
/// as static text (`.code`).
enum ArtifactDetect {
    static let runnableLanguages: Set<String> = ["python", "py", "javascript", "js", "typescript", "ts", "java", "r", "bash", "sh", "shell"]
    private static let jsLanguages: Set<String> = ["javascript", "js", "typescript", "ts"]

    private struct Fence { let lang: String; let body: String; let complete: Bool }

    private static func fences(in text: String) -> [Fence] {
        var out: [Fence] = []
        var cursor = text.startIndex
        while let open = text.range(of: "```", range: cursor..<text.endIndex) {
            guard let lineEnd = text.range(of: "\n", range: open.upperBound..<text.endIndex) else { break }
            let header = text[open.upperBound..<lineEnd.lowerBound].trimmingCharacters(in: .whitespaces).lowercased()
            let lang = header.split(separator: " ").first.map(String.init) ?? ""
            let bodyStart = lineEnd.upperBound
            if let close = text.range(of: "```", range: bodyStart..<text.endIndex) {
                out.append(Fence(lang: lang, body: String(text[bodyStart..<close.lowerBound]), complete: true))
                cursor = close.upperBound
            } else {
                out.append(Fence(lang: lang, body: String(text[bodyStart...]), complete: false))
                break
            }
        }
        return out
    }

    /// Models sometimes fence a React component as ```javascript — treat clear JSX / hook usage as React.
    private static func looksLikeReact(_ body: String) -> Bool {
        let patterns = [#"<([A-Za-z][\w.]*)[^>]*>[\s\S]*</\1>"#, #"<[A-Za-z][\w.]*[^>]*/>"#, #"\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer)\s*\("#]
        return patterns.contains { body.range(of: $0, options: .regularExpression) != nil }
    }

    static func detect(in text: String) -> DetectedArtifact? {
        let blocks = fences(in: text).filter { !$0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !blocks.isEmpty else { return nil }
        let cssJoined = blocks.filter { $0.lang == "css" }.map { $0.body.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: "\n\n")
        let css: String? = cssJoined.isEmpty ? nil : cssJoined

        if let b = blocks.first(where: { $0.lang == "html" }) {
            return DetectedArtifact(kind: .html, language: "html", code: b.body, complete: b.complete, css: css)
        }
        if let b = blocks.first(where: { ["jsx", "tsx", "react"].contains($0.lang) || (jsLanguages.contains($0.lang) && looksLikeReact($0.body)) }) {
            return DetectedArtifact(kind: .react, language: b.lang, code: b.body, complete: b.complete, css: css)
        }
        if let b = blocks.first(where: { runnableLanguages.contains($0.lang) }) {
            return DetectedArtifact(kind: .runnable(language: b.lang), language: b.lang, code: b.body, complete: b.complete)
        }
        // Everything else (css, go, sql, php, json, unlabeled…) has nothing to execute — show it as code.
        let first = blocks.first(where: { $0.lang == "css" }) ?? blocks[0]
        if first.lang != "css" && text.count <= 120 { return nil }
        return DetectedArtifact(kind: .code, language: first.lang.isEmpty ? "text" : first.lang, code: first.body, complete: first.complete)
    }

    private static func jsonLiteral(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
              var arr = String(data: data, encoding: .utf8) else { return "\"\"" }
        arr.removeFirst(); arr.removeLast()
        return arr.replacingOccurrences(of: "<", with: "\\u003c")
    }

    /// Full standalone preview document for a JSX/TSX component: the raw source is injected as JSON
    /// and the WebView's own JS converts imports/exports and mounts it (see ReactPreviewShell.swift).
    static func reactShellHTML(code: String, css: String?) -> String {
        ReactPreviewShell.template
            .replacingOccurrences(of: "__CSS_JSON__", with: jsonLiteral(css ?? ""))
            .replacingOccurrences(of: "__SOURCE_JSON__", with: jsonLiteral(code))
    }

    /// Adds a separate stylesheet fence to a full HTML page for the preview.
    static func htmlWithCss(_ html: String, css: String?) -> String {
        guard let css, !css.isEmpty else { return html }
        let tag = "<style>\(css)</style>"
        if let r = html.range(of: "</head>", options: .caseInsensitive) {
            return html.replacingCharacters(in: r, with: tag + "</head>")
        }
        return tag + html
    }

    /// The document the Preview tab / "open in browser" / download actually use.
    static func renderableHTML(_ artifact: DetectedArtifact) -> String {
        if case .react = artifact.kind { return reactShellHTML(code: artifact.code, css: artifact.css) }
        return htmlWithCss(artifact.code, css: artifact.css)
    }
}
