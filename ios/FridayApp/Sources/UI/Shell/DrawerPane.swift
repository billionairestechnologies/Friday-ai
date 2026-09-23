import SwiftUI

struct DrawerPane: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    navRow(icon: "square.and.pencil", label: "New chat") { vm.newChat() }
                    navRow(icon: "arrow.triangle.2.circlepath", label: "Automations") { vm.page = "automations" }
                    navRow(icon: "books.vertical", label: "Library") { vm.page = "library" }
                    navRow(icon: "folder", label: "Projects") { vm.page = "projects" }

                    Text("Conversations")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(FridayColor.muted)
                        .padding(.top, 16).padding(.horizontal, 16).padding(.bottom, 4)

                    if filteredChats.isEmpty {
                        Text("No conversations yet")
                            .font(.system(size: 13))
                            .foregroundColor(FridayColor.muted)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                    }

                    ForEach(filteredChats) { chat in
                        Button { vm.selectChat(chat.id) } label: {
                            HStack {
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
    }

    private var filteredChats: [ChatThread] {
        search.isEmpty ? vm.chats : vm.chats.filter { $0.title.localizedCaseInsensitiveContains(search) }
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
                    if vm.user != nil {
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
