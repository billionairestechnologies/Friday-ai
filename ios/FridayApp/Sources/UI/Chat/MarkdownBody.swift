import SwiftUI

/// Lightweight custom markdown renderer — no third-party library, matching
/// android's hand-rolled approach. Fenced code blocks render as CodeBlock;
/// `#` headings collapse to bold paragraphs (a deliberate design choice, not
/// an omission); inline **bold** is supported.
struct MarkdownBody: View {
    let text: String

    private enum Block {
        case code(lang: String, body: String)
        case paragraph(String)
        case bullet(String)
        case numbered(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let lang, let body):
                    CodeBlock(language: lang, code: body)
                case .paragraph(let s):
                    inlineText(s)
                case .bullet(let s):
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").foregroundColor(FridayColor.text)
                        inlineText(s)
                    }
                case .numbered(let s):
                    inlineText(s)
                }
            }
        }
    }

    private func inlineText(_ s: String) -> Text {
        var result = Text("")
        var remaining = Substring(s)
        while let range = remaining.range(of: #"\*\*[^*]+\*\*"#, options: .regularExpression) {
            let before = remaining[remaining.startIndex..<range.lowerBound]
            result = result + Text(String(before)).font(FridayType.body()).foregroundColor(FridayColor.text)
            let bold = remaining[range].trimmingCharacters(in: CharacterSet(charactersIn: "*"))
            result = result + Text(bold).font(FridayType.body().weight(.semibold)).foregroundColor(FridayColor.text)
            remaining = remaining[range.upperBound...]
        }
        result = result + Text(String(remaining)).font(FridayType.body()).foregroundColor(FridayColor.text)
        return result
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var lines = text.components(separatedBy: "\n")[...]
        var paragraphBuf: [String] = []

        func flushParagraph() {
            guard !paragraphBuf.isEmpty else { return }
            result.append(.paragraph(paragraphBuf.joined(separator: "\n")))
            paragraphBuf = []
        }

        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flushParagraph()
                let lang = String(trimmed.dropFirst(3))
                var codeLines: [String] = []
                while let next = lines.first, !next.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(next)
                    lines = lines.dropFirst()
                }
                if lines.first != nil { lines = lines.dropFirst() } // consume closing fence
                result.append(.code(lang: lang, body: codeLines.joined(separator: "\n")))
            } else if trimmed.hasPrefix("#") {
                flushParagraph()
                result.append(.paragraph(trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "# "))))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                flushParagraph()
                result.append(.bullet(String(trimmed.dropFirst(2))))
            } else if trimmed.isEmpty {
                flushParagraph()
            } else {
                paragraphBuf.append(line)
            }
        }
        flushParagraph()
        return result
    }
}
