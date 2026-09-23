import Foundation

enum ArtifactKind {
    case html, react, runnable(language: String)
}

struct DetectedArtifact {
    let kind: ArtifactKind
    let language: String
    let code: String
    let complete: Bool
}

/// No dedicated backend artifact/SSE event exists — Canvas content is
/// derived purely by scanning the accumulated text for the first fenced
/// code block. Mirrors android ArtifactDetect.kt.
enum ArtifactDetect {
    static let runnableLanguages: Set<String> = ["python", "py", "javascript", "js", "typescript", "ts", "java", "r", "bash", "sh", "shell"]

    static func detect(in text: String) -> DetectedArtifact? {
        guard let openRange = text.range(of: "```") else { return nil }
        let afterOpen = text[openRange.upperBound...]
        let langLine = afterOpen.prefix(while: { $0 != "\n" })
        let lang = langLine.trimmingCharacters(in: .whitespaces).lowercased()
        guard !lang.isEmpty else { return nil }

        let bodyStart = afterOpen.index(afterOpen.startIndex, offsetBy: langLine.count)
        let rest = afterOpen[bodyStart...]
        let closeRange = rest.range(of: "```")
        let complete = closeRange != nil
        let code = closeRange != nil ? String(rest[..<closeRange!.lowerBound]) : String(rest)

        switch lang {
        case "html":
            return DetectedArtifact(kind: .html, language: lang, code: code, complete: complete)
        case "jsx", "tsx", "react":
            return DetectedArtifact(kind: .react, language: lang, code: code, complete: complete)
        default:
            if runnableLanguages.contains(lang) {
                return DetectedArtifact(kind: .runnable(language: lang), language: lang, code: code, complete: complete)
            }
            return nil
        }
    }

    /// Wraps JSX/TSX in an HTML shell that loads React 18 + Babel standalone
    /// from a CDN and mounts an exported `App` or `Component` function.
    static func reactShellHTML(code: String) -> String {
        """
        <!DOCTYPE html><html><head><meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
        <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
        <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
        <style>body{margin:0;font-family:-apple-system,sans-serif;}</style>
        </head><body>
        <div id="root"></div>
        <script type="text/babel">
        \(code)
        const Mounted = typeof App !== 'undefined' ? App : (typeof Component !== 'undefined' ? Component : null);
        if (Mounted) {
          ReactDOM.createRoot(document.getElementById('root')).render(<Mounted/>);
        }
        </script>
        </body></html>
        """
    }
}
