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

    private var highlightedText: Text {
        let keywords: Set<String> = ["fun", "val", "var", "class", "from", "import", "def", "for", "if", "else", "return", "const", "let", "function", "struct", "enum", "public", "private", "static"]
        var result = Text("")
        for rawLine in code.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            if let range = line.range(of: "//") {
                result = result + colorize(String(line[..<range.lowerBound]), keywords: keywords) + Text(String(line[range.lowerBound...])).foregroundColor(FridayColor.codeComment)
            } else if line.trimmingCharacters(in: .whitespaces).hasPrefix("#") {
                result = result + Text(line).foregroundColor(FridayColor.codeComment)
            } else {
                result = result + colorize(line, keywords: keywords)
            }
            result = result + Text("\n")
        }
        return result
    }

    private func colorize(_ line: String, keywords: Set<String>) -> Text {
        var out = Text("")
        var inString = false
        var token = ""
        func flush() {
            guard !token.isEmpty else { return }
            if keywords.contains(token) {
                out = out + Text(token).foregroundColor(FridayColor.codeTag)
            } else {
                out = out + Text(token).foregroundColor(FridayColor.codeFg)
            }
            token = ""
        }
        var stringBuf = ""
        for ch in line {
            if ch == "\"" {
                if inString {
                    stringBuf.append(ch)
                    out = out + Text(stringBuf).foregroundColor(FridayColor.codeString)
                    stringBuf = ""
                    inString = false
                } else {
                    flush()
                    inString = true
                    stringBuf = String(ch)
                }
                continue
            }
            if inString { stringBuf.append(ch); continue }
            if ch.isLetter || ch == "_" {
                token.append(ch)
            } else {
                flush()
                out = out + Text(String(ch)).foregroundColor(FridayColor.codeFg)
            }
        }
        flush()
        if inString { out = out + Text(stringBuf).foregroundColor(FridayColor.codeString) }
        return out
    }
}
