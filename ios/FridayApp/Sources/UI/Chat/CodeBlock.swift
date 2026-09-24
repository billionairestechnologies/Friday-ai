import SwiftUI

/// Dark code block with a crude regex-based highlighter — matches android
/// CodeBlock.kt's approach rather than pulling in a full highlighting lib.
struct CodeBlock: View {
    let language: String
    let code: String

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.lowercased())
                    .font(.system(size: 12))
                    .foregroundColor(FridayColor.codeComment)
                Spacer()
                Button {
                    ShareSheet.saveText(code, filename: "friday-code.\(ShareSheet.fileExtension(for: language))")
                } label: {
                    Text("Download")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(FridayColor.codeTag)
                }
                .padding(.trailing, 12)
                Button {
                    UIPasteboard.general.string = code
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

            ScrollView(.horizontal, showsIndicators: false) {
                highlightedText
                    .font(.system(size: 13, design: .monospaced))
                    .lineSpacing(7)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
            }
        }
        .background(FridayColor.codeBg)
        .cornerRadius(FridayRadius.code)
    }

    /// Built as a flat AttributedString: chaining `Text + Text` per token nests
    /// the view tree thousands deep and overflows the stack on long code.
    private var highlightedText: Text {
        let keywords: Set<String> = ["fun", "val", "var", "class", "from", "import", "def", "for", "if", "else", "return", "const", "let", "function", "struct", "enum", "public", "private", "static"]
        var result = AttributedString()
        for rawLine in code.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            if let range = line.range(of: "//") {
                colorize(String(line[..<range.lowerBound]), keywords: keywords, into: &result)
                append(String(line[range.lowerBound...]), FridayColor.codeComment, to: &result)
            } else if line.trimmingCharacters(in: .whitespaces).hasPrefix("#") {
                append(line, FridayColor.codeComment, to: &result)
            } else {
                colorize(line, keywords: keywords, into: &result)
            }
            result.append(AttributedString("\n"))
        }
        return Text(result)
    }

    private func append(_ s: String, _ color: Color, to out: inout AttributedString) {
        var piece = AttributedString(s)
        piece.foregroundColor = color
        out.append(piece)
    }

    private func colorize(_ line: String, keywords: Set<String>, into out: inout AttributedString) {
        var inString = false
        var token = ""
        var stringBuf = ""
        var plain = ""
        func flushPlain() {
            guard !plain.isEmpty else { return }
            append(plain, FridayColor.codeFg, to: &out)
            plain = ""
        }
        func flushToken() {
            guard !token.isEmpty else { return }
            if keywords.contains(token) {
                flushPlain()
                append(token, FridayColor.codeTag, to: &out)
            } else {
                plain += token
            }
            token = ""
        }
        for ch in line {
            if ch == "\"" {
                if inString {
                    stringBuf.append(ch)
                    append(stringBuf, FridayColor.codeString, to: &out)
                    stringBuf = ""
                    inString = false
                } else {
                    flushToken()
                    flushPlain()
                    inString = true
                    stringBuf = String(ch)
                }
                continue
            }
            if inString { stringBuf.append(ch); continue }
            if ch.isLetter || ch == "_" {
                token.append(ch)
            } else {
                flushToken()
                plain.append(ch)
            }
        }
        flushToken()
        flushPlain()
        if inString { append(stringBuf, FridayColor.codeString, to: &out) }
    }
}


enum ShareSheet {
    static func present(_ items: [Any]) {
        DispatchQueue.main.async {
            guard var top = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first?.keyWindow?.rootViewController else { return }
            while let presented = top.presentedViewController { top = presented }
            let av = UIActivityViewController(activityItems: items, applicationActivities: nil)
            av.popoverPresentationController?.sourceView = top.view
            av.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            top.present(av, animated: true)
        }
    }

    static func saveText(_ text: String, filename: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            present([url])
        } catch {
            NSLog("Couldn't write \(filename): \(error)")
        }
    }

    static func saveData(_ data: Data, filename: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        do {
            try data.write(to: url)
            present([url])
        } catch {
            NSLog("Couldn't write \(filename): \(error)")
        }
    }

    static func fileExtension(for language: String) -> String {
        switch language.lowercased() {
        case "python", "py": return "py"
        case "javascript", "js": return "js"
        case "typescript", "ts": return "ts"
        case "tsx": return "tsx"
        case "jsx": return "jsx"
        case "html": return "html"
        case "css": return "css"
        case "json": return "json"
        case "kotlin", "kt": return "kt"
        case "java": return "java"
        case "swift": return "swift"
        case "bash", "sh", "shell": return "sh"
        case "sql": return "sql"
        case "xml": return "xml"
        case "yaml", "yml": return "yml"
        case "markdown", "md": return "md"
        case "c": return "c"
        case "cpp", "c++": return "cpp"
        case "go": return "go"
        case "rust", "rs": return "rs"
        case "r": return "r"
        default: return "txt"
        }
    }
}
