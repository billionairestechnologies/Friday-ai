import SwiftUI

/// Chat markdown renderer — no third-party library. Fenced code blocks render as CodeBlock
/// (mermaid as diagrams), and the rest is laid out as headings, nested bullet/numbered lists,
/// blockquotes, rules, GFM tables (aligned columns, horizontal scroll) and inline
/// **bold** / *italic* / ~~strike~~ / `code` / [links](url).
struct MarkdownBody: View {
    let text: String

    private enum Block {
        case code(lang: String, body: String, complete: Bool)
        case heading(level: Int, text: String)
        case paragraph(String)
        case item(text: String, depth: Int, ordinal: String?)
        case quote(String)
        case rule
        case table(headers: [String], rows: [[String]], aligns: [Character])
        case image(url: String, alt: String)
    }

    var body: some View {
        let parsed = blocks
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parsed.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let lang, let body, let complete):
                    if lang.lowercased() == "mermaid" {
                        MermaidBlock(source: body, complete: complete)
                    } else {
                        CodeBlock(language: lang, code: body)
                    }
                case .heading(let level, let s):
                    Text(Self.inline(s, size: Self.headingSize(level), weight: .bold))
                        .padding(.top, level <= 2 ? 6 : 2)
                case .paragraph(let s):
                    Text(Self.inline(s))
                case .item(let s, let depth, let ordinal):
                    HStack(alignment: .top, spacing: 8) {
                        Text(ordinal.map { "\($0)." } ?? (depth == 0 ? "•" : depth == 1 ? "◦" : "▪"))
                            .font(FridayType.body()).foregroundColor(FridayColor.text)
                        Text(Self.inline(s))
                    }
                    .padding(.leading, CGFloat(depth) * 18)
                case .quote(let s):
                    HStack(alignment: .top, spacing: 12) {
                        RoundedRectangle(cornerRadius: 2).fill(FridayColor.text.opacity(0.18)).frame(width: 3)
                        Text(Self.inline(s, color: FridayColor.muted))
                    }
                    .fixedSize(horizontal: false, vertical: true)
                case .rule:
                    Rectangle().fill(FridayColor.hairline).frame(height: 1).padding(.vertical, 4)
                case .table(let headers, let rows, let aligns):
                    MarkdownTable(headers: headers, rows: rows, aligns: aligns)
                case .image(let url, let alt):
                    ChatImage(url: url, alt: alt)
                }
            }
        }
    }

    private static func headingSize(_ level: Int) -> CGFloat {
        switch level { case 1: return 22; case 2: return 19; case 3: return 17; default: return 16 }
    }

    /// Inline markdown → styled Text (bold, italic, strike, `code`, links), falling back to plain text.
    static func inline(_ s: String, size: CGFloat? = nil, weight: Font.Weight? = nil, color: Color = FridayColor.text) -> AttributedString {
        var attributed = (try? AttributedString(
            markdown: s, options: .init(allowsExtendedAttributes: true, interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(s)
        let base: Font = size.map { .system(size: $0, weight: weight ?? .regular) } ?? (weight.map { FridayType.body().weight($0) } ?? FridayType.body())
        attributed.font = base
        attributed.foregroundColor = color
        for run in attributed.runs {
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.code) {
                    attributed[run.range].font = .system(size: (size ?? 15) - 1.5, design: .monospaced)
                    attributed[run.range].backgroundColor = FridayColor.chip
                } else if intent.contains(.stronglyEmphasized) {
                    attributed[run.range].font = (size.map { Font.system(size: $0, weight: .bold) } ?? FridayType.body().weight(.semibold))
                } else if intent.contains(.emphasized) {
                    attributed[run.range].font = base.italic()
                }
            }
            if run.link != nil {
                attributed[run.range].foregroundColor = FridayColor.search
                attributed[run.range].underlineStyle = .single
            }
        }
        return attributed
    }

    private static let headingRe = try! NSRegularExpression(pattern: #"^(#{1,6})\s+(.*?)\s*#*$"#)
    private static let bulletRe = try! NSRegularExpression(pattern: #"^(\s*)[-*+•]\s+(.*)$"#)
    private static let numberedRe = try! NSRegularExpression(pattern: #"^(\s*)(\d+)[.)]\s+(.*)$"#)
    private static let ruleRe = try! NSRegularExpression(pattern: #"^\s*([-*_])(\s*\1){2,}\s*$"#)
    private static let quoteRe = try! NSRegularExpression(pattern: #"^\s*>\s?(.*)$"#)
    private static let sepCellRe = try! NSRegularExpression(pattern: #"^:?-{2,}:?$"#)

    private static func groups(_ re: NSRegularExpression, _ s: String) -> [String]? {
        guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            Range(m.range(at: i), in: s).map { String(s[$0]) } ?? ""
        }
    }

    private static func splitCells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isSeparator(_ line: String) -> Bool {
        guard line.contains("-") else { return false }
        let cells = splitCells(line)
        return !cells.isEmpty && cells.allSatisfy { groups(sepCellRe, $0) != nil }
    }

    private var blocks: [Block] {
        var result: [Block] = []
        // A half-arrived `![alt](url…` while a reply streams must not show as text: it appears once whole.
        let visible = text.replacingOccurrences(of: #"!\[[^\]]*\]?\(?[^)]*$"#, with: "", options: .regularExpression)
        let all = visible.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n")
        var paragraph = ""

        func flush() {
            let t = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { result.append(.paragraph(t)) }
            paragraph = ""
        }

        var i = 0
        while i < all.count {
            let raw = all[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                flush()
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                i += 1
                while i < all.count, !all[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(all[i]); i += 1
                }
                let closed = i < all.count
                result.append(.code(lang: lang, body: codeLines.joined(separator: "\n"), complete: closed))
                i += 1 // closing fence
                continue
            }

            if trimmed.contains("|"), i + 1 < all.count, Self.isSeparator(all[i + 1].trimmingCharacters(in: .whitespaces)) {
                flush()
                let headers = Self.splitCells(trimmed)
                let aligns: [Character] = Self.splitCells(all[i + 1]).map { c in
                    if c.hasPrefix(":") && c.hasSuffix(":") { return "c" }
                    return c.hasSuffix(":") ? "r" : "l"
                }
                var rows: [[String]] = []
                i += 2
                while i < all.count, all[i].contains("|"), !all[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(Self.splitCells(all[i])); i += 1
                }
                result.append(.table(headers: headers, rows: rows, aligns: aligns))
                continue
            }

            if let img = Self.imageMatch(trimmed) {
                flush(); result.append(.image(url: img.url, alt: img.alt))
            } else if trimmed.isEmpty {
                flush()
            } else if Self.groups(Self.ruleRe, trimmed) != nil {
                flush(); result.append(.rule)
            } else if let g = Self.groups(Self.headingRe, trimmed) {
                flush(); result.append(.heading(level: g[1].count, text: g[2]))
            } else if Self.groups(Self.quoteRe, trimmed) != nil {
                flush()
                var q = Self.groups(Self.quoteRe, trimmed)![1]
                while i + 1 < all.count, let g = Self.groups(Self.quoteRe, all[i + 1].trimmingCharacters(in: .whitespaces)) {
                    q += " " + g[1]; i += 1
                }
                result.append(.quote(q))
            } else if let g = Self.groups(Self.bulletRe, raw) {
                flush(); result.append(.item(text: g[2], depth: g[1].count / 2, ordinal: nil))
            } else if let g = Self.groups(Self.numberedRe, raw) {
                flush(); result.append(.item(text: g[3], depth: g[1].count / 2, ordinal: g[2]))
            } else {
                if !paragraph.isEmpty { paragraph += raw.hasSuffix("  ") ? "\n" : " " }
                paragraph += trimmed
            }
            i += 1
        }
        flush()
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

/// GFM table: one grid so every column lines up across rows; scrolls sideways when wider than the screen.
private struct MarkdownTable: View {
    let headers: [String]
    let rows: [[String]]
    let aligns: [Character]

    private func alignment(_ c: Int) -> Alignment {
        switch aligns.indices.contains(c) ? aligns[c] : "l" { case "c": return .center; case "r": return .trailing; default: return .leading }
    }

    private func cell(_ s: String, _ c: Int, header: Bool, lastCol: Bool, lastRow: Bool) -> some View {
        Text(MarkdownBody.inline(s, size: 13, weight: header ? .bold : .regular))
            .multilineTextAlignment(c < aligns.count && aligns[c] == "r" ? .trailing : c < aligns.count && aligns[c] == "c" ? .center : .leading)
            .frame(minWidth: 84, maxWidth: 260, alignment: alignment(c))
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .overlay(alignment: .trailing) { if !lastCol { Rectangle().fill(FridayColor.hairline).frame(width: 1) } }
            .overlay(alignment: .bottom) { if !lastRow { Rectangle().fill(FridayColor.hairline).frame(height: 1) } }
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { c, h in
                        cell(h, c, header: true, lastCol: c == headers.count - 1, lastRow: false)
                            .background(FridayColor.surface)
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { r, row in
                    GridRow {
                        ForEach(0..<headers.count, id: \.self) { c in
                            cell(c < row.count ? row[c] : "", c, header: false, lastCol: c == headers.count - 1, lastRow: r == rows.count - 1)
                                .background(r % 2 == 1 ? FridayColor.surface.opacity(0.5) : Color.clear)
                        }
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(FridayColor.hairline, lineWidth: 1))
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
                // Capped like other chat apps: a generated image is a thumbnail in the thread, not a full-width banner.
                image.resizable().scaledToFit()
                    .frame(maxWidth: 340, maxHeight: 420)
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
        .frame(maxWidth: .infinity, alignment: .leading)
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
