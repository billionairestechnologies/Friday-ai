import SwiftUI

/// Skills: Friday's built-in expert playbooks plus the user's own. "Use in chat" pins one to the next message;
/// otherwise Friday loads a matching enabled skill by itself. (Creating custom skills is on the web.)
struct SkillsScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var categories: [String] = []
    @State private var skills: [Skill]?
    @State private var failed = false
    @State private var query = ""

    private func grouped() -> [(String, [Skill])] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let visible = (skills ?? []).filter { q.isEmpty || ($0.name + " " + $0.description).lowercased().contains(q) }
        return categories.map { c in (c, visible.filter { $0.category == c }) }.filter { !$0.1.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Skills").font(.system(size: 22, weight: .medium)).foregroundColor(FridayColor.text)
                    Text("Expert playbooks Friday can use").font(.system(size: 13)).foregroundColor(FridayColor.muted)
                }
                Spacer()
                Button { vm.page = "chat" } label: { Image(systemName: "xmark").foregroundColor(FridayColor.text).padding(8) }
            }
            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 8)

            TextField("Search skills", text: $query)
                .padding(10).background(FridayColor.surface).cornerRadius(10)
                .padding(.horizontal, 16).padding(.bottom, 8)

            if skills != nil {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(grouped(), id: \.0) { category, items in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(category).font(.system(size: 12, weight: .medium)).foregroundColor(FridayColor.muted)
                                ForEach(items) { s in row(s) }
                            }
                        }
                    }
                    .padding(.horizontal, 16).padding(.bottom, 24)
                }
            } else if failed {
                Button("Couldn't load skills — tap to retry") { Task { await load() } }
                    .font(.system(size: 14)).foregroundColor(FridayColor.muted).padding(20)
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(40)
            }
            Spacer(minLength: 0)
        }
        .background(FridayColor.bg.ignoresSafeArea())
        .task { await load() }
    }

    private func row(_ s: Skill) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Text(s.icon).font(.system(size: 20))
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.name).font(.system(size: 15, weight: .medium)).foregroundColor(FridayColor.text)
                    Text(s.description).font(.system(size: 12.5)).foregroundColor(FridayColor.muted)
                }
                Spacer(minLength: 8)
                Toggle("", isOn: Binding(get: { s.enabled }, set: { toggle(s, $0) })).labelsHidden()
            }
            if s.enabled {
                Button {
                    vm.activeSkill = ActiveSkill(id: s.id, name: s.name, icon: s.icon)
                    vm.page = "chat"
                } label: {
                    Text("Use in chat").font(.system(size: 13, weight: .medium)).foregroundColor(FridayColor.bg)
                        .padding(.horizontal, 12).padding(.vertical, 6).background(FridayColor.text).clipShape(Capsule())
                }
            }
        }
        .padding(12).background(FridayColor.surface).cornerRadius(12)
    }

    private func toggle(_ s: Skill, _ on: Bool) {
        if let i = skills?.firstIndex(where: { $0.id == s.id }) { skills?[i].enabled = on }
        Task {
            do { try await SkillsApi.setEnabled(id: s.id, enabled: on) }
            catch { await load() }
        }
    }

    private func load() async {
        do {
            let r = try await SkillsApi.list()
            categories = r.categories
            skills = r.skills
            failed = false
        } catch {
            if skills == nil { failed = true }
        }
    }
}

/// The pinned skill shown above the composer until the next message is sent.
struct ActiveSkillChip: View {
    @EnvironmentObject var vm: FridayViewModel

    var body: some View {
        if let skill = vm.activeSkill {
            HStack(spacing: 6) {
                Text(skill.icon)
                Text("Skill:").foregroundColor(FridayColor.muted)
                Text(skill.name).foregroundColor(FridayColor.text)
                Button { vm.activeSkill = nil } label: { Image(systemName: "xmark").font(.system(size: 11)).foregroundColor(FridayColor.muted) }
            }
            .font(.system(size: 12.5))
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(FridayColor.chip).clipShape(Capsule())
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
