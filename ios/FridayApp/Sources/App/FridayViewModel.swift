import Foundation
import SwiftUI

@MainActor
final class FridayViewModel: ObservableObject {
    // Must exactly match backend/src/services/policyService.ts's POLICY_VERSION and
    // frontend/src/lib/site/legal.ts's POLICY_VERSION — compared against the signed-in
    // account's FridayUser.policyVersion to decide whether PolicyConsentGate blocks the app.
    static let policyVersion = "2026-09-29"

    // Identity / session
    @Published var user: FridayUser?
    @Published var policyAcceptBusy = false
    @Published var policyAcceptError: String?
    @Published var authRequired = false
    @Published var authStep: AuthStep = .form
    @Published var authEmail = ""
    @Published var authBusy = false
    @Published var authError: String?
    @Published var isSignupFlow = false

    // Chats
    @Published var chats: [ChatThread] = []
    @Published var currentId: String?
    @Published var draft: String = ""
    @Published var modes: Set<Mode> = []
    @Published var pendingAttachments: [PendingAttachment] = []
    @Published var attachmentError: String?
    /// Messages typed while a reply was still generating, per chat id. They send one at a time,
    /// in order, as each turn finishes.
    @Published var queued: [String: [QueuedMessage]] = [:]

    // Models
    @Published var remoteModels: [RemoteModel] = []
    @Published var selectedModelId: String = AUTO_MODEL_ID

    // Navigation / UI
    @Published var page: String = "chat"
    /// "chat" or "build" — which workspace the main screen is in. Build Mode only runs in "build"
    /// (a new chat there is created as a Build session); the drawer lists that workspace's history.
    @Published var workspace: String = "chat"
    /// Build home + drawer: every build session with its live status (GET /api/build/sessions).
    @Published var buildSessions: [BuildSessionSummary] = []
    @Published var buildSessionsLoaded = false
    @Published var buildSessionsError: String?
    /// Build composer effort picker: low | medium | high (remembered on this device).
    @Published var buildEffort: String = UserDefaults.standard.string(forKey: "friday.build.effort") ?? "medium" {
        didSet { UserDefaults.standard.set(buildEffort, forKey: "friday.build.effort") }
    }

    /// Build permission mode: full_auto | auto_edit | ask (remembered on this device).
    @Published var buildPermissionMode: String = UserDefaults.standard.string(forKey: "friday.build.permissionMode") ?? "full_auto" {
        didSet { UserDefaults.standard.set(buildPermissionMode, forKey: "friday.build.permissionMode") }
    }
    /// Pending Build permission prompts per chat id (from the live stream or polled from the server).
    @Published var approvals: [String: [BuildApproval]] = [:]
    @Published var approvalError: String?
    /// Build: ids of user messages with a restore point, per chat id.
    @Published var checkpoints: [String: Set<String>] = [:]
    /// Build home: the GitHub repo + branch a new build should work on (nil = a new project).
    @Published var buildRepo: (repo: String, branch: String)?
    @Published var restoreError: String?

    func loadCheckpoints(_ chatId: String) async {
        guard UUID(uuidString: chatId) != nil, let ids = try? await BuildApi.checkpoints(conversationId: chatId) else { return }
        checkpoints[chatId] = ids
    }

    /// "Restore to before this message" — then reloads the rewound conversation.
    func restore(to messageId: String) async {
        guard let chatId = currentId else { return }
        do {
            try await BuildApi.restore(conversationId: chatId, messageId: messageId)
            restoreError = nil
            if let messages = try? await ConversationsApi.messages(conversationId: chatId),
               let idx = chats.firstIndex(where: { $0.id == chatId }) {
                chats[idx].messages = messages
            }
            await loadCheckpoints(chatId)
            await loadBuildSessions()
        } catch {
            restoreError = "Couldn't restore: \(error.localizedDescription)"
        }
    }

    private func upsertApproval(_ chatId: String, _ a: BuildApproval) {
        var list = (approvals[chatId] ?? []).filter { $0.id != a.id }
        if a.state == "pending" { list.append(a) }
        approvals[chatId] = list
    }

    /// Allow / Deny / Allow all for this build on the open chat's pending prompt.
    func answerApproval(_ decision: String) async {
        guard let chatId = currentId, let a = approvals[chatId]?.last else { return }
        do {
            try await BuildApi.approve(conversationId: chatId, id: a.id, decision: decision)
            var done = a
            done.state = decision == "deny" ? "denied" : "allowed"
            upsertApproval(chatId, done)
            approvalError = nil
        } catch {
            approvalError = "Couldn't send your answer: \(error.localizedDescription)"
        }
    }

    /// A build started on another device (or before the app restarted) can be waiting on a prompt:
    /// poll for it while the open build session is running / waiting and this device isn't streaming.
    func pollApprovals() async {
        guard let chatId = currentId, streamJobs[chatId] == nil, UUID(uuidString: chatId) != nil else { return }
        let status = buildSessions.first(where: { $0.id == chatId })?.status
        guard status == "running" || status == "needs_input" else { return }
        if let list = try? await BuildApi.approvals(conversationId: chatId) { approvals[chatId] = list }
    }

    private var resumeTask: Task<Void, Never>?

    /// Build live resume: the open build is running with no stream on this device (started on another
    /// device, or before the app restarted) — replay its event log into a live message and follow it
    /// until it ends, then load the saved result. Only starts once the server confirms it's running.
    func resumeBuildIfRunning() {
        guard let chatId = currentId else { return }
        let status = buildSessions.first(where: { $0.id == chatId })?.status
        guard status == "running" || status == "needs_input" else { return }
        followRunningTurn(chatId: chatId, initialStatus: "building", isBuild: true) { id, after in
            try await BuildApi.events(conversationId: id, after: after)
        }
    }

    /// Background turns: a normal chat reply keeps running on the server after the app is closed or the device
    /// changes. Opening that chat (or returning to the app) re-attaches to it live, same as the web.
    func resumeChatIfRunning() {
        guard workspace != "build", let chatId = currentId else { return }
        followRunningTurn(chatId: chatId, initialStatus: "thinking", isBuild: false) { id, after in
            try await ConversationsApi.live(conversationId: id, after: after)
        }
    }

    private func followRunningTurn(
        chatId: String,
        initialStatus: String,
        isBuild: Bool,
        fetch: @escaping (String, Int) async throws -> (events: [(Int, [String: Any])], running: Bool)
    ) {
        guard UUID(uuidString: chatId) != nil, streamJobs[chatId] == nil, resumeTask == nil else { return }
        resumeTask = Task { [weak self] in
            guard let self else { return }
            defer { self.resumeTask = nil }
            let parser = FrameParser()
            let asstId = "resume-\(UUID().uuidString)"
            var after = 0
            var started = false
            while !Task.isCancelled {
                if let page = try? await fetch(chatId, after) {
                    if !started {
                        if !page.running { break }
                        started = true
                        var msg = ChatMessage(id: asstId, role: .assistant)
                        msg.isStreaming = true
                        msg.status = initialStatus
                        if let idx = chats.firstIndex(where: { $0.id == chatId }) { chats[idx].messages.append(msg) }
                    }
                    for (id, frame) in page.events {
                        after = id
                        if let ev = parser.parse(frame) { apply(event: ev, chatId: chatId, assistantMessageId: asstId) }
                    }
                    if !page.running && page.events.isEmpty { break }
                }
                if currentId != chatId { break }
                try? await Task.sleep(nanoseconds: 1_200_000_000)
            }
            if started {
                if let messages = try? await ConversationsApi.messages(conversationId: chatId),
                   let idx = chats.firstIndex(where: { $0.id == chatId }) {
                    chats[idx].messages = messages
                }
                if isBuild { await loadBuildSessions() }
            }
        }
    }

    /// Refreshes the Build home / drawer statuses. A failure keeps the last list and says so.
    func loadBuildSessions() async {
        guard TokenStore.shared.hasSession() else { return }
        do {
            buildSessions = try await BuildApi.sessions()
            buildSessionsError = nil
        } catch {
            buildSessionsError = "Couldn't load your builds — tap to retry."
        }
        buildSessionsLoaded = true
    }
    @Published var drawerOpen = false
    /// Bumped to ask the composer to grab focus (swipe-up on the start screen opens the keyboard).
    @Published var composerFocusTick = 0
    /// Assistant messages whose Build Mode preview URL was produced live on this device.
    @Published var freshBuildMessageIds: Set<String> = []
    @Published var sheet: SheetState = .none
    @Published var playEntrance = true
    @Published var canvasOpen = false
    @Published var voiceModeOpen = false

    // Plan / usage
    @Published var plan: String = TokenStore.shared.hasSession() ? (TokenStore.shared.plan ?? "free") : "free"
    /// False until the plan is known (cached or fetched) — gates the "Upgrade" button so a paid user never sees it flash.
    @Published var planLoaded: Bool = TokenStore.shared.hasSession() && TokenStore.shared.plan != nil
    @Published var updateInfo: UpdateApi.Info?
    /// Unseen "What's new" product updates (shown once, then marked seen server-side).
    @Published var announcements: [Announcement] = []
    private var announcementsLoaded = false

    // Voice preference (device-level, survives logout)
    @Published var voiceId: String?
    @Published var voiceName: String?

    private var streamJobs: [String: Task<Void, Never>] = [:]
    // Model last applied to each server conversation, so a send only PATCHes it when the picker
    // actually changed. Unknown (e.g. a conversation loaded from the drawer) → PATCH once.
    private var conversationModels: [String: String] = [:]
    private let currentVersion = "1.0.0"

    @Published var dismissedAskIds: Set<String> = []

    /// Pending Build Mode questions: the latest message is an assistant ask nobody answered yet.
    var pendingAsk: (messageId: String, questions: [BuildAskQuestion])? {
        guard let last = currentChat?.messages.last, last.role == .assistant, !last.isStreaming,
              let ask = last.build?.ask, !ask.isEmpty, !dismissedAskIds.contains(last.id) else { return nil }
        return (last.id, ask)
    }

    var currentChat: ChatThread? {
        chats.first { $0.id == currentId }
    }

    var isStreamingCurrent: Bool {
        guard let id = currentId else { return false }
        return streamJobs[id] != nil
    }

    // MARK: - Bootstrap

    func bootstrap() async {
        voiceId = TokenStore.shared.voiceId
        voiceName = TokenStore.shared.voiceName

        await RealtimeClient.shared.configure(
            onConversationsChanged: { [weak self] in Task { await self?.syncConversations() } },
            onMessagesChanged: { [weak self] convId in Task { await self?.refreshMessages(convId) } }
        )

        if TokenStore.shared.hasSession() {
            // Optimistic cached identity, then verify.
            if let name = TokenStore.shared.userName, let email = TokenStore.shared.userEmail {
                user = FridayUser(name: name, email: email)
            }
            do {
                let me = try await AuthApi.me()
                user = me
                TokenStore.shared.userName = me.name
                TokenStore.shared.userEmail = me.email
                await refreshPlan()
                await loadAnnouncements()
                await syncConversations()
                await connectRealtime()
            } catch {
                TokenStore.shared.logout()
                user = nil
            }
        }

        async let modelsLoad: Void = loadModels()
        async let updateCheck: Void = checkForUpdate()
        _ = await (modelsLoad, updateCheck)
    }

    private func loadModels() async {
        remoteModels = (try? await ModelsApi.list()) ?? []
        if remoteModels.contains(where: { $0.modelId == "claude-sonnet-5" }) {
            selectedModelId = "claude-sonnet-5"
        } else if let first = remoteModels.first {
            selectedModelId = first.modelId
        }
    }

    private func checkForUpdate() async {
        updateInfo = await UpdateApi.check(currentVersion: currentVersion)
    }

    private func connectRealtime() async {
        guard let token = TokenStore.shared.accessToken, let userId = user?.id, !userId.isEmpty else { return }
        // Must be the Supabase auth.users.id (not email) — it's what the `conversations` table's
        // user_id column holds, and RealtimeClient filters postgres_changes on `user_id=eq.<userId>`.
        // Passing email here silently dropped every conversation INSERT/UPDATE event (only
        // unfiltered DELETE and unfiltered messages events ever matched).
        await RealtimeClient.shared.connect(userId: userId, accessToken: token)
    }

    func syncConversations() async {
        guard let summaries = try? await ConversationsApi.list() else { return }
        var next: [ChatThread] = []
        for s in summaries {
            if var existing = chats.first(where: { $0.id == s.id }) {
                existing.title = s.title
                existing.workspace = s.workspace ?? existing.workspace
                existing.hasBuild = s.hasBuild
                next.append(existing)
            } else {
                next.append(ChatThread(id: s.id, title: s.title, workspace: s.workspace, hasBuild: s.hasBuild))
            }
        }
        // A chat being created/streamed locally isn't on the server list yet — dropping it would orphan the stream.
        for local in chats where (streamJobs[local.id] != nil || projectChatIds.contains(local.id)) && !next.contains(where: { $0.id == local.id }) {
            next.insert(local, at: 0)
        }
        chats = next
    }

    /// Called when the app returns to the foreground (see FridayAppApp's scenePhase observer).
    /// Picks up anything that happened while backgrounded — a scheduled automation's reply, a
    /// message sent from another device — the same gap [selectChat] closes when a screen first
    /// opens. `refreshMessages` already no-ops while this device has its own stream in flight.
    func onAppForegrounded() async {
        guard TokenStore.shared.hasSession() else { return }
        await syncConversations()
        guard let id = currentId, let chat = chats.first(where: { $0.id == id }) else { return }
        let last = chat.messages.last
        guard last?.role == .user || last?.disconnected == true else { return }
        await refreshMessages(id)
    }

    private func refreshMessages(_ conversationId: String) async {
        // Own in-flight write wins over another device's echoed write.
        guard streamJobs[conversationId] == nil else { return }
        // The conversation may not be in the local list yet (e.g. a brand-new automation chat, or
        // this realtime event beat the conversations sync) — without this, the lookup below is a
        // silent no-op and the event is dropped for good.
        if !chats.contains(where: { $0.id == conversationId }) {
            await syncConversations()
        }
        guard let messages = try? await ConversationsApi.messages(conversationId: conversationId) else { return }
        guard let idx = chats.firstIndex(where: { $0.id == conversationId }) else { return }
        chats[idx].messages = messages
    }

    // MARK: - Sending

    /// `override` sends text without touching the composer's draft/attachments (used by Voice Mode).
    /// Returns the new assistant message's id, or nil if nothing was sent.
    @discardableResult
    func send(text override: String? = nil) -> String? {
        let text = (override ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || (override == nil && !pendingAttachments.isEmpty) else { return nil }

        guard TokenStore.shared.hasSession() else {
            authRequired = true
            return nil
        }

        let attachmentsForSend = override == nil ? pendingAttachments : []
        let modesSnapshot = override == nil ? modes : []

        // A reply is still generating in this chat: park the message in the queue instead of
        // dropping it. It sends automatically, in order, once the current turn finishes.
        if let id = currentId, streamJobs[id] != nil {
            guard override == nil else { return nil }
            queued[id, default: []].append(QueuedMessage(id: UUID().uuidString, text: text, attachments: attachmentsForSend, modes: modesSnapshot))
            draft = ""
            pendingAttachments = []
            Haptics.impact(.light)
            return nil
        }

        if override == nil {
            draft = ""
            pendingAttachments = []
        }
        // A new build with a repo picked: say which repo + branch the way the backend recognises it
        // (it clones github.com/owner/repo/tree/<branch> before the agent starts).
        var content = text
        if currentId == nil, workspace == "build", let pick = buildRepo, !text.contains("github.com/") {
            content = "Work on https://github.com/\(pick.repo)/tree/\(pick.branch) (branch \(pick.branch)) — \(text)"
            buildRepo = nil
        }
        return startTurn(chatId: currentId, text: content, attachments: attachmentsForSend, modes: modesSnapshot)
    }

    func removeQueued(chatId: String, id: String) {
        queued[chatId]?.removeAll { $0.id == id }
    }

    private func startTurn(chatId: String?, text: String, attachments attachmentsForSend: [PendingAttachment], modes modesSnapshot: Set<Mode>) -> String {
        Haptics.impact(.medium)

        var localId = chatId
        if localId == nil {
            localId = "c-\(Int(Date().timeIntervalSince1970 * 1000))"
            chats.insert(ChatThread(id: localId!, title: titleFrom(text), workspace: workspace == "build" ? "build" : nil), at: 0)
            currentId = localId
        }
        let workingId = localId!

        let userMsg = ChatMessage(id: UUID().uuidString, role: .user, content: text, attachments: attachmentsForSend)
        var assistantMsg = ChatMessage(id: UUID().uuidString, role: .assistant)
        assistantMsg.isStreaming = true
        assistantMsg.modesUsed = modesSnapshot

        if let idx = chats.firstIndex(where: { $0.id == workingId }) {
            chats[idx].messages.append(userMsg)
            chats[idx].messages.append(assistantMsg)
        }

        let job = Task { [weak self] () -> Void in
            await self?.runSend(
                localId: workingId, content: text, attachments: attachmentsForSend,
                modes: modesSnapshot, assistantMessageId: assistantMsg.id
            )
        }
        streamJobs[workingId] = job
        return assistantMsg.id
    }

    private func runSend(localId: String, content: String, attachments: [PendingAttachment], modes: Set<Mode>, assistantMessageId: String) async {
        var finalId: String?
        defer {
            streamJobs[localId] = nil
            if let finalId { streamJobs[finalId] = nil }
            let doneId = finalId ?? localId
            if let next = queued[doneId]?.first, TokenStore.shared.hasSession() {
                queued[doneId]?.removeFirst()
                _ = startTurn(chatId: doneId, text: next.text, attachments: next.attachments, modes: next.modes)
            }
        }

        let mode: String = selectedModelId == AUTO_MODEL_ID ? "auto" : (selectedModelId == TEAMUP_MODEL_ID ? "teamup" : "single")
        let modelId = mode == "single" ? selectedModelId : nil
        let providerSlug = mode == "single" ? remoteModels.first(where: { $0.modelId == selectedModelId })?.providerSlug : nil

        // Reuse the chat's server conversation once it has one. This used to create a brand-new
        // conversation on EVERY send, so the backend (which builds the model's context from that
        // conversation's saved messages) only ever saw the current message — a follow-up like
        // "the name is Stockbricks" got "what can I do for you?" with no memory of the request.
        var realId: String
        do {
            if UUID(uuidString: localId) != nil {
                realId = localId
                if conversationModels[localId] != selectedModelId {
                    // Best-effort: on failure the reply just comes from the previous model.
                    if (try? await ChatApi.updateConversation(
                        id: localId, mode: mode, modelId: modelId, providerSlug: providerSlug
                    )) != nil {
                        conversationModels[localId] = selectedModelId
                    }
                }
            } else {
                let chatWorkspace = chats.first(where: { $0.id == localId })?.workspace
                let projectId = activeProjectId
                realId = try await ChatApi.createConversation(mode: mode, modelId: modelId, providerSlug: providerSlug, workspace: chatWorkspace, projectId: projectId)
                if projectId != nil { projectChatIds.insert(realId); activeProjectId = nil }
                conversationModels[realId] = selectedModelId
            }
        } catch {
            appendError(localId: localId, assistantMessageId: assistantMessageId, message: "Couldn't start the conversation: \(error.localizedDescription)")
            return
        }

        finalId = realId
        if realId != localId {
            swapChatId(from: localId, to: realId)
            if let job = streamJobs[localId] {
                streamJobs[realId] = job
                streamJobs[localId] = nil
            }
        }

        let streamAttachments = attachments.map {
            ChatApi.StreamAttachment(mime: $0.mime, dataUrl: $0.dataUrl, name: $0.name, size: $0.size, kind: $0.kind)
        }

        let stream = ChatApi.streamMessage(
            conversationId: realId, content: content,
            think: modes.contains(.think), webSearch: modes.contains(.search), canvas: modes.contains(.canvas),
            research: modes.contains(.research),
            attachments: streamAttachments,
            effort: chats.first(where: { $0.id == realId })?.workspace == "build" ? buildEffort : nil,
            permissionMode: chats.first(where: { $0.id == realId })?.workspace == "build" ? buildPermissionMode : nil
        )

        do {
            for try await event in stream {
                if Task.isCancelled { break }
                apply(event: event, chatId: realId, assistantMessageId: assistantMessageId)
            }
        } catch {
            appendError(localId: realId, assistantMessageId: assistantMessageId, message: "Connection lost: \(error.localizedDescription)")
        }
        setStreaming(false, chatId: realId, assistantMessageId: assistantMessageId)
        if chats.first(where: { $0.id == realId })?.isBuild == true {
            await loadBuildSessions()
            await loadCheckpoints(realId)
        }
    }

    private func apply(event: ChatEvent, chatId: String, assistantMessageId: String) {
        guard let ci = chats.firstIndex(where: { $0.id == chatId }),
              let mi = chats[ci].messages.firstIndex(where: { $0.id == assistantMessageId }) else { return }
        switch event {
        case .status(let s):
            chats[ci].messages[mi].status = s
            // "building" = Build Mode started: keep a BuildInfo so the start-up banner stays up until the first step exists.
            if s == "building", chats[ci].messages[mi].build == nil { chats[ci].messages[mi].build = BuildInfo() }
        case .think(let t):
            chats[ci].messages[mi].reasoning = t
        case .text(let t):
            chats[ci].messages[mi].content = t
        case .cite(let title, let url):
            chats[ci].messages[mi].sources.append(Source(title: title, url: url))
        case .err(let msg):
            chats[ci].messages[mi].content += "\n\n" + msg
        case .agent(let status):
            if let ai = chats[ci].messages[mi].agents.firstIndex(where: { $0.slug == status.slug && $0.model == status.model }) {
                chats[ci].messages[mi].agents[ai] = status
            } else {
                chats[ci].messages[mi].agents.append(status)
            }
        case .step(let step):
            var build = chats[ci].messages[mi].build ?? BuildInfo()
            if let i = build.steps.firstIndex(where: { $0.id == step.id }) { build.steps[i] = step } else { build.steps.append(step) }
            chats[ci].messages[mi].build = build
        case .preview(let url, let port):
            var build = chats[ci].messages[mi].build ?? BuildInfo()
            build.previewUrl = url
            build.port = port
            chats[ci].messages[mi].build = build
            // This device watched it stream in → the URL is known-good (no restore round-trip), and
            // the panel opens on the running app.
            freshBuildMessageIds.insert(assistantMessageId)
            withAnimation(.spring(response: 0.26, dampingFraction: 0.88)) { canvasOpen = true }
        case .plan(let plan):
            var build = chats[ci].messages[mi].build ?? BuildInfo()
            build.plan = plan
            chats[ci].messages[mi].build = build
        case .ask(let questions):
            var build = chats[ci].messages[mi].build ?? BuildInfo()
            build.ask = questions
            chats[ci].messages[mi].build = build
        case .suggestBuild(let prompt):
            chats[ci].messages[mi].suggestBuildPrompt = prompt.isEmpty ? nil : prompt
        case .approval(let a):
            upsertApproval(chatId, a)
        case .meta(let userMessageId):
            // Swap the optimistic id of this turn's user message (just before the assistant one).
            if mi > 0, chats[ci].messages[mi - 1].role == .user {
                let old = chats[ci].messages[mi - 1]
                chats[ci].messages[mi - 1] = ChatMessage(id: userMessageId, role: .user, content: old.content, attachments: old.attachments)
            }
        case .buildMeta(let elapsedMs, let zipBytes, let zipName):
            var build = chats[ci].messages[mi].build ?? BuildInfo()
            build.elapsedMs = elapsedMs
            build.zipBytes = zipBytes
            build.zipName = zipName
            chats[ci].messages[mi].build = build
        case .disconnected:
            chats[ci].messages[mi].disconnected = true
        case .done:
            chats[ci].messages[mi].isStreaming = false
        }
    }

    private func appendError(localId: String, assistantMessageId: String, message: String) {
        guard let ci = chats.firstIndex(where: { $0.id == localId }),
              let mi = chats[ci].messages.firstIndex(where: { $0.id == assistantMessageId }) else { return }
        chats[ci].messages[mi].content += (chats[ci].messages[mi].content.isEmpty ? "" : "\n\n") + message
        chats[ci].messages[mi].isStreaming = false
    }

    private func setStreaming(_ streaming: Bool, chatId: String, assistantMessageId: String) {
        guard let ci = chats.firstIndex(where: { $0.id == chatId }),
              let mi = chats[ci].messages.firstIndex(where: { $0.id == assistantMessageId }) else { return }
        chats[ci].messages[mi].isStreaming = streaming
    }

    private func swapChatId(from: String, to: String) {
        chats.removeAll { $0.id == to }
        guard let idx = chats.firstIndex(where: { $0.id == from }) else { return }
        var chat = chats[idx]
        let newChat = ChatThread(id: to, title: chat.title, messages: chat.messages, updatedAt: chat.updatedAt, workspace: chat.workspace, hasBuild: chat.hasBuild)
        chats[idx] = newChat
        if let q = queued[from] { queued[from] = nil; queued[to] = q }
        if currentId == from { currentId = to }
        _ = chat // avoid unused warning
    }

    func stop() {
        guard let id = currentId, let job = streamJobs[id] else { return }
        job.cancel()
        streamJobs[id] = nil
        // The server keeps generating after a disconnect, so cancelling the local stream isn't
        // enough — tell it to stop too.
        if UUID(uuidString: id) != nil { Task { await ChatApi.stop(conversationId: id) } }
        if let ci = chats.firstIndex(where: { $0.id == id }) {
            if let mi = chats[ci].messages.lastIndex(where: { $0.role == .assistant }) {
                chats[ci].messages[mi].isStreaming = false
            }
        }
    }

    func newChat() {
        currentId = nil
        activeProjectId = nil
        drawerOpen = false
        workspace = "chat"
    }

    /// The project the NEXT new chat belongs to (set by "New chat in this project", cleared once it exists).
    @Published var activeProjectId: String?
    /// Chats that live inside a project: the main chat list never includes them, so the list sync must keep them.
    private var projectChatIds: Set<String> = []

    func startProjectChat(_ projectId: String) {
        currentId = nil
        workspace = "chat"
        activeProjectId = projectId
        page = "chat"
    }

    func openProjectChat(_ summary: ConversationsApi.Summary) {
        if !chats.contains(where: { $0.id == summary.id }) {
            chats.append(ChatThread(id: summary.id, title: summary.title, workspace: summary.workspace, hasBuild: summary.hasBuild))
        }
        projectChatIds.insert(summary.id)
        page = "chat"
        selectChat(summary.id)
    }

    /// Opens the Build workspace on a fresh build session (created on the first send).
    func newBuild() {
        currentId = nil
        drawerOpen = false
        workspace = "build"
        Task { await loadBuildSessions() }
    }

    /// "Open in Build" under a normal-chat reply: a fresh Build session starting with that request.
    /// Sending it only starts the question/plan round — nothing is built until the plan is approved.
    func openInBuild(_ prompt: String) {
        newBuild()
        page = "chat"
        send(text: prompt)
    }

    /// The newest message of the open chat, when it's a Build plan waiting for approve / changes.
    var pendingPlanMessage: ChatMessage? {
        guard let id = currentId, let last = chats.first(where: { $0.id == id })?.messages.last,
              last.role == .assistant, !last.isStreaming, last.build?.plan?.status == "pending" else { return nil }
        return last
    }

    /// "Approve & build" on a pending plan: mark it approved locally (the server does too) and go.
    func approvePlan() {
        guard let id = currentId, let pending = pendingPlanMessage,
              let ci = chats.firstIndex(where: { $0.id == id }),
              let mi = chats[ci].messages.firstIndex(where: { $0.id == pending.id }) else { return }
        chats[ci].messages[mi].build?.plan?.status = "approved"
        send(text: planApproveText)
    }

    func selectChat(_ id: String) {
        currentId = id
        drawerOpen = false
        workspace = chats.first(where: { $0.id == id })?.workspace == "build" ? "build" : "chat"
        if chats.first(where: { $0.id == id })?.isBuild == true { Task { await loadCheckpoints(id) } }
        // Nothing else loads a synced chat's history on open — without this, a chat only ever
        // gets messages if a realtime event happens to arrive while this screen is on screen.
        guard UUID(uuidString: id) != nil, streamJobs[id] == nil else { return }
        Task { await refreshMessages(id) }
    }

    func deleteChat(_ id: String) {
        chats.removeAll { $0.id == id }
        if currentId == id { currentId = nil }
        streamJobs[id]?.cancel()
        streamJobs[id] = nil
        queued[id] = nil
        guard UUID(uuidString: id) != nil else { return }
        Task {
            do {
                try await ConversationsApi.delete(conversationId: id)
            } catch {
                // The delete didn't reach the server — resync so the chat visibly comes back
                // instead of silently reappearing later, and tell the user.
                await syncConversations()
                attachmentError = "Couldn't delete that chat — check your connection."
            }
        }
    }

    func toggleMode(_ mode: Mode) {
        Haptics.impact(.light)
        if modes.contains(mode) { modes.remove(mode) } else { modes.insert(mode) }
        if mode == .canvas { canvasOpen = modes.contains(.canvas) }
    }

    // MARK: - Auth

    func startAuth(signup: Bool) {
        isSignupFlow = signup
        authStep = .form
        authError = nil
        sheet = signup ? .signup : .welcome
    }

    func submitCredentials(name: String, email: String, password: String, phone: String?, birthday: String?, acceptedTerms: Bool) async {
        if isSignupFlow && !acceptedTerms {
            authError = "You must agree to the Terms of Service and Privacy Policy to continue."
            return
        }
        authBusy = true
        authError = nil
        defer { authBusy = false }
        do {
            if isSignupFlow {
                try await AuthApi.signup(name: name, email: email, password: password, phone: phone, birthday: birthday, acceptedTerms: acceptedTerms)
            } else {
                try await AuthApi.login(email: email, password: password)
            }
            authEmail = email
            authStep = .otp
        } catch {
            authError = error.localizedDescription
        }
    }

    /// PolicyConsentGate's "I Agree" button — records acceptance and closes the gate.
    func acceptPolicy() async {
        policyAcceptBusy = true
        policyAcceptError = nil
        defer { policyAcceptBusy = false }
        do {
            user = try await AuthApi.acceptPolicy()
            await loadAnnouncements()
        } catch {
            policyAcceptError = error.localizedDescription
        }
    }

    /// Once per app session, and only after the current policy is accepted (the gate comes first).
    func loadAnnouncements() async {
        guard !announcementsLoaded, user?.policyVersion == Self.policyVersion else { return }
        announcementsLoaded = true
        let pending = await EngagementApi.pending()
        if !pending.isEmpty { announcements = pending }
    }

    func dismissAnnouncements(clickedId: String? = nil) async {
        let ids = announcements.map(\.id)
        announcements = []
        if !ids.isEmpty { await EngagementApi.markSeen(ids: ids, clickedId: clickedId) }
    }

    func resendOtp() async {
        authError = nil
        do { try await AuthApi.resendOtp(email: authEmail) } catch { authError = error.localizedDescription }
    }

    func verifyOtp(code: String) async {
        authBusy = true
        authError = nil
        defer { authBusy = false }
        do {
            let result = try await AuthApi.verifyOtp(email: authEmail, code: code)
            TokenStore.shared.saveSession(access: result.session.accessToken, refresh: result.session.refreshToken)
            TokenStore.shared.userName = result.user.name
            TokenStore.shared.userEmail = result.user.email
            user = result.user
            authRequired = false
            sheet = .none
            await refreshPlan()
            await loadAnnouncements()
            await syncConversations()
            await connectRealtime()
        } catch {
            authError = error.localizedDescription
        }
    }

    func completeOAuth(fragment: String) async {
        guard let result = AuthApi.decodeOAuthCallback(fragment: fragment) else {
            authError = "Sign-in response couldn't be read. Please try again."
            return
        }
        TokenStore.shared.saveSession(access: result.session.accessToken, refresh: result.session.refreshToken)
        TokenStore.shared.userName = result.user.name
        TokenStore.shared.userEmail = result.user.email
        user = result.user
        authRequired = false
        sheet = .none
        await refreshPlan()
        await loadAnnouncements()
        await syncConversations()
        await connectRealtime()
    }

    func refreshPlan() async {
        if let p = (try? await UsageApi.quota())?.plan?.lowercased(), !p.isEmpty {
            plan = p
            planLoaded = true
            TokenStore.shared.plan = p
        }
    }

    func logout() async {
        announcementsLoaded = false
        announcements = []
        queued = [:]
        for (_, job) in streamJobs { job.cancel() }
        streamJobs.removeAll()
        await AuthApi.logout()
        TokenStore.shared.logout()
        await RealtimeClient.shared.disconnect()
        user = nil
        plan = "free"
        planLoaded = false
        chats = []
        currentId = nil
        page = "chat"
    }

    // MARK: - Attachments

    func addAttachment(_ attachment: PendingAttachment) {
        guard pendingAttachments.count < 4 else {
            attachmentError = "You can attach up to 4 files."
            return
        }
        guard attachment.size <= 10 * 1024 * 1024 else {
            attachmentError = "Files must be under 10MB."
            return
        }
        pendingAttachments.append(attachment)
    }

    func removeAttachment(_ id: String) {
        pendingAttachments.removeAll { $0.id == id }
    }

    // MARK: - Voice preference

    func setVoice(id: String, name: String) {
        voiceId = id
        voiceName = name
        TokenStore.shared.voiceId = id
        TokenStore.shared.voiceName = name
    }
}

enum Haptics {
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        DispatchQueue.main.async {
            UIImpactFeedbackGenerator(style: style).impactOccurred()
        }
    }
}

struct QueuedMessage: Identifiable {
    let id: String
    let text: String
    let attachments: [PendingAttachment]
    let modes: Set<Mode>
}
