import SwiftUI

/// Lightweight custom markdown renderer — no third-party library, matching
/// android's hand-rolled approach. Fenced code blocks render as CodeBlock;
/// `#` headings collapse to bold paragraphs (a deliberate design choice, not
/// an omission); inline **bold** is supported.
struct MarkdownBody: View {
    let text: String

    private enum Block {
        case code(lang: String, body: String, complete: Bool)
        case paragraph(String)
        case bullet(String)
        case numbered(String)
        case image(url: String, alt: String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let lang, let body, let complete):
                    if lang.lowercased() == "mermaid" {
                        MermaidBlock(source: body, complete: complete)
                    } else {
                        CodeBlock(language: lang, code: body)
                    }
                case .paragraph(let s):
                    inlineText(s)
                case .bullet(let s):
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").foregroundColor(FridayColor.text)
                        inlineText(s)
                    }
                case .numbered(let s):
                    inlineText(s)
                case .image(let url, let alt):
                    ChatImage(url: url, alt: alt)
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
                let closed = lines.first != nil
                if closed { lines = lines.dropFirst() } // consume closing fence
                result.append(.code(lang: lang, body: codeLines.joined(separator: "\n"), complete: closed))
            } else if let img = Self.imageMatch(trimmed) {
                flushParagraph()
                result.append(.image(url: img.url, alt: img.alt))
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

    private static func imageMatch(_ line: String) -> (url: String, alt: String)? {
        guard line.hasPrefix("!["),
              let re = try? NSRegularExpression(pattern: #"^!\[(.*?)\]\((.+?)\)$"#),
              let m = re.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let altR = Range(m.range(at: 1), in: line), let urlR = Range(m.range(at: 2), in: line) else { return nil }
        return (String(line[urlR]), String(line[altR]))
    }
}

private struct ChatImage: View {
    let url: String
    let alt: String

    private var resolved: URL? {
        if url.hasPrefix("/") { return URL(string: "https://friday.billionairestechnologies.com" + url) }
        return URL(string: url)
    }

    var body: some View {
        AsyncImage(url: resolved) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFit()
                    .overlay(alignment: .topTrailing) {
                        Button { Task { await download() } } label: {
                            Image(systemName: "arrow.down.to.line")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundColor(.white)
                                .frame(width: 34, height: 34)
                                .background(Color.black.opacity(0.55))
                                .clipShape(Circle())
                        }
                        .padding(8)
                    }
            case .failure:
                Text(alt.isEmpty ? "Image failed to load" : alt).font(.system(size: 13)).foregroundColor(FridayColor.muted)
            default:
                Rectangle().fill(FridayColor.text.opacity(0.08)).frame(height: 220)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .frame(maxWidth: .infinity)
    }

    private func download() async {
        do {
            let data: Data
            if url.hasPrefix("data:"), let comma = url.firstIndex(of: ","), let d = Data(base64Encoded: String(url[url.index(after: comma)...])) {
                data = d
            } else if let resolved {
                data = try await URLSession.shared.data(from: resolved).0
            } else { return }
            let ext = resolved?.pathExtension.lowercased() ?? ""
            ShareSheet.saveData(data, filename: "friday-image.\(["png", "jpg", "jpeg", "webp", "gif"].contains(ext) ? ext : "png")")
        } catch {
            NSLog("Image download failed: \(error)")
        }
    }
}
