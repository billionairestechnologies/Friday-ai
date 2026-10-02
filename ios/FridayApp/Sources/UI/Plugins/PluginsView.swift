import SwiftUI

/// Brand colour per plugin (same as web's PLUGIN_COLORS). GitHub, Notion, Railway and Vercel are monochrome
/// brands, so they stay in the text colour.
private func pluginColor(_ id: String) -> Color? {
    switch id {
    case "supabase": return Color(hex: 0x3ECF8E)
    case "razorpay": return Color(hex: 0x3395FF)
    case "calendar": return Color(hex: 0x4285F4)
    case "gmail": return Color(hex: 0xEA4335)
    case "drive": return Color(hex: 0x1FA463)
    case "box": return Color(hex: 0x0061D5)
    case "canva": return Color(hex: 0x00C4CC)
    case "finance": return Color(hex: 0x10B981)
    default: return nil
    }
}

/// The plugin's mark in its tinted tile — the real brand paths (asset catalog, same as web); Razorpay / Canva /
/// Finance have no public mark, so a monogram / generic icon, never a faked logo.
struct PluginTile: View {
    let id: String
    var size: CGFloat = 38

    var body: some View {
        let color = pluginColor(id) ?? FridayColor.text
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28).fill(pluginColor(id).map { $0.opacity(0.12) } ?? FridayColor.chip)
            switch id {
            case "razorpay": Text("R").font(.system(size: size * 0.46, weight: .heavy)).foregroundColor(color)
            case "canva": Text("C").font(.system(size: size * 0.46, weight: .bold)).foregroundColor(color)
            case "finance": Image(systemName: "building.columns").font(.system(size: size * 0.44)).foregroundColor(color)
            default:
                Image("plugin_\(id)").renderingMode(.template).resizable().scaledToFit()
                    .frame(width: size * 0.52, height: size * 0.52).foregroundColor(color)
            }
        }
        .frame(width: size, height: size)
    }
}

/// Plugins: connectors by category (real connect / disconnect / preview from the backend) and Skills — the same
/// two tabs as the web's Plugins drawer.
struct PluginsSheet: View {
    @EnvironmentObject var vm: FridayViewModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = "connectors"
    @State private var query = ""
    @State private var specs: [String: ConnectorSpec] = [:]
    @State private var accounts: [ConnectorAccount] = []
    @State private var loaded = false
    @State private var active: PluginItem?

    private var signedIn: Bool { vm.user != nil }

    private func provider(for plugin: PluginItem) -> String? {
        specs.first(where: { $0.value.pluginIds.contains(plugin.id) })?.key
    }

    private func isConnected(_ plugin: PluginItem) -> Bool {
        guard let p = provider(for: plugin) else { return false }
        return accounts.contains { $0.provider == p }
    }

    private var matches: [PluginItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return FEATURED_PLUGINS.filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.desc.lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $tab) {
                    Text("Connectors").tag("connectors")
                    Text("Skills").tag("skills")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16).padding(.top, 12)

                if tab == "connectors" {
                    TextField("Search…", text: $query)
                        .padding(10).background(FridayColor.surface).cornerRadius(10)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                    connectors
                } else {
                    SkillsList(onUse: { skill in
                        vm.activeSkill = ActiveSkill(id: skill.id, name: skill.name, icon: skill.icon)
                        vm.sheet = .none
                    })
                }
            }
            .background(FridayColor.bg.ignoresSafeArea())
            .navigationTitle("Plugins")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { vm.sheet = .none } } }
        }
        .task(id: scenePhase) { if scenePhase == .active { await load() } }
        .sheet(item: $active) { plugin in
            PluginDetail(plugin: plugin, provider: provider(for: plugin), spec: provider(for: plugin).flatMap { specs[$0] }, account: provider(for: plugin).flatMap { p in accounts.first { $0.provider == p } }) {
                Task { await load() }
            }
        }
    }

    @ViewBuilder private var connectors: some View {
        if !signedIn {
            Text("Log in to connect your apps.").font(.system(size: 14)).foregroundColor(FridayColor.muted).padding(20)
            Spacer()
        } else if !loaded {
            ProgressView().frame(maxWidth: .infinity).padding(40)
            Spacer()
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    let connected = matches.filter { isConnected($0) }
                    if !connected.isEmpty {
                        section("Connected", connected)
                    }
                    ForEach(PLUGIN_CATEGORIES, id: \.self) { category in
                        let items = matches.filter { $0.category == category && !isConnected($0) }
                        if !items.isEmpty { section(category, items) }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            }
        }
    }

    private func section(_ title: String, _ items: [PluginItem]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundColor(FridayColor.text)
            ForEach(items) { p in
                Button { active = p } label: {
                    HStack(spacing: 12) {
                        PluginTile(id: p.id)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(p.name).font(.system(size: 15, weight: .medium)).foregroundColor(FridayColor.text)
                            Text(accountLabel(p) ?? p.desc).font(.system(size: 12.5)).foregroundColor(FridayColor.muted).lineLimit(1)
                        }
                        Spacer()
                        Text(isConnected(p) ? "On" : "Add").font(.system(size: 12.5))
                            .foregroundColor(isConnected(p) ? FridayColor.text : FridayColor.muted)
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .overlay(Capsule().stroke(FridayColor.hairline, lineWidth: 1))
                            .background(isConnected(p) ? FridayColor.chip : Color.clear).clipShape(Capsule())
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    private func accountLabel(_ p: PluginItem) -> String? {
        guard let prov = provider(for: p) else { return nil }
        return accounts.first { $0.provider == prov }?.accountLogin
    }

    private func load() async {
        guard signedIn else { loaded = true; return }
        async let c = try? PluginsApi.config()
        async let a = try? PluginsApi.accounts()
        if let cfg = await c { specs = cfg }
        if let acc = await a { accounts = acc }
        loaded = true
    }
}

private struct PluginDetail: View {
    @Environment(\.dismiss) private var dismiss
    let plugin: PluginItem
    let provider: String?
    let spec: ConnectorSpec?
    let account: ConnectorAccount?
    let onChanged: () -> Void
    @State private var values: [String: String] = [:]
    @State private var busy = false
    @State private var notice: String?
    @State private var preview: [ConnectorPreviewItem] = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 12) {
                        PluginTile(id: plugin.id, size: 48)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(plugin.name).font(.system(size: 18, weight: .semibold)).foregroundColor(FridayColor.text)
                            Text(plugin.desc).font(.system(size: 13.5)).foregroundColor(FridayColor.muted)
                        }
                    }
                    if let notice { Text(notice).font(.system(size: 13.5)).foregroundColor(FridayColor.muted) }
                    if let account, let provider {
                        Text("Connected as \(account.accountLogin ?? "your account").").font(.system(size: 14)).foregroundColor(FridayColor.text)
                        ForEach(preview) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(.system(size: 14)).foregroundColor(FridayColor.text)
                                if let s = item.subtitle { Text(s).font(.system(size: 12)).foregroundColor(FridayColor.muted) }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading).padding(10).background(FridayColor.chip).cornerRadius(10)
                        }
                        Button { Task { await disconnect(provider) } } label: {
                            Text("Disconnect").font(.system(size: 14)).foregroundColor(FridayColor.text)
                                .padding(.horizontal, 16).padding(.vertical, 9).overlay(Capsule().stroke(FridayColor.hairline, lineWidth: 1))
                        }.disabled(busy)
                    } else if let spec, let provider {
                        if spec.mode == "oauth" {
                            Text(spec.configured ? "Connect \(plugin.name) with a secure sign-in in your browser. Come back here when you are done." : "\(plugin.name) sign-in isn't set up yet.")
                                .font(.system(size: 14)).foregroundColor(FridayColor.muted)
                            Button { Task { await startOAuth(provider) } } label: {
                                Text("Connect \(plugin.name)").font(.system(size: 14.5, weight: .semibold)).foregroundColor(FridayColor.bg)
                                    .padding(.horizontal, 18).padding(.vertical, 10).background(FridayColor.text).clipShape(Capsule())
                            }.disabled(busy || !spec.configured)
                        } else {
                            ForEach(spec.fields, id: \.key) { f in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(f.label).font(.system(size: 12.5)).foregroundColor(FridayColor.muted)
                                    Group {
                                        if f.secret { SecureField(f.placeholder ?? "", text: binding(f.key)) } else { TextField(f.placeholder ?? "", text: binding(f.key)) }
                                    }
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .padding(10).background(FridayColor.surface).cornerRadius(10)
                                }
                            }
                            Button { Task { await connect(provider) } } label: {
                                Text(busy ? "Connecting…" : "Connect").font(.system(size: 14.5, weight: .semibold)).foregroundColor(FridayColor.bg)
                                    .padding(.horizontal, 18).padding(.vertical, 10).background(FridayColor.text).clipShape(Capsule())
                            }.disabled(busy)
                        }
                    } else {
                        Text("This plugin isn't available yet.").font(.system(size: 14)).foregroundColor(FridayColor.muted)
                    }
                }
                .padding(20)
            }
            .background(FridayColor.bg.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task(id: account?.id) {
                if let provider, account != nil { preview = (try? await PluginsApi.preview(provider: provider)) ?? [] } else { preview = [] }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { values[key] ?? "" }, set: { values[key] = $0 })
    }

    private func startOAuth(_ provider: String) async {
        busy = true; defer { busy = false }
        do {
            let url = try await PluginsApi.oauthStart(provider: provider)
            await UIApplication.shared.open(url)
        } catch { notice = "Couldn't start the sign-in. Try again." }
    }

    private func connect(_ provider: String) async {
        busy = true; defer { busy = false }
        do {
            try await PluginsApi.connect(provider: provider, values: values)
            values = [:]
            notice = "Connected."
            onChanged()
        } catch ApiError.http(_, let msg) { notice = msg } catch { notice = "Couldn't connect. Check the details and try again." }
    }

    private func disconnect(_ provider: String) async {
        busy = true; defer { busy = false }
        do { try await PluginsApi.disconnect(provider: provider); notice = "Disconnected."; onChanged() } catch { notice = "Couldn't disconnect." }
    }
}
