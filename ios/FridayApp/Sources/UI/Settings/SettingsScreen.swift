import SwiftUI
import AVFoundation

private enum SettingsSub: String {
    case profile = "Profile", appearance = "Appearance", behavior = "Behavior", voice = "Voice"
    case billing = "Billing", usage = "Usage", dataControls = "Data Controls"
    case memory = "Memory", connectors = "MCP servers"
}

/// Drill-down Settings mirroring android SettingsScreen.kt: a home list, each row opens its own page.
struct SettingsScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var sub: SettingsSub?

    var body: some View {
        ZStack {
            FridayColor.sidebar.ignoresSafeArea()
            if let sub {
                SubPage(title: sub.rawValue, onBack: { withAnimation(.easeInOut(duration: 0.2)) { self.sub = nil } }) {
                    switch sub {
                    case .profile: ProfilePage(onSignedOut: { self.sub = nil })
                    case .appearance: AppearancePage()
                    case .behavior: BehaviorPage()
                    case .voice: VoicePage()
                    case .billing: BillingPage()
                    case .usage: UsagePage()
                    case .dataControls: DataControlsPage(onAccountDeleted: { self.sub = nil })
                    case .memory: MemoryContent()
                    case .connectors: ConnectorsContent()
                    }
                }
                .transition(.move(edge: .trailing))
            } else {
                home.transition(.opacity)
            }
        }
    }

    private var home: some View {
        VStack(spacing: 0) {
            ZStack {
                Text("Settings").font(.system(size: 17, weight: .bold)).foregroundColor(FridayColor.text)
                HStack {
                    CircleIconButton(system: "xmark") { vm.page = "chat" }
                    Spacer()
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 12).padding(.top, 0)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    SectionLabel("Account")
                    SettingsCard {
                        SettingsRow(icon: "person.crop.circle", label: vm.user?.name ?? "Guest", subtitle: vm.user?.email ?? "Not logged in") {
                            if vm.user != nil { go(.profile) } else { vm.page = "chat"; vm.startAuth(signup: false) }
                        }
                    }

                    SectionLabel("General")
                    SettingsCard {
                        SettingsRow(icon: "paintpalette", label: "Appearance", value: "Light") { go(.appearance) }
                        if vm.user != nil {
                            SettingsDivider()
                            SettingsRow(icon: "brain", label: "Behavior") { go(.behavior) }
                            SettingsDivider()
                            SettingsRow(icon: "person.wave.2", label: "Voice") { go(.voice) }
                        }
                        SettingsDivider()
                        SettingsRow(icon: "bell", label: "Notifications") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }

                    if vm.user != nil {
                        SectionLabel("Payments")
                        SettingsCard {
                            SettingsRow(icon: "creditcard", label: "Billing", value: vm.plan.capitalized) { go(.billing) }
                            SettingsDivider()
                            SettingsRow(icon: "chart.bar", label: "Usage") { go(.usage) }
                        }

                        SectionLabel("Friday")
                        SettingsCard {
                            SettingsRow(icon: "puzzlepiece.extension", label: "Plugins") { vm.page = "chat"; vm.sheet = .plugins }
                            SettingsDivider()
                            SettingsRow(icon: "brain", label: "Memory") { go(.memory) }
                            SettingsDivider()
                            SettingsRow(icon: "server.rack", label: "MCP servers") { go(.connectors) }
                        }

                        SectionLabel("Data & Information")
                        SettingsCard {
                            SettingsRow(icon: "externaldrive", label: "Data Controls") { go(.dataControls) }
                        }

                        // Support and status live on the web (same account, same tickets).
                        SectionLabel("Help")
                        SettingsCard {
                            SettingsRow(icon: "questionmark.bubble", label: "Help & support") { openWeb("/?support=contact") }
                            SettingsDivider()
                            SettingsRow(icon: "waveform.path.ecg", label: "System status") { openWeb("/status") }
                        }
                    }
                }
                .padding(16)
            }
        }
    }

    private func go(_ s: SettingsSub) { withAnimation(.easeInOut(duration: 0.2)) { sub = s } }
}

// MARK: - Scaffolding

private struct SubPage<Content: View>: View {
    let title: String
    let onBack: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(title).font(.system(size: 17, weight: .bold)).foregroundColor(FridayColor.text)
                HStack {
                    CircleIconButton(system: "chevron.left", action: onBack)
                    Spacer()
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 12).padding(.top, 0)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) { content() }
                    .padding(16)
            }
        }
        .background(FridayColor.sidebar.ignoresSafeArea())
    }
}

private struct CircleIconButton: View {
    let system: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(FridayColor.text)
                .frame(width: 36, height: 36)
                .background(FridayColor.bg)
                .clipShape(Circle())
        }
    }
}

private struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 12, weight: .medium)).foregroundColor(FridayColor.muted).padding(.leading, 8).padding(.bottom, -8)
    }
}

private struct SettingsCard<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(spacing: 0) { content() }
            .frame(maxWidth: .infinity)
            .background(FridayColor.bg)
            .cornerRadius(16)
    }
}

private struct SettingsDivider: View {
    var body: some View { Rectangle().fill(Color.black.opacity(0.08)).frame(height: 1).padding(.leading, 52) }
}

private struct SettingsRow: View {
    let icon: String
    let label: String
    var value: String? = nil
    var subtitle: String? = nil
    var tint: Color = FridayColor.text
    var showChevron: Bool = true
    var trailingCheck: Bool = false
    var action: (() -> Void)? = nil

    var body: some View {
        Button { action?() } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 17)).frame(width: 22).foregroundColor(tint)
                if let subtitle {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(label).font(.system(size: 15, weight: .medium)).foregroundColor(tint).lineLimit(1)
                        Text(subtitle).font(.system(size: 13)).foregroundColor(FridayColor.muted).lineLimit(1).truncationMode(.middle)
                    }
                } else {
                    Text(label).font(.system(size: 15)).foregroundColor(tint).lineLimit(1)
                }
                Spacer(minLength: 8)
                if let value { Text(value).font(.system(size: 13.5)).foregroundColor(FridayColor.muted).lineLimit(1) }
                if trailingCheck {
                    Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundColor(FridayColor.search)
                } else if showChevron && action != nil {
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundColor(FridayColor.muted)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

private struct EditableRow: View {
    let icon: String
    let label: String
    @Binding var text: String
    let placeholder: String
    var keyboard: UIKeyboardType = .default

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 17)).frame(width: 22).foregroundColor(FridayColor.text)
            Text(label).font(.system(size: 15)).foregroundColor(FridayColor.text).frame(width: 78, alignment: .leading)
            TextField(placeholder, text: $text)
                .font(.system(size: 14.5))
                .multilineTextAlignment(.trailing)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
    }
}

private struct BirthdayEditableRow: View {
    @Binding var value: String
    @State private var showPicker = false
    @State private var pickerDate = Date()

    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    var body: some View {
        Button {
            pickerDate = Self.isoFormatter.date(from: value) ?? pickerDate
            showPicker = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "gift").font(.system(size: 17)).frame(width: 22).foregroundColor(FridayColor.text)
                Text("Birthday").font(.system(size: 15)).foregroundColor(FridayColor.text).frame(width: 78, alignment: .leading)
                Spacer()
                Text(value.isEmpty ? "YYYY-MM-DD" : value)
                    .font(.system(size: 14.5))
                    .foregroundColor(value.isEmpty ? FridayColor.muted : FridayColor.text)
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showPicker) {
            NavigationStack {
                DatePicker("Birthday", selection: $pickerDate, in: ...Date(), displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .padding()
                    .navigationTitle("Birthday")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") {
                                value = Self.isoFormatter.string(from: pickerDate)
                                showPicker = false
                            }
                        }
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showPicker = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        }
    }
}

// MARK: - Pages

private struct ProfilePage: View {
    @EnvironmentObject var vm: FridayViewModel
    let onSignedOut: () -> Void
    @State private var phone = ""
    @State private var birthday = ""
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?

    private var dirty: Bool { phone != (vm.user?.phone ?? "") || birthday != (vm.user?.birthday ?? "") }

    var body: some View {
        SettingsCard {
            HStack(spacing: 14) {
                Circle().fill(FridayColor.surface).frame(width: 48, height: 48)
                    .overlay(Text(String((vm.user?.name ?? "?").prefix(1)).uppercased()).font(.system(size: 18, weight: .semibold)).foregroundColor(FridayColor.text))
                VStack(alignment: .leading, spacing: 2) {
                    Text(vm.user?.name ?? "Guest").font(.system(size: 16, weight: .medium)).foregroundColor(FridayColor.text)
                    Text(vm.user?.email ?? "Not logged in").font(.system(size: 13)).foregroundColor(FridayColor.muted)
                }
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 16)
        }

        SettingsCard {
            EditableRow(icon: "phone", label: "Phone", text: $phone, placeholder: "Mobile number", keyboard: .phonePad)
            SettingsDivider()
            BirthdayEditableRow(value: $birthday)
            if dirty || saving || saved || error != nil {
                HStack {
                    if let error { Text(error).font(.system(size: 12)).foregroundColor(FridayColor.error) }
                    Spacer()
                    if saving { ProgressView() }
                    else if saved && !dirty { Text("Saved").font(.system(size: 13)).foregroundColor(FridayColor.search) }
                    else { Button("Save") { Task { await save() } }.font(.system(size: 15, weight: .medium)) }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }

        SettingsCard {
            SettingsRow(icon: "rectangle.portrait.and.arrow.right", label: "Sign out", tint: FridayColor.stop, showChevron: false) {
                Task { await vm.logout(); onSignedOut() }
            }
        }
        .onAppear { phone = vm.user?.phone ?? ""; birthday = vm.user?.birthday ?? "" }
    }

    private func save() async {
        saving = true; error = nil
        do {
            _ = try await AuthApi.updateProfile(phone: phone, birthday: birthday, instructions: nil)
            if let me = try? await AuthApi.me() { vm.user = me }
            saved = true
        } catch {
            self.error = "Couldn't save: \(error.localizedDescription)"
        }
        saving = false
    }
}

private struct AppearancePage: View {
    var body: some View {
        SettingsCard {
            SettingsRow(icon: "paintpalette", label: "Light", tint: FridayColor.search, showChevron: false, trailingCheck: true)
            SettingsDivider()
            SettingsRow(icon: "paintpalette", label: "Dark", value: "Coming soon", tint: FridayColor.muted, showChevron: false)
        }
        Text("Dark mode is on the way — we'll let you know when it ships.")
            .font(.system(size: 12.5)).foregroundColor(FridayColor.muted).padding(.leading, 8)
    }
}

private struct BehaviorPage: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var instructions = ""
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?

    private var dirty: Bool { instructions != (vm.user?.instructions ?? "") }

    private var currentModelName: String {
        if vm.selectedModelId == AUTO_MODEL_ID { return "Auto" }
        if vm.selectedModelId == TEAMUP_MODEL_ID { return "Team Up" }
        return vm.remoteModels.first(where: { $0.modelId == vm.selectedModelId })?.displayName ?? "Auto"
    }

    var body: some View {
        SettingsCard {
            Menu {
                Button("Auto") { vm.selectedModelId = AUTO_MODEL_ID }
                Button("Team Up") { vm.selectedModelId = TEAMUP_MODEL_ID }
                ForEach(vm.remoteModels) { m in
                    if ModelBrand.planSatisfies(vm.plan, minTier: m.minTier) {
                        Button(m.displayName) { vm.selectedModelId = m.modelId }
                    }
                }
            } label: {
                SettingsRow(icon: "brain", label: "Default model", value: currentModelName, action: {})
                    .allowsHitTesting(false)
            }
        }

        SectionLabel("Custom instructions")
        SettingsCard {
            ZStack(alignment: .topLeading) {
                if instructions.isEmpty {
                    Text("How should Friday respond? Tone, formatting, things to avoid…")
                        .font(.system(size: 14.5)).foregroundColor(FridayColor.muted)
                        .padding(.horizontal, 19).padding(.vertical, 22)
                }
                TextEditor(text: $instructions)
                    .font(.system(size: 14.5))
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 120)
                    .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }
        HStack {
            Text(error ?? (saving ? "Saving…" : (saved && !dirty ? "Saved" : "Applies to every new chat.")))
                .font(.system(size: 12))
                .foregroundColor(error != nil ? FridayColor.error : (saved && !dirty ? FridayColor.search : FridayColor.muted))
                .padding(.leading, 8)
            Spacer()
            if dirty && !saving {
                Button("Save") { Task { await save() } }.font(.system(size: 15, weight: .medium))
            }
        }
        .onAppear { instructions = vm.user?.instructions ?? "" }
    }

    private func save() async {
        saving = true; error = nil
        do {
            _ = try await AuthApi.updateProfile(phone: nil, birthday: nil, instructions: instructions)
            if let me = try? await AuthApi.me() { vm.user = me }
            saved = true
        } catch {
            self.error = "Couldn't save: \(error.localizedDescription)"
        }
        saving = false
    }
}

@MainActor
private final class VoicePreviewPlayer: ObservableObject {
    @Published var playingId: String?
    private var player: AVAudioPlayer?

    func play(_ voice: Voice) async -> String? {
        guard playingId == nil else { return nil }
        playingId = voice.id
        defer { playingId = nil }
        do {
            let data = try await VoiceApi.speak(text: "Hi, this is Friday.", voiceId: voice.id)
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            try? AVAudioSession.sharedInstance().setActive(true)
            player = try AVAudioPlayer(data: data)
            player?.play()
            while player?.isPlaying == true { try? await Task.sleep(nanoseconds: 150_000_000) }
            return nil
        } catch {
            return "Couldn't play preview: \(error.localizedDescription)"
        }
    }
}

private struct VoicePage: View {
    @EnvironmentObject var vm: FridayViewModel
    @StateObject private var preview = VoicePreviewPlayer()
    @State private var voices: [Voice] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        SettingsCard {
            if loading {
                ProgressView().frame(maxWidth: .infinity).padding(20)
            } else if voices.isEmpty {
                SettingsRow(icon: "brain", label: "No voices available", showChevron: false)
            } else {
                ForEach(Array(voices.enumerated()), id: \.element.id) { i, voice in
                    if i > 0 { SettingsDivider() }
                    HStack(spacing: 12) {
                        Circle().fill(vm.voiceId == voice.id ? FridayColor.search : FridayColor.surface).frame(width: 20, height: 20)
                        Text(voice.name).font(.system(size: 15)).foregroundColor(FridayColor.text)
                        Spacer()
                        Button {
                            Task { error = await preview.play(voice) }
                        } label: {
                            Image(systemName: preview.playingId == voice.id ? "pause.fill" : "play.fill")
                                .font(.system(size: 15)).foregroundColor(FridayColor.muted).frame(width: 32, height: 32)
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .contentShape(Rectangle())
                    .onTapGesture { vm.setVoice(id: voice.id, name: voice.name) }
                }
            }
        }
        if let error { Text(error).font(.system(size: 12)).foregroundColor(FridayColor.error).padding(.leading, 8) }
        Color.clear.frame(height: 1)
            .task {
                do { voices = try await VoiceApi.voices() } catch { self.error = "Couldn't load voices: \(error.localizedDescription)" }
                if (vm.voiceId ?? "").isEmpty, let first = voices.first { vm.setVoice(id: first.id, name: first.name) }
                loading = false
            }
    }
}

private struct BillingPage: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var orders: [BillingOrder] = []

    var body: some View {
        SettingsCard {
            HStack(spacing: 12) {
                Image(systemName: "creditcard").font(.system(size: 17)).frame(width: 22)
                Text(vm.plan.capitalized).font(.system(size: 15, weight: .medium))
                Spacer()
                Text("Current plan").font(.system(size: 11.5, weight: .medium)).foregroundColor(FridayColor.search)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(FridayColor.search.opacity(0.12)).clipShape(Capsule())
            }
            .foregroundColor(FridayColor.text)
            .padding(.horizontal, 14).padding(.vertical, 13)
            SettingsDivider()
            SettingsRow(icon: "arrow.up.right.square", label: vm.plan == "free" ? "Upgrade to Premium" : "Manage subscription") { vm.page = "plans" }
        }
        if !orders.isEmpty {
            SettingsCard {
                ForEach(Array(orders.enumerated()), id: \.element.id) { i, order in
                    if i > 0 { SettingsDivider() }
                    SettingsRow(
                        icon: "doc.text",
                        label: order.createdAt.map { String($0.prefix(10)) } ?? "—",
                        value: "\(order.plan) · \(order.status) · ₹\(Double(order.amountPaise) / 100)",
                        showChevron: false
                    )
                }
            }
        }
        Color.clear.frame(height: 1).task {
            orders = (try? await BillingApi.orders()) ?? []
            await vm.refreshPlan()
        }
    }
}

private func formatTokens(_ n: Double) -> String {
    if n >= 1_000_000 { return String(format: n.truncatingRemainder(dividingBy: 1_000_000) == 0 ? "%.0fM" : "%.1fM", n / 1_000_000) }
    if n >= 1_000 { return String(format: n.truncatingRemainder(dividingBy: 1_000) == 0 ? "%.0fK" : "%.1fK", n / 1_000) }
    return String(Int(n.rounded()))
}

private func formatReset(_ iso: String?) -> String? {
    guard let iso else { return nil }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
    let out = DateFormatter(); out.dateStyle = .medium; out.timeStyle = .short
    return "Resets \(out.string(from: d))"
}

private func usageLabel(_ type: String) -> String {
    switch type {
    case "chat_message": return "Chat"
    case "web_search": return "Search"
    case "voice_second": return "Voice"
    case "sandbox_run": return "Build"
    case "attachment_upload": return "Attachments"
    case "image_generation": return "Image generation"
    case "chat": return "Chat"
    case "build": return "Build"
    case "research": return "Deep Research"
    case "teamup": return "Team Up"
    case "spark": return "Spark"
    case "automation": return "Automations"
    default: return type
    }
}

/// Usage — the same windows as the web's Usage pane: weekly, 5-hour, monthly, organization pool and your cap, each with
/// its reset time and what used it, plus what your plan includes (all from GET /usage/quota).
private struct UsagePage: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var quota: UsageQuota?
    @State private var loading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if loading {
                ProgressView().frame(maxWidth: .infinity).padding(20)
            } else if let quota {
                HStack {
                    Text((quota.isEnterprise ? "Enterprise" : (quota.plan ?? "free").capitalized) + " plan")
                        .font(.system(size: 12.5, weight: .medium)).padding(.horizontal, 10).padding(.vertical, 4)
                        .background(FridayColor.chip).clipShape(Capsule())
                    Spacer()
                    if !quota.isEnterprise && (quota.plan ?? "free").lowercased() != "premium" {
                        Button { vm.page = "plans" } label: {
                            Text("Upgrade").font(.system(size: 12.5, weight: .semibold)).foregroundColor(FridayColor.bg)
                                .padding(.horizontal, 12).padding(.vertical, 5).background(FridayColor.text).clipShape(Capsule())
                        }
                    }
                }
                bar("Weekly Limit", quota.weekly, quota.breakdown, nil)
                if let r = quota.rolling { bar("5-Hour Limit", r, quota.rollingBreakdown, "A short rolling window on top of your weekly limit, so one burst can't use up a whole week at once.") }
                if let m = quota.monthly { bar("Monthly Limit", m, quota.monthlyBreakdown, nil) }
                if let o = quota.orgPool { bar("Organization Pool (\(quota.orgSeats) seats)", o, [], nil) }
                if let c = quota.memberCap { bar("Your Monthly Cap", c, [], "A personal sub-limit your org admin set within the shared pool.") }
                if let e = quota.entitlements { includes(e) }
            } else {
                SettingsCard { SettingsRow(icon: "chart.bar", label: "Usage unavailable", showChevron: false) }
            }
        }
        .task {
            quota = try? await UsageApi.quota()
            loading = false
        }
    }

    private func bar(_ title: String, _ bucket: UsageBucket?, _ breakdown: [UsageBreakdownEntry], _ help: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.system(size: 15, weight: .medium)).foregroundColor(FridayColor.text)
                Spacer()
                Text(bucket.map { "\($0.pct)% used" } ?? "—")
                    .font(.system(size: 13)).foregroundColor(FridayColor.muted)
            }
            if let bucket, bucket.limit > 0 {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(FridayColor.surface)
                        Capsule().fill(bucket.pct >= 90 ? FridayColor.error : FridayColor.search).frame(width: geo.size.width * CGFloat(bucket.pct) / 100)
                    }
                }
                .frame(height: 6)
            }
            if let reset = formatReset(bucket?.resetAt) { Text(reset).font(.system(size: 12)).foregroundColor(FridayColor.muted) }
            if let help { Text(help).font(.system(size: 12)).foregroundColor(FridayColor.muted) }
            if !breakdown.isEmpty {
                Text(breakdown.map { "\(usageLabel($0.type)) \(max(0, $0.percent))%" }.joined(separator: "  ·  "))
                    .font(.system(size: 12)).foregroundColor(FridayColor.muted)
            }
        }
        .padding(14).background(FridayColor.surface.opacity(0.5)).cornerRadius(14)
    }

    private func includes(_ e: PlanEntitlements) -> some View {
        let storage = e.libraryStorageMb >= 1024 ? String(format: "%.1f GB", Double(e.libraryStorageMb) / 1024) : "\(e.libraryStorageMb) MB"
        let rows: [(String, String)] = [
            ("Build Mode", e.buildMode ? "\(e.buildMaxRounds) rounds per run" : "Not included"),
            ("Deep Research", e.deepResearchPerDay > 0 ? "\(e.deepResearchPerDay) per day" : "Not included"),
            ("Documents", "\(e.documentsPerDay) per day"),
            ("Custom skills", "\(e.customSkills)"),
            ("Library storage", storage),
            ("Team Up", "Up to \(e.teamUpModels) models"),
            ("MCP servers", "\(e.mcpServers)"),
            ("Automations", "\(e.automations)"),
            ("Support", e.prioritySupport ? "Priority" : "Standard"),
        ]
        return VStack(alignment: .leading, spacing: 8) {
            Text("What your plan includes").font(.system(size: 15, weight: .semibold)).foregroundColor(FridayColor.text)
            ForEach(rows, id: \.0) { k, v in
                HStack { Text(k).foregroundColor(FridayColor.muted); Spacer(); Text(v).foregroundColor(FridayColor.text) }.font(.system(size: 13.5))
            }
        }
        .padding(14).overlay(RoundedRectangle(cornerRadius: 14).stroke(FridayColor.hairline, lineWidth: 1))
    }
}

private struct DataControlsPage: View {
    @EnvironmentObject var vm: FridayViewModel
    let onAccountDeleted: () -> Void
    @State private var exporting = false
    @State private var showClear = false
    @State private var showDelete = false
    @State private var deleting = false
    @State private var error: String?

    var body: some View {
        SettingsCard {
            SettingsRow(icon: "square.and.arrow.down", label: "Export chats", value: exporting ? "…" : nil) {
                Task { await exportChats() }
            }
            SettingsDivider()
            SettingsRow(icon: "externaldrive", label: "Clear all chats", tint: FridayColor.error, showChevron: false) { showClear = true }
        }
        SettingsCard {
            SettingsRow(icon: "trash", label: "Delete account", tint: FridayColor.error, showChevron: false) { showDelete = true }
        }
        if let error { Text(error).font(.system(size: 12)).foregroundColor(FridayColor.error).padding(.leading, 8) }
        Color.clear.frame(height: 1)
            .alert("Clear all chats?", isPresented: $showClear) {
                Button("Cancel", role: .cancel) {}
                Button("Clear", role: .destructive) {
                    Task {
                        do { try await ConversationsApi.deleteAll(); vm.chats = []; vm.currentId = nil }
                        catch { self.error = "Couldn't clear chats: \(error.localizedDescription)" }
                    }
                }
            } message: { Text("This deletes every synced conversation. This can't be undone.") }
            .alert("Delete your account?", isPresented: $showDelete) {
                Button("Cancel", role: .cancel) {}
                Button(deleting ? "Deleting…" : "Delete", role: .destructive) {
                    Task {
                        deleting = true
                        do { try await AuthApi.deleteAccount(); await vm.logout(); onAccountDeleted() }
                        catch { self.error = "Couldn't delete account: \(error.localizedDescription)" }
                        deleting = false
                    }
                }
            } message: { Text("This permanently deletes your account and all its data. This can't be undone.") }
    }

    private func exportChats() async {
        guard !exporting else { return }
        exporting = true; error = nil
        defer { exporting = false }
        do {
            let data = try await AuthApi.exportData()
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("friday-export.json")
            try data.write(to: url)
            let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first?.keyWindow?.rootViewController?.present(av, animated: true)
        } catch {
            self.error = "Couldn't export: \(error.localizedDescription)"
        }
    }
}


private func openWeb(_ path: String) {
    if let url = URL(string: "https://friday.billionairestechnologies.com" + path) { UIApplication.shared.open(url) }
}
