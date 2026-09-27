import Foundation
import SwiftUI

@MainActor
final class FridayViewModel: ObservableObject {
    // Identity / session
    @Published var user: FridayUser?
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
                next.append(existing)
            } else {
                next.append(ChatThread(id: s.id, title: s.title))
            }
        }
        // A chat being created/streamed locally isn't on the server list yet — dropping it would orphan the stream.
        for local in chats where streamJobs[local.id] != nil && !next.contains(where: { $0.id == local.id }) {
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
        guard chat.messages.last?.role == .user else { return }
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
        return startTurn(chatId: currentId, text: text, attachments: attachmentsForSend, modes: modesSnapshot)
    }

    func removeQueued(chatId: String, id: String) {
        queued[chatId]?.removeAll { $0.id == id }
    }

    private func startTurn(chatId: String?, text: String, attachments attachmentsForSend: [PendingAttachment], modes modesSnapshot: Set<Mode>) -> String {
        Haptics.impact(.medium)

        var localId = chatId
        if localId == nil {
            localId = "c-\(Int(Date().timeIntervalSince1970 * 1000))"
            chats.insert(ChatThread(id: localId!, title: titleFrom(text)), at: 0)
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
                realId = try await ChatApi.createConversation(mode: mode, modelId: modelId, providerSlug: providerSlug)
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
            attachments: streamAttachments
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
        case .buildMeta(let elapsedMs, let zipBytes, let zipName):
            var build = chats[ci].messages[mi].build ?? BuildInfo()
            build.elapsedMs = elapsedMs
            build.zipBytes = zipBytes
            build.zipName = zipName
            chats[ci].messages[mi].build = build
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
        let newChat = ChatThread(id: to, title: chat.title, messages: chat.messages, updatedAt: chat.updatedAt)
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
        drawerOpen = false
    }

    func selectChat(_ id: String) {
        currentId = id
        drawerOpen = false
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

    func submitCredentials(name: String, email: String, password: String, phone: String?, birthday: String?) async {
        authBusy = true
        authError = nil
        defer { authBusy = false }
        do {
            if isSignupFlow {
                try await AuthApi.signup(name: name, email: email, password: password, phone: phone, birthday: birthday)
            } else {
                try await AuthApi.login(email: email, password: password)
            }
            authEmail = email
            authStep = .otp
        } catch {
            authError = error.localizedDescription
        }
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
