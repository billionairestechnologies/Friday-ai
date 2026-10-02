import SwiftUI

struct DrawerPane: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var search = ""
    @State private var hits: [SearchHit] = []
    @State private var searchError: String?
    @State private var shareNote: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    navRow(icon: "square.and.pencil", label: "New chat") { vm.newChat(); vm.page = "chat" }
                    navRow(icon: "hammer", label: "Build") { vm.newBuild(); vm.page = "chat" }
                    navRow(icon: "arrow.triangle.2.circlepath", label: "Automations") { vm.page = "automations" }
                    navRow(icon: "books.vertical", label: "Library") { vm.page = "library" }
                    navRow(icon: "folder", label: "Projects") { vm.page = "projects" }
                    navRow(icon: "doc.text", label: "Pages") { vm.page = "pages" }
                    // Support and status live on the web (same account, same tickets).
                    navRow(icon: "questionmark.bubble", label: "Help & support") { openWeb("/?support=contact") }
                    navRow(icon: "waveform.path.ecg", label: "System status") { openWeb("/status") }

                    Text(vm.workspace == "build" ? "Builds" : "Conversations")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(FridayColor.muted)
                        .padding(.top, 16).padding(.horizontal, 16).padding(.bottom, 4)

                    if let searchError {
                        Text("Search failed: \(searchError)").font(.system(size: 13)).foregroundColor(FridayColor.error)
                            .padding(.horizontal, 16).padding(.vertical, 6)
                    }
                    if !hits.isEmpty {
                        Text("In messages").font(.system(size: 12, weight: .medium)).foregroundColor(FridayColor.muted)
                            .padding(.horizontal, 16).padding(.top, 4)
                        ForEach(hits) { h in
                            Button { vm.selectChat(h.conversationId) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(h.title).font(.system(size: 14, weight: .medium)).lineLimit(1)
                                    Text(h.snippet).font(.system(size: 12.5)).foregroundColor(FridayColor.muted).lineLimit(2)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16).padding(.vertical, 8)
                            }
                            .foregroundColor(FridayColor.text)
                            .padding(.horizontal, 8)
                        }
                    }

                    if filteredChats.isEmpty {
                        Text(!search.isEmpty ? "No matching titles" : vm.workspace == "build" ? "No builds yet — describe an app to start one" : "No conversations yet")
                            .font(.system(size: 13))
                            .foregroundColor(FridayColor.muted)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                    }

                    ForEach(filteredChats) { chat in
                        Button { vm.selectChat(chat.id) } label: {
                            HStack(spacing: 8) {
                                if vm.workspace == "build", let dot = buildStatusMeta(vm.buildSessions.first(where: { $0.id == chat.id })?.status) {
                                    Circle().fill(dot.color).frame(width: 7, height: 7)
                                }
                                Text(chat.title).font(.system(size: 14, weight: chat.id == vm.currentId ? .medium : .regular)).lineLimit(2)
                                Spacer()
                            }
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .background(chat.id == vm.currentId ? FridayColor.surface : Color.clear)
                            .cornerRadius(10)
                        }
                        .foregroundColor(FridayColor.text)
                        .padding(.horizontal, 8)
                        .contextMenu {
                            Button { share(chat) } label: { Label("Copy public link", systemImage: "link") }
                            Button { unshare(chat) } label: { Label("Turn off sharing", systemImage: "link.badge.plus") }
                            Button("Delete", role: .destructive) { vm.deleteChat(chat.id) }
                        }
                    }
                }
            }

            if let update = vm.updateInfo {
                Button {
                    if let url = URL(string: update.url) { UIApplication.shared.open(url) }
                } label: {
                    Text("Update available — v\(update.version) is ready")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                        .background(LinearGradient(colors: [FridayColor.stop, FridayColor.search], startPoint: .leading, endPoint: .trailing))
                }
            }

            bottomBar
            if vm.user == nil {
                Button { vm.startAuth(signup: false) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "person.fill").font(.system(size: 15))
                        Text("Log in to sync").font(.system(size: 15))
                        Spacer()
                    }
                    .foregroundColor(FridayColor.text)
                    .padding(.horizontal, 16).frame(height: 52)
                    .background(FridayColor.surface)
                    .cornerRadius(16)
                }
                .padding(.horizontal, 12).padding(.bottom, 8)
            }
        }
        .background(FridayColor.bg.ignoresSafeArea())
        .alert(shareNote ?? "", isPresented: Binding(get: { shareNote != nil }, set: { if !$0 { shareNote = nil } })) {
            Button("OK", role: .cancel) {}
        }
        // Debounced full-text search across message bodies (GET /api/chat/search); titles filter locally.
        .task(id: search) {
            hits = []; searchError = nil
            let q = search.trimmingCharacters(in: .whitespaces)
            guard vm.user != nil, q.count >= 2 else { return }
            try? await Task.sleep(nanoseconds: 350_000_000)
            if Task.isCancelled { return }
            do { hits = try await AgentApi.search(q) }
            catch { if !Task.isCancelled { searchError = error.localizedDescription } }
        }
    }

    private func share(_ chat: ChatThread) {
        Task {
            do {
                let url = try await AgentApi.shareConversation(id: chat.id)
                UIPasteboard.general.string = url.absoluteString
                shareNote = "Link copied — anyone with it can read this chat."
            } catch { shareNote = "Couldn't create a link: \(error.localizedDescription)" }
        }
    }

    private func unshare(_ chat: ChatThread) {
        Task {
            do { try await AgentApi.unshareConversation(id: chat.id); shareNote = "Sharing turned off." }
            catch { shareNote = "Couldn't turn off sharing: \(error.localizedDescription)" }
        }
    }

    private var filteredChats: [ChatThread] {
        // Build sessions (and older chats that made a project) are listed under Build; chats under Chat.
        let inWorkspace = vm.chats.filter { vm.workspace == "build" ? $0.isBuild : $0.workspace != "build" }
        return search.isEmpty ? inWorkspace : inWorkspace.filter { $0.title.localizedCaseInsensitiveContains(search) }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Circle().fill(FridayColor.softBlue).frame(width: 40, height: 40)
                .overlay(Text(String((vm.user?.name ?? "G").prefix(1))).font(.system(size: 16, weight: .semibold)).foregroundColor(FridayColor.text))

            Button { vm.page = "settings" } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(vm.user?.name ?? "Guest").font(.system(size: 17, weight: .bold))
                        Image(systemName: "chevron.down").font(.system(size: 11))
                    }
                    if vm.user != nil && vm.planLoaded {
                        Text("\(vm.plan.capitalized) plan")
                            .font(.system(size: 12))
                            .foregroundColor(vm.plan == "free" ? FridayColor.muted : FridayColor.search)
                    }
                }
            }
            .foregroundColor(FridayColor.text)

            Spacer()
            Button { vm.drawerOpen = false } label: {
                Image(systemName: "xmark").foregroundColor(FridayColor.text).frame(width: 32, height: 32).background(FridayColor.surface).clipShape(Circle())
            }
        }
        .padding(.horizontal, 16).padding(.bottom, 12).padding(.top, 4)
    }

    private func openWeb(_ path: String) {
        if let url = URL(string: "https://friday.billionairestechnologies.com\(path)") { UIApplication.shared.open(url) }
    }

    private func navRow(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 18)).frame(width: 21)
                Text(label).font(.system(size: 16))
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .foregroundColor(FridayColor.text)
    }

    private var bottomBar: some View {
        HStack(spacing: 10) {
            Button { vm.page = "settings" } label: {
                Image(systemName: "gearshape").frame(width: 36, height: 36).background(FridayColor.surface).clipShape(Circle())
            }
            HStack {
                Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundColor(FridayColor.muted)
                TextField("Search chats", text: $search).font(.system(size: 14))
            }
            .padding(.horizontal, 12).frame(height: 36)
            .background(FridayColor.surface).cornerRadius(18)

            Button { vm.newChat() } label: {
                Image(systemName: "square.and.pencil").foregroundColor(FridayColor.bg).frame(width: 36, height: 36).background(FridayColor.text).clipShape(Circle())
            }
        }
        .foregroundColor(FridayColor.text)
        .padding(12)
    }
}
