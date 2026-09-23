import SwiftUI

struct SettingsScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var usage: UsageQuota?
    @State private var showDeleteConfirm = false
    @State private var showClearConfirm = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header

                section("Account") {
                    row(icon: "person.circle", title: vm.user?.name ?? "Guest", value: vm.user?.email ?? "Not logged in")
                }

                section("General") {
                    row(icon: "paintbrush", title: "Appearance", value: "Light")
                    if vm.user != nil {
                        row(icon: "slider.horizontal.3", title: "Behavior", value: nil)
                        row(icon: "waveform", title: "Voice", value: vm.voiceName ?? "Default")
                    }
                    row(icon: "bell", title: "Notifications", value: nil) {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }

                if vm.user != nil {
                    section("Payments") {
                        row(icon: "creditcard", title: "Billing", value: vm.plan.capitalized) { vm.page = "plans" }
                        row(icon: "chart.bar", title: "Usage", value: nil)
                    }
                    if let usage {
                        usageCard(usage)
                    }

                    section("Friday") {
                        row(icon: "puzzlepiece.extension", title: "Plugins", value: nil) { vm.sheet = .plugins }
                    }

                    section("Data & Information") {
                        row(icon: "square.and.arrow.up", title: "Export chats", value: nil) { Task { await exportChats() } }
                        row(icon: "trash", title: "Clear all chats", value: nil, destructive: true) { showClearConfirm = true }
                        row(icon: "person.crop.circle.badge.minus", title: "Delete account", value: nil, destructive: true) { showDeleteConfirm = true }
                    }

                    Button {
                        Task { await vm.logout() }
                    } label: {
                        Text("Sign out")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(FridayColor.error)
                            .frame(maxWidth: .infinity).frame(height: 48)
                            .background(FridayColor.bg)
                            .cornerRadius(16)
                    }
                }
            }
            .padding(16)
        }
        .background(FridayColor.sidebar.ignoresSafeArea())
        .task { usage = try? await UsageApi.quota() }
        .confirmationDialog("Clear all chats?", isPresented: $showClearConfirm, titleVisibility: .visible) {
            Button("Clear all chats", role: .destructive) { Task { try? await ConversationsApi.deleteAll(); vm.chats = [] } }
        }
        .confirmationDialog("Delete account? This can't be undone.", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete account", role: .destructive) { Task { try? await AuthApi.deleteAccount(); await vm.logout() } }
        }
    }

    private var header: some View {
        ZStack {
            Text("Settings").font(.system(size: 20, weight: .bold)).frame(maxWidth: .infinity)
            HStack {
                Button { vm.page = "chat" } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(FridayColor.text)
                        .frame(width: 36, height: 36)
                        .background(FridayColor.bg)
                        .clipShape(Circle())
                }
                Spacer()
            }
        }
        .foregroundColor(FridayColor.text)
        .padding(.top, 4)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 12, weight: .medium)).foregroundColor(FridayColor.muted)
            VStack(spacing: 0) { content() }
                .background(FridayColor.bg)
                .cornerRadius(16)
        }
    }

    private func row(icon: String, title: String, value: String?, destructive: Bool = false, action: (() -> Void)? = nil) -> some View {
        Button { action?() } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).frame(width: 22).foregroundColor(destructive ? FridayColor.error : FridayColor.text)
                Text(title).font(.system(size: 15)).foregroundColor(destructive ? FridayColor.error : FridayColor.text)
                Spacer()
                if let value { Text(value).font(.system(size: 13)).foregroundColor(FridayColor.muted) }
                if action != nil { Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(FridayColor.muted) }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .disabled(action == nil)
    }

    private func usageCard(_ usage: UsageQuota) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let weekly = usage.weekly { usageRow("Weekly", weekly) }
            if let monthly = usage.monthly { usageRow("Monthly", monthly) }
            if let rolling = usage.rolling { usageRow("Rolling", rolling) }
        }
        .padding(16)
        .background(FridayColor.bg)
        .cornerRadius(16)
    }

    private func usageRow(_ label: String, _ bucket: UsageBucket) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(label) — \(bucket.used) / \(bucket.limit) · \(bucket.pct)%").font(.system(size: 12)).foregroundColor(FridayColor.muted)
            ProgressView(value: Double(bucket.used), total: Double(max(bucket.limit, 1))).tint(FridayColor.search)
        }
    }

    private func exportChats() async {
        guard let data = try? await AuthApi.exportData() else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("friday-export.json")
        try? data.write(to: url)
        await MainActor.run {
            let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first?.keyWindow?.rootViewController?.present(av, animated: true)
        }
    }
}
