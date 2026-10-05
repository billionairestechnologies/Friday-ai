import SwiftUI

struct LibraryScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var items: [LibraryItem]?
    @State private var failed = false
    @State private var category = "All"
    @State private var open: LibraryItem?
    @State private var errorText: String?

    private var categories: [(String, Int)] {
        let all = items ?? []
        var counts: [String: Int] = [:]
        for item in all { counts[item.category, default: 0] += 1 }
        return [("All", all.count)] + counts.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    private var visible: [LibraryItem] {
        (items ?? []).filter { category == "All" || $0.category == category }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Library").font(.system(size: 22, weight: .medium)).foregroundColor(FridayColor.text)
                    Text("Saved automatically from your chats").font(.system(size: 13)).foregroundColor(FridayColor.muted)
                }
                Spacer()
                Button { vm.page = "chat" } label: {
                    Image(systemName: "xmark").foregroundColor(FridayColor.text).padding(8)
                }
            }
            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 8)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(categories, id: \.0) { name, count in
                        Button { category = name } label: {
                            Text("\(name)  \(count)")
                                .font(.system(size: 13))
                                .foregroundColor(category == name ? FridayColor.bg : FridayColor.text)
                                .padding(.horizontal, 14).padding(.vertical, 7)
                                .background(category == name ? FridayColor.text : FridayColor.surface)
                                .clipShape(Capsule())
                        }
                    }
                }
                .padding(.horizontal, 16)
            }

            if let errorText {
                Text(errorText).font(.system(size: 13)).foregroundColor(FridayColor.error).padding(.horizontal, 20).padding(.top, 8)
            }

            if failed && items == nil {
                VStack(spacing: 8) {
                    Spacer()
                    Text("Couldn't load your library.").foregroundColor(FridayColor.muted)
                    Button("Try again") { Task { await load() } }
                    Spacer()
                }.frame(maxWidth: .infinity)
            } else if items == nil {
                VStack { Spacer(); ProgressView(); Spacer() }.frame(maxWidth: .infinity)
            } else if visible.isEmpty {
                VStack {
                    Spacer()
                    Text((items ?? []).isEmpty
                         ? "Nothing here yet. Presentations, PDFs, spreadsheets, documents, code and images from your chats are saved here automatically."
                         : "Nothing in this category.")
                        .font(.system(size: 14)).foregroundColor(FridayColor.muted).multilineTextAlignment(.center).padding(32)
                    Spacer()
                }.frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(visible) { item in
                            Button { openItem(item) } label: { card(item) }.buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .background(FridayColor.bg.ignoresSafeArea())
        .task { await load() }
        .sheet(item: $open) { item in
            LibraryDetail(item: item) { deleted in
                open = nil
                if deleted { items?.removeAll { $0.id == item.id } }
            }
        }
    }

    private func card(_ item: LibraryItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(item.category) · \(String(item.createdAt.prefix(10)))").font(.system(size: 12)).foregroundColor(FridayColor.muted)
            Text(item.title).font(.system(size: 15, weight: .medium)).foregroundColor(FridayColor.text).lineLimit(1)
            if item.kind == "image", let url = URL(string: item.content) {
                AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { FridayColor.hairline }
                    .frame(height: 140).frame(maxWidth: .infinity).clipped().cornerRadius(10)
            } else {
                Text(item.content).font(.system(size: 12, design: .monospaced)).foregroundColor(FridayColor.muted).lineLimit(4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(FridayColor.surface)
        .cornerRadius(14)
    }

    private func load() async {
        do {
            items = try await LibraryApi.list()
            failed = false
        } catch {
            failed = true
        }
    }

    private func openItem(_ item: LibraryItem) {
        // Generated documents and uploads download through the web Library.
        if item.category == "Documents" || item.category == "Uploads" {
            if let url = URL(string: "https://friday.billionairestechnologies.com/library") { UIApplication.shared.open(url) }
            return
        }
        open = item
        guard item.kind != "image" else { return }
        Task {
            if let full = try? await LibraryApi.get(id: item.id), open?.id == item.id { open = full }
        }
    }
}

private struct LibraryDetail: View {
    let item: LibraryItem
    let onClose: (_ deleted: Bool) -> Void
    @State private var confirmDelete = false
    @State private var errorText: String?
    @State private var copied = false

    private var fileURL: URL? {
        guard item.kind != "image" else { return nil }
        let ext: [String: String] = [
            "html": "html", "python": "py", "py": "py", "javascript": "js", "js": "js", "typescript": "ts", "ts": "ts",
            "jsx": "jsx", "tsx": "tsx", "css": "css", "bash": "sh", "sh": "sh", "shell": "sh", "sql": "sql",
            "json": "json", "yaml": "yml", "yml": "yml", "xml": "xml", "csv": "csv", "java": "java",
            "kotlin": "kt", "swift": "swift", "go": "go", "rust": "rs", "r": "r",
        ]
        let base = item.title.replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        let name = "\(base.isEmpty ? "friday" : String(base.prefix(50))).\(ext[(item.lang ?? "").lowercased()] ?? (item.kind == "react" ? "jsx" : "txt"))"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try? item.content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.system(size: 17, weight: .medium)).foregroundColor(FridayColor.text).lineLimit(2)
                    Text(item.category).font(.system(size: 12)).foregroundColor(FridayColor.muted)
                }
                Spacer()
                Button { onClose(false) } label: { Image(systemName: "xmark").foregroundColor(FridayColor.text).padding(8) }
            }
            ScrollView {
                if item.kind == "image", let url = URL(string: item.content) {
                    AsyncImage(url: url) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }
                } else {
                    Text(item.content).font(.system(size: 12, design: .monospaced)).foregroundColor(FridayColor.text)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }
            }
            .background(FridayColor.surface).cornerRadius(10)

            if let errorText { Text(errorText).font(.system(size: 13)).foregroundColor(FridayColor.error) }

            HStack {
                if item.kind != "image" {
                    Button(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string = item.content
                        copied = true
                    }
                }
                if let fileURL {
                    ShareLink(item: fileURL) { Text("Download") }
                } else if let url = URL(string: item.content) {
                    ShareLink(item: url) { Text("Share") }
                }
                Spacer()
                Button("Delete", role: .destructive) { confirmDelete = true }
            }
        }
        .padding(16)
        .background(FridayColor.bg.ignoresSafeArea())
        .alert("Delete from library?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) {
                Task {
                    do {
                        try await LibraryApi.delete(id: item.id)
                        onClose(true)
                    } catch {
                        errorText = "Couldn't delete that item — check your connection."
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\"\(item.title)\" will be removed on all your devices.")
        }
    }
}
