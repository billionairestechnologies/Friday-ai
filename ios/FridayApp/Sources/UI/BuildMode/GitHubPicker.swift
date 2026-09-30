import SwiftUI

/// Above the Build composer on a new build (like Claude Code's repo + branch chips): "Connect GitHub"
/// if it isn't, otherwise pick one of your repositories (or create one), then the branch to work on
/// (or create one from the current branch).
struct GitHubPicker: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var connected: Bool?
    @State private var showRepos = false
    @State private var showBranches = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if connected == false {
                    chip("chevron.left.forwardslash.chevron.right", "Connect GitHub to work on a repository") {
                        Task {
                            do { await UIApplication.shared.open(try await GitHubApi.startUrl()) } catch { self.error = error.localizedDescription }
                        }
                    }
                } else if connected == true {
                    chip("chevron.left.forwardslash.chevron.right", vm.buildRepo?.repo ?? "New project · or pick a repository") { showRepos = true }
                    if let pick = vm.buildRepo {
                        chip("arrow.triangle.branch", pick.branch) { showBranches = true }
                        Button { vm.buildRepo = nil } label: { Image(systemName: "xmark").font(.system(size: 11)).foregroundColor(FridayColor.muted) }
                    }
                }
                Spacer()
            }
            if let error { Text(error).font(.system(size: 12)).foregroundColor(FridayColor.error) }
        }
        .task { connected = await GitHubApi.isConnected() }
        .sheet(isPresented: $showRepos) { RepoSheet { repo in vm.buildRepo = repo.map { (repo: $0.fullName, branch: $0.defaultBranch) }; showRepos = false } }
        .sheet(isPresented: $showBranches) {
            if let pick = vm.buildRepo {
                BranchSheet(repo: pick.repo, current: pick.branch) { b in vm.buildRepo = (repo: pick.repo, branch: b); showBranches = false }
            }
        }
    }

    private func chip(_ icon: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 11))
                Text(label).font(.system(size: 12.5)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 9))
            }
            .foregroundColor(FridayColor.text)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(FridayColor.surface).cornerRadius(10)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(FridayColor.hairline, lineWidth: 1))
        }
    }
}

private struct RepoSheet: View {
    let onPick: (GitHubApi.Repo?) -> Void
    @State private var query = ""
    @State private var repos: [GitHubApi.Repo]?
    @State private var error: String?
    @State private var newName = ""
    @State private var isPrivate = true
    @State private var creating = false

    var body: some View {
        NavigationStack {
            List {
                Button("New project (no repository)") { onPick(nil) }
                if let error { Text(error).foregroundColor(FridayColor.error).font(.system(size: 13)) }
                if repos == nil && error == nil { ProgressView() }
                ForEach(repos ?? []) { r in
                    Button { onPick(r) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.fullName).foregroundColor(FridayColor.text)
                                if let d = r.description, !d.isEmpty { Text(d).font(.system(size: 12)).foregroundColor(FridayColor.muted).lineLimit(1) }
                            }
                            Spacer()
                            if r.isPrivate { Image(systemName: "lock.fill").font(.system(size: 11)).foregroundColor(FridayColor.muted) }
                        }
                    }
                }
                Section("Create a new repository") {
                    TextField("new-repository-name", text: $newName).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("Private", isOn: $isPrivate)
                    Button(creating ? "Creating…" : "Create") {
                        creating = true
                        Task {
                            do { onPick(try await GitHubApi.createRepo(name: newName.trimmingCharacters(in: .whitespaces), isPrivate: isPrivate)) } catch { self.error = error.localizedDescription }
                            creating = false
                        }
                    }
                    .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty || creating)
                }
            }
            .searchable(text: $query, prompt: "Search your repositories")
            .navigationTitle("Repository")
            .navigationBarTitleDisplayMode(.inline)
            .task(id: query) {
                try? await Task.sleep(nanoseconds: 250_000_000)
                do { repos = try await GitHubApi.repos(query: query); error = nil } catch { self.error = error.localizedDescription }
            }
        }
    }
}

private struct BranchSheet: View {
    let repo: String
    let current: String
    let onPick: (String) -> Void
    @State private var branches: [String]?
    @State private var query = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        let name = query.trimmingCharacters(in: .whitespaces)
        NavigationStack {
            List {
                if let error { Text(error).foregroundColor(FridayColor.error).font(.system(size: 13)) }
                if branches == nil && error == nil { ProgressView() }
                ForEach((branches ?? []).filter { name.isEmpty || $0.localizedCaseInsensitiveContains(name) }, id: \.self) { b in
                    Button { onPick(b) } label: {
                        HStack {
                            Text(b).font(.system(size: 14, design: .monospaced)).foregroundColor(FridayColor.text)
                            Spacer()
                            if b == current { Image(systemName: "checkmark") }
                        }
                    }
                }
                if !name.isEmpty, let branches, !branches.contains(name) {
                    Button(busy ? "Creating…" : "Create branch \(name) from \(current)") {
                        busy = true
                        Task {
                            do {
                                try await GitHubApi.createBranch(repo: repo, branch: name, from: current)
                                onPick(name)
                            } catch { self.error = error.localizedDescription }
                            busy = false
                        }
                    }
                    .disabled(busy)
                }
            }
            .searchable(text: $query, prompt: "Find or create a branch")
            .navigationTitle("Branch")
            .navigationBarTitleDisplayMode(.inline)
            .task { do { branches = try await GitHubApi.branches(repo: repo) } catch { self.error = error.localizedDescription } }
        }
    }
}
