import SwiftUI

private struct FormatStyle {
    let label: String
    let color: Color
    let icon: String
}

private func style(for format: String) -> FormatStyle {
    switch format {
    case "pptx": return FormatStyle(label: "PowerPoint", color: Color(hex: 0xD24726), icon: "rectangle.on.rectangle")
    case "xlsx": return FormatStyle(label: "Excel", color: Color(hex: 0x107C41), icon: "tablecells")
    case "csv": return FormatStyle(label: "CSV", color: Color(hex: 0x107C41), icon: "tablecells")
    case "docx": return FormatStyle(label: "Word", color: Color(hex: 0x185ABD), icon: "doc.text")
    case "pdf": return FormatStyle(label: "PDF", color: Color(hex: 0xD93025), icon: "doc.richtext")
    case "md": return FormatStyle(label: "Markdown", color: Color(hex: 0x6B7280), icon: "doc.text")
    case "xml": return FormatStyle(label: "XML", color: Color(hex: 0xB45309), icon: "chevron.left.forwardslash.chevron.right")
    case "json": return FormatStyle(label: "JSON", color: Color(hex: 0xB45309), icon: "curlybraces")
    case "html": return FormatStyle(label: "HTML", color: Color(hex: 0xE34F26), icon: "chevron.left.forwardslash.chevron.right")
    default: return FormatStyle(label: "Text", color: Color(hex: 0x6B7280), icon: "doc.text")
    }
}

private func formatBytes(_ n: Int) -> String {
    if n >= 1_048_576 { return String(format: "%.1f MB", Double(n) / 1_048_576) }
    if n >= 1024 { return "\(n / 1024) KB" }
    return "\(n) B"
}

/// Download cards for files Friday generated (create_document) — same cards as web's file-card.tsx, fading in one by one.
/// A "page" is a live Friday page: it opens in Pages instead of downloading.
struct FileCards: View {
    @EnvironmentObject var vm: FridayViewModel
    let files: [GeneratedFile]
    @State private var shown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                FileCard(file: file)
                    .opacity(shown ? 1 : 0)
                    .offset(y: shown ? 0 : 6)
                    .animation(.easeOut(duration: 0.25).delay(Double(index) * 0.05), value: shown)
            }
        }
        .frame(maxWidth: 440, alignment: .leading)
        .onAppear { shown = true }
    }
}

private struct FileCard: View {
    @EnvironmentObject var vm: FridayViewModel
    let file: GeneratedFile
    @State private var busy = false
    @State private var error: String?

    private var isPage: Bool { file.format == "page" }

    var body: some View {
        let st = style(for: file.format)
        Button { Task { await act() } } label: {
            HStack(spacing: 12) {
                ZStack(alignment: .bottom) {
                    RoundedRectangle(cornerRadius: 12).fill(st.color.opacity(0.12)).frame(width: 44, height: 44)
                    Image(systemName: isPage ? (file.pageKind == "sheet" ? "tablecells" : file.pageKind == "slides" ? "rectangle.on.rectangle" : "doc.text") : st.icon)
                        .font(.system(size: 18)).foregroundColor(st.color).frame(width: 44, height: 44)
                    if !isPage {
                        Text(file.format.uppercased()).font(.system(size: 8, weight: .bold)).foregroundColor(.white)
                            .padding(.horizontal, 4).background(st.color).cornerRadius(4).offset(y: 4)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.title.isEmpty ? file.filename : file.title).font(.system(size: 14.5, weight: .medium)).foregroundColor(FridayColor.text).lineLimit(1)
                    Text(error ?? (isPage ? "Page · view it in Pages" : "\(st.label) · \(formatBytes(file.size))"))
                        .font(.system(size: 12)).foregroundColor(error == nil ? FridayColor.muted : FridayColor.error).lineLimit(1)
                }
                Spacer(minLength: 6)
                if busy {
                    ProgressView().scaleEffect(0.8)
                } else {
                    Image(systemName: isPage ? "arrow.up.right" : "arrow.down.to.line").font(.system(size: 13, weight: .medium)).foregroundColor(FridayColor.muted)
                        .frame(width: 34, height: 34).overlay(Circle().stroke(FridayColor.hairline, lineWidth: 1))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(FridayColor.surface).cornerRadius(16)
        }
        .buttonStyle(.plain)
    }

    private func act() async {
        if isPage { vm.pageToOpen = file.id; vm.page = "pages"; return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let data = try await FilesApi.download(id: file.id)
            ShareSheet.saveData(data, filename: file.filename)
        } catch ApiError.http(_, let msg) {
            error = msg
        } catch {
            self.error = "Download failed. Try again."
        }
    }
}
