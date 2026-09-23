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

    // Models
    @Published var remoteModels: [RemoteModel] = []
    @Published var selectedModelId: String = AUTO_MODEL_ID

    // Navigation / UI
    @Published var page: String = "chat"
    @Published var drawerOpen = false
    @Published var sheet: SheetState = .none
    @Published var playEntrance = true
    @Published var canvasOpen = false
    @Published var voiceModeOpen = false

    // Plan / usage
    @Published var plan: String = "free"
    @Published var updateInfo: UpdateApi.Info?

    // Voice preference (device-level, survives logout)
    @Published var voiceId: String?
    @Published var voiceName: String?

    private var streamJobs: [String: Task<Void, Never>] = [:]
    private let currentVersion = "1.0.0"

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
        guard let token = TokenStore.shared.accessToken else { return }
        // userId isn't exposed by /auth/me in this port; realtime connect is
        // keyed by whatever id the backend embeds in the JWT server-side —
        // for the mobile-auth-bridge flow the same token authenticates the
        // socket regardless, so we pass email as a stable local key.
        await RealtimeClient.shared.connect(userId: user?.email ?? "", accessToken: token)
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

    private func refreshMessages(_ conversationId: String) async {
        // Own in-flight write wins over another device's echoed write.
        guard streamJobs[conversationId] == nil else { return }
        guard let messages = try? await ConversationsApi.messages(conversationId: conversationId) else { return }
        guard let idx = chats.firstIndex(where: { $0.id == conversationId }) else { return }
        chats[idx].messages = messages
    }

    // MARK: - Sending

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pendingAttachments.isEmpty else { return }
        if let id = currentId, streamJobs[id] != nil { return }

        guard TokenStore.shared.hasSession() else {
            authRequired = true
            return
        }

        Haptics.impact(.medium)

        let attachmentsForSend = pendingAttachments
        let modesSnapshot = modes
        draft = ""
        pendingAttachments = []

        var localId = currentId
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
    }

    private func runSend(localId: String, content: String, attachments: [PendingAttachment], modes: Set<Mode>, assistantMessageId: String) async {
        defer { streamJobs[localId] = nil }

        let mode: String = selectedModelId == AUTO_MODEL_ID ? "auto" : (selectedModelId == TEAMUP_MODEL_ID ? "teamup" : "single")
        let modelId = mode == "single" ? selectedModelId : nil
        let providerSlug = mode == "single" ? remoteModels.first(where: { $0.modelId == selectedModelId })?.providerSlug : nil

        var realId: String
        do {
            realId = try await ChatApi.createConversation(mode: mode, modelId: modelId, providerSlug: providerSlug)
        } catch {
            appendError(localId: localId, assistantMessageId: assistantMessageId, message: "Couldn't start the conversation: \(error.localizedDescription)")
            return
        }

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
        if currentId == from { currentId = to }
        _ = chat // avoid unused warning
    }

    func stop() {
        guard let id = currentId, let job = streamJobs[id] else { return }
        job.cancel()
        streamJobs[id] = nil
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
    }

    func deleteChat(_ id: String) {
        chats.removeAll { $0.id == id }
        if currentId == id { currentId = nil }
        Task { try? await ConversationsApi.delete(conversationId: id) }
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
        if let p = (try? await UsageApi.quota())?.plan?.lowercased(), !p.isEmpty { plan = p }
    }

    func logout() async {
        for (_, job) in streamJobs { job.cancel() }
        streamJobs.removeAll()
        await AuthApi.logout()
        TokenStore.shared.logout()
        await RealtimeClient.shared.disconnect()
        user = nil
        plan = "free"
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
