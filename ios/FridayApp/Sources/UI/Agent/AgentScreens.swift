import SwiftUI

// MARK: - Shared bits

private struct AgentCard<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(FridayColor.bg)
            .cornerRadius(16)
    }
}

private struct PillButton: View {
    let label: String
    var filled = true
    var danger = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label).font(.system(size: 14, weight: .medium))
                .foregroundColor(filled ? FridayColor.bg : (danger ? FridayColor.error : FridayColor.text))
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(filled ? (danger ? FridayColor.error : FridayColor.text) : FridayColor.surface)
                .clipShape(Capsule())
                .opacity(disabled ? 0.4 : 1)
        }
        .disabled(disabled)
    }
}

private struct AgentField: View {
    let label: String
    @Binding var text: String
    var multiline = false

    var body: some View {
        Group {
            if multiline {
                TextField(label, text: $text, axis: .vertical).lineLimit(3...6)
            } else {
                TextField(label, text: $text)
            }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled(!multiline)
        .font(.system(size: 15))
        .padding(12)
        .background(FridayColor.surface)
        .cornerRadius(10)
    }
}

private func errorLine(_ message: String?) -> some View {
    Group {
        if let message { Text(message).font(.system(size: 13)).foregroundColor(FridayColor.error) }
    }
}

// MARK: - Memory (Settings > Memory)

struct MemoryContent: View {
    @State private var items: [MemoryItem]?
    @State private var error: String?
    @State private var draft = ""
    @State private var confirmClear = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Facts Friday keeps across chats. Ask it to \"remember …\" in a conversation, or add one here.")
                .font(.system(size: 13.5)).foregroundColor(FridayColor.muted)
            AgentCard {
                AgentField(label: "Add a memory", text: $draft, multiline: true)
                HStack {
                    Spacer()
                    PillButton(label: "Save", disabled: draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            do { try await AgentApi.addMemory(text); draft = ""; await reload() }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                }
            }
            errorLine(error)
            if let items {
                if items.isEmpty {
                    Text("Nothing remembered yet.").font(.system(size: 14)).foregroundColor(FridayColor.muted)
                } else {
                    ForEach(items) { m in
                        AgentCard {
                            Text(m.content).font(.system(size: 14.5)).foregroundColor(FridayColor.text)
                            Button("Forget") {
                                Task {
                                    do { try await AgentApi.deleteMemory(id: m.id); await reload() }
                                    catch { self.error = error.localizedDescription }
                                }
                            }
                            .font(.system(size: 13, weight: .medium)).foregroundColor(FridayColor.error)
                        }
                    }
                    PillButton(label: "Clear all memories", filled: false, danger: true) { confirmClear = true }
                }
            } else {
                Text("Loading…").font(.system(size: 14)).foregroundColor(FridayColor.muted)
            }
        }
        .task { await reload() }
        .alert("Clear all memories?", isPresented: $confirmClear) {
            Button("Clear", role: .destructive) {
                Task {
                    do { try await AgentApi.clearMemories(); await reload() }
                    catch { self.error = error.localizedDescription }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Friday will forget everything it saved about you. This can't be undone.") }
    }

    private func reload() async {
        do { items = try await AgentApi.memories(); error = nil }
        catch { self.error = error.localizedDescription; if items == nil { items = [] } }
    }
}

// MARK: - MCP servers (Settings > MCP servers)

struct ConnectorsContent: View {
    @State private var servers: [McpServer]?
    @State private var error: String?
    @State private var notice: String?
    @State private var name = ""
    @State private var url = ""
    @State private var auth = ""
    @State private var adding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect a remote MCP server (https) and Friday can use its tools in chat.")
                .font(.system(size: 13.5)).foregroundColor(FridayColor.muted)
            AgentCard {
                AgentField(label: "Name", text: $name)
                AgentField(label: "Server URL (https://…)", text: $url)
                AgentField(label: "Authorization header (optional)", text: $auth)
                HStack {
                    Spacer()
                    PillButton(
                        label: adding ? "Connecting…" : "Connect",
                        disabled: adding || name.trimmingCharacters(in: .whitespaces).isEmpty || url.trimmingCharacters(in: .whitespaces).isEmpty
                    ) {
                        adding = true; error = nil; notice = nil
                        Task {
                            do {
                                let tools = try await AgentApi.addMcpServer(
                                    name: name.trimmingCharacters(in: .whitespaces), url: url.trimmingCharacters(in: .whitespaces),
                                    authorization: auth.trimmingCharacters(in: .whitespaces)
                                )
                                notice = "Connected — \(tools.count) tools available."
                                name = ""; url = ""; auth = ""
                                await reload()
                            } catch { self.error = error.localizedDescription }
                            adding = false
                        }
                    }
                }
            }
            errorLine(error)
            if let notice { Text(notice).font(.system(size: 13)).foregroundColor(FridayColor.success) }
            if let servers {
                if servers.isEmpty {
                    Text("No servers connected.").font(.system(size: 14)).foregroundColor(FridayColor.muted)
                }
                ForEach(servers) { s in
                    AgentCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.name).font(.system(size: 15.5, weight: .medium)).foregroundColor(FridayColor.text)
                                Text(s.url).font(.system(size: 12.5)).foregroundColor(FridayColor.muted).lineLimit(1).truncationMode(.middle)
                            }
                            Spacer()
                            Toggle("", isOn: Binding(get: { s.enabled }, set: { on in
                                Task {
                                    do { try await AgentApi.setMcpEnabled(id: s.id, enabled: on) }
                                    catch { self.error = error.localizedDescription }
                                    await reload()
                                }
                            })).labelsHidden()
                        }
                        Button("Remove") {
                            Task {
                                do { try await AgentApi.deleteMcpServer(id: s.id); await reload() }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                        .font(.system(size: 13, weight: .medium)).foregroundColor(FridayColor.error)
                    }
                }
            } else {
                Text("Loading…").font(.system(size: 14)).foregroundColor(FridayColor.muted)
            }
        }
        .task { await reload() }
    }

    private func reload() async {
        do { servers = try await AgentApi.mcpServers() }
        catch { self.error = error.localizedDescription; if servers == nil { servers = [] } }
    }
}

// MARK: - Automations (full page, replaces the "coming soon" stub)

private let automationFrequencies: [(id: String, label: String)] = [
    ("hourly", "Hourly"), ("daily", "Daily"), ("weekdays", "Weekdays"), ("weekly", "Weekly"),
]
private let weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

private func describe(_ a: Automation) -> String {
    let label = automationFrequencies.first { $0.id == a.frequency }?.label ?? a.frequency
    let base: String
    switch a.frequency {
    case "hourly": base = "Every hour"
    case "weekly": base = "\(label) on \(weekdayNames[min(max(a.weekday ?? 0, 0), 6)]) at \(a.timeOfDay)"
    default: base = "\(label) at \(a.timeOfDay)"
    }
    return base + (a.research ? " · Deep Research" : "")
}

struct AutomationsScreen: View {
    @EnvironmentObject var vm: FridayViewModel
    @State private var items: [Automation]?
    @State private var error: String?
    @State private var notice: String?
    @State private var creating = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Automations").font(.system(size: 20, weight: .semibold)).foregroundColor(FridayColor.text)
                Spacer()
                PillButton(label: "New") { creating = true }
                Button { vm.page = "chat" } label: {
                    Image(systemName: "xmark").foregroundColor(FridayColor.text).frame(width: 34, height: 34)
                        .background(FridayColor.bg).clipShape(Circle())
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Friday runs these prompts on a schedule and notifies you with the result.")
                        .font(.system(size: 13.5)).foregroundColor(FridayColor.muted)
                    errorLine(error)
                    if let notice { Text(notice).font(.system(size: 13)).foregroundColor(FridayColor.success) }
                    if let items {
                        if items.isEmpty {
                            Text("No automations yet. Tap New to schedule one.").font(.system(size: 14)).foregroundColor(FridayColor.muted)
                        }
                        ForEach(items) { a in card(a) }
                    } else {
                        Text("Loading…").font(.system(size: 14)).foregroundColor(FridayColor.muted)
                    }
                }
                .padding(16)
            }
        }
        .background(FridayColor.sidebar.ignoresSafeArea())
        .task { await reload() }
        .sheet(isPresented: $creating) { NewAutomationSheet { await reload() } }
    }

    private func card(_ a: Automation) -> some View {
        AgentCard {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(a.title).font(.system(size: 16, weight: .medium)).foregroundColor(FridayColor.text)
                    Text(describe(a)).font(.system(size: 12.5)).foregroundColor(FridayColor.muted)
                }
                Spacer()
                Toggle("", isOn: Binding(get: { a.enabled }, set: { on in
                    Task {
                        do { try await AgentApi.setAutomationEnabled(id: a.id, enabled: on) }
                        catch { self.error = error.localizedDescription }
                        await reload()
                    }
                })).labelsHidden()
            }
            Text(a.prompt).font(.system(size: 13.5)).foregroundColor(FridayColor.text).lineLimit(3)
            if a.lastStatus == "error" {
                Text("Last run failed" + (a.lastError.map { ": \($0)" } ?? "")).font(.system(size: 12.5)).foregroundColor(FridayColor.error)
            }
            HStack(spacing: 8) {
                PillButton(label: "Run now", filled: false) {
                    error = nil
                    Task {
                        do {
                            try await AgentApi.runAutomation(id: a.id)
                            notice = "Started “\(a.title)”. You'll get a notification when it's done."
                            await reload()
                        } catch { self.error = error.localizedDescription }
                    }
                }
                if let cid = a.conversationId {
                    PillButton(label: "Open chat", filled: false) { vm.selectChat(cid); vm.page = "chat" }
                }
                PillButton(label: "Delete", filled: false, danger: true) {
                    Task {
                        do { try await AgentApi.deleteAutomation(id: a.id); await reload() }
                        catch { self.error = error.localizedDescription }
                    }
                }
            }
        }
    }

    private func reload() async {
        do { items = try await AgentApi.automations(); error = nil }
        catch { self.error = error.localizedDescription; if items == nil { items = [] } }
    }
}

private struct NewAutomationSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreated: () async -> Void

    @State private var title = ""
    @State private var prompt = ""
    @State private var frequency = "daily"
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var weekday = 1
    @State private var research = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                    TextField("What should Friday do?", text: $prompt, axis: .vertical).lineLimit(3...8)
                }
                Section("Repeat") {
                    Picker("Frequency", selection: $frequency) {
                        ForEach(automationFrequencies, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    if frequency == "weekly" {
                        Picker("Day", selection: $weekday) {
                            ForEach(0..<7, id: \.self) { Text(weekdayNames[$0]).tag($0) }
                        }
                    }
                    if frequency != "hourly" {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    }
                    Toggle("Use Deep Research", isOn: $research)
                }
                if let error { Section { Text(error).foregroundColor(FridayColor.error) } }
            }
            .navigationTitle("New automation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Create") { save() }
                        .disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func save() {
        saving = true; error = nil
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        f.locale = Locale(identifier: "en_US_POSIX")
        let hhmm = f.string(from: time)
        Task {
            do {
                try await AgentApi.createAutomation(
                    title: title.trimmingCharacters(in: .whitespaces), prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    frequency: frequency, timeOfDay: hhmm, weekday: frequency == "weekly" ? weekday : nil, research: research
                )
                await onCreated()
                dismiss()
            } catch { self.error = error.localizedDescription }
            saving = false
        }
    }
}
