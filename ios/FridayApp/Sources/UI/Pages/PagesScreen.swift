import SwiftUI

/// Pages: live documents, spreadsheets and slide decks made in chat or on the web. The app opens them read-only;
/// editing, sharing and export are on the web (friday.billionairestechnologies.com/pages).
struct PagesScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var pages: [PageSummary]?
    @State private var failed = false
    @State private var open: PageSummary?

    private func icon(_ kind: String) -> String {
        switch kind { case "sheet": return "tablecells"; case "slides": return "rectangle.on.rectangle"; default: return "doc.text" }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Pages").font(.system(size: 22, weight: .medium)).foregroundColor(FridayColor.text)
                        Text("Documents, sheets and decks you and Friday work on").font(.system(size: 13)).foregroundColor(FridayColor.muted)
                    }
                    Spacer()
                    Button { vm.page = "chat" } label: { Image(systemName: "xmark").foregroundColor(FridayColor.text).padding(8) }
                }
                .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 8)

                if let pages {
                    if pages.isEmpty {
                        Text("No pages yet. Ask Friday to \"write this up as a page\" and it shows up here.")
                            .font(.system(size: 14)).foregroundColor(FridayColor.muted).padding(20)
                    } else {
                        ScrollView {
                            VStack(spacing: 8) {
                                ForEach(pages) { p in
                                    Button { open = p } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: icon(p.kind)).foregroundColor(FridayColor.muted).frame(width: 24)
                                            Text(p.title).font(.system(size: 15)).foregroundColor(FridayColor.text).lineLimit(1)
                                            Spacer()
                                            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(FridayColor.muted)
                                        }
                                        .padding(14).background(FridayColor.surface).cornerRadius(12)
                                    }
                                }
                            }
                            .padding(.horizontal, 16).padding(.bottom, 24)
                        }
                    }
                } else if failed {
                    Button("Couldn't load pages — tap to retry") { Task { await load() } }
                        .font(.system(size: 14)).foregroundColor(FridayColor.muted).padding(20)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
                Spacer(minLength: 0)
            }
            .background(FridayColor.bg.ignoresSafeArea())
            .navigationDestination(isPresented: Binding(get: { open != nil }, set: { if !$0 { open = nil } })) {
                if let p = open { PageViewer(page: p) }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do { pages = try await PagesApi.list(); failed = false } catch { if pages == nil { failed = true } }
    }
}

private struct PageViewer: View {
    let page: PageSummary
    @State private var detail: PageDetail?
    @State private var failed = false
    @State private var sheetIndex = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let d = detail {
                    switch d.kind {
                    case "sheet": sheet(d)
                    case "slides": slides(d)
                    default: MarkdownBody(text: d.markdown)
                    }
                } else if failed {
                    Text("Couldn't open this page. Check your connection and try again.").font(.system(size: 14)).foregroundColor(FridayColor.muted)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
                Text("Read-only here — edit, share or export it on the web.").font(.system(size: 12)).foregroundColor(FridayColor.muted).padding(.top, 8)
            }
            .padding(20)
        }
        .background(FridayColor.bg.ignoresSafeArea())
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do { detail = try await PagesApi.get(id: page.id) } catch { failed = true }
        }
    }

    @ViewBuilder private func sheet(_ d: PageDetail) -> some View {
        if d.sheets.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(Array(d.sheets.enumerated()), id: \.offset) { i, s in
                        Button { sheetIndex = i } label: {
                            Text(s.name).font(.system(size: 13)).foregroundColor(sheetIndex == i ? FridayColor.bg : FridayColor.text)
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(sheetIndex == i ? FridayColor.text : FridayColor.surface).clipShape(Capsule())
                        }
                    }
                }
            }
        }
        if d.sheets.indices.contains(sheetIndex) {
            let s = d.sheets[sheetIndex]
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    row(s.columns, header: true)
                    ForEach(Array(s.rows.enumerated()), id: \.offset) { _, r in row(r, header: false) }
                }
            }
        }
    }

    private func row(_ cells: [String], header: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, c in
                Text(c).font(.system(size: 13, weight: header ? .semibold : .regular)).foregroundColor(FridayColor.text)
                    .frame(width: 120, alignment: .leading).padding(8).lineLimit(2)
                    .background(header ? FridayColor.chip : FridayColor.bg)
                    .overlay(Rectangle().stroke(FridayColor.hairline, lineWidth: 0.5))
            }
        }
    }

    @ViewBuilder private func slides(_ d: PageDetail) -> some View {
        ForEach(Array(d.slides.enumerated()), id: \.offset) { i, s in
            VStack(alignment: .leading, spacing: 6) {
                Text("Slide \(i + 1)").font(.system(size: 11)).foregroundColor(FridayColor.muted)
                if let t = s["title"] as? String, !t.isEmpty { Text(t).font(.system(size: 17, weight: .semibold)).foregroundColor(FridayColor.text) }
                if let t = s["subtitle"] as? String, !t.isEmpty { Text(t).font(.system(size: 14)).foregroundColor(FridayColor.muted) }
                ForEach(Array((s["bullets"] as? [String] ?? []).enumerated()), id: \.offset) { _, b in
                    Text("•  " + b).font(.system(size: 14)).foregroundColor(FridayColor.text)
                }
                if let q = s["quote"] as? String, !q.isEmpty { Text("“\(q)”").font(.system(size: 14).italic()).foregroundColor(FridayColor.text) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14).background(FridayColor.surface).cornerRadius(12)
        }
    }
}
