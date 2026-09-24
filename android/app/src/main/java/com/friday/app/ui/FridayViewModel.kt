package com.friday.app.ui

import android.app.Application
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.friday.app.data.AUTO_MODEL_ID
import com.friday.app.data.TEAMUP_MODEL_ID
import com.friday.app.data.ChatMessage
import com.friday.app.data.ChatRepository
import com.friday.app.data.ChatThread
import com.friday.app.data.ChatEvent
import com.friday.app.data.AuthStep
import com.friday.app.data.FridayUser
import com.friday.app.data.Mode
import com.friday.app.data.ModelId
import com.friday.app.data.PendingAttachment
import com.friday.app.data.Role
import com.friday.app.data.Seed
import com.friday.app.data.Sheet
import com.friday.app.data.api.ApiClient
import com.friday.app.data.api.AuthApi
import com.friday.app.data.api.AuthResult
import com.friday.app.data.api.BillingApi
import com.friday.app.data.api.BillingConfig
import com.friday.app.data.api.BillingOrderCreated
import com.friday.app.data.api.ChatApi
import com.friday.app.data.api.ConversationsApi
import com.friday.app.data.api.ModelsApi
import com.friday.app.data.api.RemoteModel
import com.friday.app.data.api.TokenStore
import com.friday.app.data.realtime.SupabaseRealtime
import com.friday.app.data.api.UpdateApi
import com.friday.app.data.api.UpdateInfo
import com.friday.app.data.api.UsageApi
import com.friday.app.data.api.VoiceApi
import com.friday.app.BuildConfig
import com.friday.app.data.nameFromEmail
import com.friday.app.data.titleFrom
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject

data class FridayUiState(
    val user: FridayUser? = null,
    val chats: List<ChatThread> = emptyList(),
    val currentId: String? = null,
    val draft: String = "",
    val modes: Set<Mode> = emptySet(),
    val model: ModelId = ModelId.Auto,
    val remoteModels: List<RemoteModel> = emptyList(),
    val selectedModelId: String? = null,
    val drawerOpen: Boolean = false,
    val sheet: Sheet = Sheet.None,
    val pluginsTab: String = "connectors",
    val playEntrance: Boolean = true,
    val authStep: AuthStep = AuthStep.Form,
    val authEmail: String = "",
    val authBusy: Boolean = false,
    val authError: String? = null,
    /** One-shot signal: guest tried to send while logged out, so the UI should route to the login page. */
    val authRequired: Boolean = false,
    /** Current billing plan (e.g. "free", "premium"), from GET /usage/quota. Null until fetched. */
    val plan: String? = null,
    /** Set when a newer app build is available server-side; null means no update (the common case). */
    val updateInfo: UpdateInfo? = null,
    /** Files staged in the composer, not yet sent — cleared once [FridayViewModel.send] fires.
     *  Capped at 4 to match the backend's per-message attachment limit. */
    val pendingAttachments: List<PendingAttachment> = emptyList(),
    val attachmentError: String? = null,
    /** Selected TTS voice for Voice Mode / spoken replies (GET /api/voice/voices id + display name). */
    val voiceId: String? = null,
    val voiceName: String? = null,
)

class FridayViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = ChatRepository()
    private val tokenStore = TokenStore(app).also { ApiClient.init(it) }
    private val vibrator = app.getSystemService(Vibrator::class.java)
    private val _state = MutableStateFlow(FridayUiState())
    val state: StateFlow<FridayUiState> = _state.asStateFlow()
    // Per-chat, not a single shared slot — one Job used to cover the whole app, so sending in a
    // second chat cancelled whatever the first chat was still streaming, and a single isGenerating
    // flag blocked sending into ANY chat while ANY other chat was generating. Reported live as
    // chats "getting stuck" when switching screens or opening a new chat mid-reply. Each chat now
    // owns its own job and can run fully independently of every other chat.
    private val streamJobs = mutableMapOf<String, Job>()
    // Model last applied to each server conversation, so a send only PATCHes the conversation when
    // the picker actually changed. Unknown (e.g. a conversation loaded from the drawer) → PATCH once.
    private val conversationModels = mutableMapOf<String, String?>()

    init {
        viewModelScope.launch {
            val models = ModelsApi.list()
            if (models.isNotEmpty()) {
                // Auto/Team Up aren't real /api/models entries (the backend picks/consults models
                // itself for those) — prepended as sentinel picks, matching the web app's own
                // AUTO_MODEL_ID/TEAMUP_MODEL_ID entries (lib/chat/models.ts's SPECIAL_MODELS).
                val special = listOf(
                    RemoteModel(AUTO_MODEL_ID, "Auto", "free", ""),
                    RemoteModel(TEAMUP_MODEL_ID, "Team Up", "free", ""),
                )
                val default = models.firstOrNull { it.modelId == "claude-sonnet-5" } ?: models.first()
                _state.update { it.copy(remoteModels = special + models, selectedModelId = default.modelId) }
            }
        }
        viewModelScope.launch {
            val info = UpdateApi.check(BuildConfig.VERSION_NAME)
            if (info != null) _state.update { it.copy(updateInfo = info) }
        }
        if (!tokenStore.voiceId.isNullOrBlank()) {
            _state.update { it.copy(voiceId = tokenStore.voiceId, voiceName = tokenStore.voiceName) }
        }
        val name = tokenStore.userName
        val email = tokenStore.userEmail
        if (tokenStore.hasSession() && !email.isNullOrBlank()) {
            _state.update { it.copy(user = FridayUser(name ?: nameFromEmail(email), email)) }
            viewModelScope.launch {
                when (val result = AuthApi.me()) {
                    is AuthResult.Success -> {
                        tokenStore.userName = result.value.name
                        tokenStore.userEmail = result.value.email
                        _state.update {
                            it.copy(
                                user = FridayUser(
                                    result.value.name.ifBlank { nameFromEmail(result.value.email) },
                                    result.value.email,
                                    result.value.phone,
                                    result.value.birthday,
                                    result.value.instructions,
                                ),
                            )
                        }
                        tokenStore.accessToken?.let { connectRealtime(result.value.id, it) }
                    }
                    is AuthResult.Failure -> {
                        tokenStore.clear()
                        _state.update { it.copy(user = null) }
                    }
                }
            }
            syncConversations()
            refreshPlan()
        }
    }

    /** Settings/top-bar — current billing plan, refreshed after login and after a successful payment. */
    fun refreshPlan() {
        if (!tokenStore.hasSession()) return
        viewModelScope.launch {
            val quota = UsageApi.quota()
            if (quota != null) _state.update { it.copy(plan = quota.plan) }
        }
    }

    /** Plans screen — creates a Razorpay order + fetches the checkout key in one call. */
    suspend fun createBillingOrder(plan: String, interval: String, seats: Int? = null): Pair<BillingOrderCreated?, BillingConfig?> {
        val order = BillingApi.createOrder(planId = plan, billingCycle = interval, seats = seats)
        val config = BillingApi.config()
        return order to config
    }

    /** Plans screen — there's no client-side "verify" endpoint (see BillingApi's doc comment):
     * Razorpay confirmation only happens via the backend's signed webhook. So after checkout
     * reports success, this polls GET /billing/orders until the matching order flips to "paid"
     * (or times out), then refreshes the plan. */
    fun confirmPayment(orderId: String, onResult: (Boolean) -> Unit) {
        viewModelScope.launch {
            var confirmed = false
            for (attempt in 0 until 10) {
                val orders = BillingApi.orders()
                if (orders.any { it.id == orderId && it.status == "paid" }) {
                    confirmed = true
                    break
                }
                if (attempt < 9) kotlinx.coroutines.delay(1500)
            }
            if (confirmed) refreshPlan()
            onResult(confirmed)
        }
    }

    /** Replaces the drawer's local mock list with the real synced conversations, once logged in. */
    private fun syncConversations() {
        if (!tokenStore.hasSession()) return
        viewModelScope.launch {
            val remote = ConversationsApi.list()
            if (remote.isNotEmpty()) _state.update { it.copy(chats = remote) }
        }
    }

    /** Live cross-device sync: a second signed-in device (web tab, another phone) writing a new
     *  message/conversation shows up here without polling — see SupabaseRealtime's own doc
     *  comment for the Postgres-changes-over-websocket mechanism. */
    private fun connectRealtime(userId: String, accessToken: String) {
        SupabaseRealtime.connect(
            userId = userId,
            accessToken = accessToken,
            onConversationsChanged = { syncConversations() },
            onMessagesChanged = { conversationId ->
                // Never clobber a reply this device is actively streaming — the other device's
                // write already landed server-side, but our own in-flight message is more current.
                val streamingHere = conversationId != null &&
                    _state.value.chats.any { it.id == conversationId && it.messages.any { m -> m.isStreaming } }
                if (conversationId == null) {
                    syncConversations()
                } else if (!streamingHere) {
                    viewModelScope.launch {
                        val msgs = ConversationsApi.messages(conversationId)
                        if (msgs.isNotEmpty()) patchChat(conversationId) { it.copy(messages = msgs) }
                    }
                }
            },
        )
    }

    val current: ChatThread?
        get() = _state.value.chats.find { it.id == _state.value.currentId }

    fun setDraft(v: String) = _state.update { it.copy(draft = v) }

    fun toggleMode(mode: Mode) {
        haptic(8)
        _state.update {
            val next = it.modes.toMutableSet()
            if (!next.add(mode)) next.remove(mode)
            it.copy(modes = next)
        }
    }

    fun setModel(id: ModelId) = _state.update { it.copy(model = id, sheet = Sheet.None) }

    fun setRemoteModel(modelId: String) = _state.update { it.copy(selectedModelId = modelId, sheet = Sheet.None) }

    fun setDrawer(open: Boolean) = _state.update { it.copy(drawerOpen = open) }

    fun openSheet(sheet: Sheet) = _state.update { it.copy(sheet = sheet, drawerOpen = false) }

    fun closeSheet() = _state.update { it.copy(sheet = Sheet.None) }

    fun setPluginsTab(tab: String) = _state.update { it.copy(pluginsTab = tab) }

    fun consumeEntrance() = _state.update { it.copy(playEntrance = false) }

    /** Step 1 of real auth: POST login or signup, which always replies with an OTP requirement. */
    fun submitAuth(email: String, password: String, name: String, phone: String, birthday: String, isSignup: Boolean, onOtpRequired: () -> Unit) {
        val cleanEmail = email.trim()
        if (cleanEmail.isBlank() || password.isBlank()) {
            _state.update { it.copy(authError = "Enter your email and password.") }
            return
        }
        if (isSignup && (phone.isBlank() || birthday.isBlank())) {
            _state.update { it.copy(authError = "Enter your mobile number and birthday (YYYY-MM-DD).") }
            return
        }
        _state.update { it.copy(authBusy = true, authError = null) }
        viewModelScope.launch {
            val result = if (isSignup) {
                AuthApi.signup(name.ifBlank { nameFromEmail(cleanEmail) }, cleanEmail, password, phone, birthday)
            } else {
                AuthApi.login(cleanEmail, password)
            }
            when (result) {
                is AuthResult.Success -> {
                    _state.update { it.copy(authBusy = false, authError = null, authEmail = result.value.email.ifBlank { cleanEmail }, authStep = AuthStep.Otp) }
                    onOtpRequired()
                }
                is AuthResult.Failure -> _state.update { it.copy(authBusy = false, authError = result.message) }
            }
        }
    }

    /** Step 2: verify the 6-digit code, which is when a real session is actually issued. */
    fun verifyOtp(code: String, onVerified: () -> Unit) {
        val email = _state.value.authEmail
        if (code.length != 6 || email.isBlank()) return
        _state.update { it.copy(authBusy = true, authError = null) }
        viewModelScope.launch {
            when (val result = AuthApi.verifyOtp(email, code)) {
                is AuthResult.Success -> {
                    tokenStore.saveSession(result.value.session.accessToken, result.value.session.refreshToken)
                    tokenStore.userName = result.value.user.name
                    tokenStore.userEmail = result.value.user.email
                    _state.update {
                        it.copy(
                            user = FridayUser(
                                result.value.user.name.ifBlank { nameFromEmail(result.value.user.email) },
                                result.value.user.email,
                                result.value.user.phone,
                                result.value.user.birthday,
                                result.value.user.instructions,
                            ),
                            authBusy = false,
                            authError = null,
                            authStep = AuthStep.Form,
                            sheet = Sheet.None,
                        )
                    }
                    syncConversations()
                    refreshPlan()
                    connectRealtime(result.value.user.id, result.value.session.accessToken)
                    onVerified()
                }
                is AuthResult.Failure -> _state.update { it.copy(authBusy = false, authError = result.message) }
            }
        }
    }

    fun resendOtp() {
        val email = _state.value.authEmail
        if (email.isBlank()) return
        viewModelScope.launch { AuthApi.resendOtp(email) }
    }

    /** Settings > Account — phone/birthday edit. */
    fun updateProfile(phone: String, birthday: String, onResult: (Boolean, String?) -> Unit) {
        val instructions = _state.value.user?.instructions
        viewModelScope.launch {
            when (val result = AuthApi.updateProfile(phone, birthday, instructions)) {
                is AuthResult.Success -> {
                    _state.update { s -> s.copy(user = s.user?.copy(phone = result.value.phone, birthday = result.value.birthday, instructions = result.value.instructions)) }
                    onResult(true, null)
                }
                is AuthResult.Failure -> onResult(false, result.message)
            }
        }
    }

    /** Settings > Behavior — custom instructions, PATCHed alongside the rest of the profile. */
    fun updateInstructions(instructions: String, onResult: (Boolean, String?) -> Unit) {
        val phone = _state.value.user?.phone.orEmpty()
        val birthday = _state.value.user?.birthday.orEmpty()
        viewModelScope.launch {
            when (val result = AuthApi.updateProfile(phone, birthday, instructions)) {
                is AuthResult.Success -> {
                    _state.update { s -> s.copy(user = s.user?.copy(instructions = result.value.instructions)) }
                    onResult(true, null)
                }
                is AuthResult.Failure -> onResult(false, result.message)
            }
        }
    }

    /** Settings > Data Controls — wipes synced history both remotely and in the drawer's local list. */
    fun clearAllChats(onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            val ok = ConversationsApi.clearAll()
            if (ok) _state.update { it.copy(chats = emptyList(), currentId = null) }
            onDone(ok)
        }
    }

    /** Settings > Data Controls — raw JSON export of the account's chat data. */
    fun exportData(onResult: (String?) -> Unit) {
        viewModelScope.launch { onResult(AuthApi.exportData()) }
    }

    /** Settings > Data Controls — permanent; caller must confirm with the user before calling this. */
    fun deleteAccount(onResult: (Boolean) -> Unit) {
        viewModelScope.launch {
            val ok = AuthApi.deleteAccount()
            if (ok) logout()
            onResult(ok)
        }
    }

    fun clearAuthError() = _state.update { it.copy(authError = null) }

    fun resetAuthFlow() = _state.update { it.copy(authStep = AuthStep.Form, authError = null, authBusy = false) }

    /** Google/GitHub: resolves the backend's OAuth start URL to hand to a Custom Tab. */
    suspend fun oauthStartUrl(google: Boolean): String? =
        if (google) AuthApi.googleStartUrl() else AuthApi.githubStartUrl()

    /** Completes the fridayai://auth-callback#friday_session=<base64url json> redirect. */
    fun handleOAuthCallback(uri: android.net.Uri) {
        val fragment = uri.fragment ?: return
        val packed = fragment.substringAfter("friday_session=", "").substringBefore("&")
        if (packed.isEmpty()) return
        runCatching {
            val padded = packed.replace('-', '+').replace('_', '/').let {
                it + "=".repeat((4 - it.length % 4) % 4)
            }
            val decoded = String(Base64.decode(padded, Base64.DEFAULT))
            val obj = JSONObject(decoded)
            val session = obj.getJSONObject("session")
            val userObj = obj.getJSONObject("user")
            val accessToken = session.optString("access_token", session.optString("accessToken"))
            val refreshToken = session.optString("refresh_token", session.optString("refreshToken"))
            val name = userObj.optString("name")
            val email = userObj.optString("email")
            tokenStore.saveSession(accessToken, refreshToken)
            tokenStore.userName = name
            tokenStore.userEmail = email
            _state.update {
                it.copy(user = FridayUser(name.ifBlank { nameFromEmail(email) }, email), sheet = Sheet.None)
            }
            syncConversations()
            refreshPlan()
        }
    }

    fun logout() {
        // Every chat is about to be cleared below, not just the one being viewed — stop() alone
        // only stops the current chat's job.
        streamJobs.values.forEach { it.cancel() }
        streamJobs.clear()
        val hadSession = tokenStore.hasSession()
        tokenStore.clear()
        SupabaseRealtime.disconnect()
        if (hadSession) viewModelScope.launch { AuthApi.logout() }
        _state.update {
            it.copy(
                user = null,
                chats = emptyList(),
                currentId = null,
                draft = "",
                modes = emptySet(),
                drawerOpen = false,
                sheet = Sheet.None,
                authStep = AuthStep.Form,
                authEmail = "",
                authError = null,
            )
        }
    }

    fun newChat() {
        stop()
        _state.update { it.copy(currentId = null, draft = "", drawerOpen = false) }
    }

    fun openChat(id: String) {
        stop()
        _state.update { s ->
            val chat = s.chats.find { it.id == id } ?: return@update s
            val filled = if (chat.id == Seed.SHOWCASE_ID && chat.messages.isEmpty()) Seed.showcase() else chat
            s.copy(
                currentId = id,
                drawerOpen = false,
                chats = s.chats.map { if (it.id == id) filled else it },
            )
        }
        val chat = _state.value.chats.find { it.id == id }
        // Local synthetic ids ("c-...") never have remote history; anything else is a synced thread.
        if (tokenStore.hasSession() && chat != null && chat.messages.isEmpty() && !id.startsWith("c-")) {
            viewModelScope.launch {
                val msgs = ConversationsApi.messages(id)
                if (msgs.isNotEmpty()) patchChat(id) { it.copy(messages = msgs) }
            }
        }
    }

    fun consumeAuthRequired() = _state.update { it.copy(authRequired = false) }

    /** Attach sheet's Photos/Files/Camera rows all funnel into this — reads the picked file via
     *  ContentResolver, base64-encodes it, and stages it for the next [send] call. Mirrors the
     *  web composer's limits (10MB/file, 4 attachments/message — the latter enforced server-side too). */
    fun addAttachment(uri: Uri) {
        if (_state.value.pendingAttachments.size >= 4) {
            _state.update { it.copy(attachmentError = "Up to 4 files per message.") }
            return
        }
        viewModelScope.launch {
            val added = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    val resolver = getApplication<Application>().contentResolver
                    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
                    if (bytes.size > 10 * 1024 * 1024) return@runCatching null
                    val mime = resolver.getType(uri) ?: "application/octet-stream"
                    var name = "attachment"
                    resolver.query(uri, null, null, null, null)?.use { cursor ->
                        val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0 && cursor.moveToFirst()) name = cursor.getString(idx) ?: name
                    }
                    val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    PendingAttachment(
                        id = "att-${System.currentTimeMillis()}",
                        name = name,
                        mime = mime,
                        size = bytes.size.toLong(),
                        kind = if (mime.startsWith("image/")) "image" else "file",
                        dataUrl = "data:$mime;base64,$b64",
                    )
                }.getOrNull()
            }
            if (added != null) {
                _state.update { it.copy(pendingAttachments = it.pendingAttachments + added, attachmentError = null) }
            } else {
                _state.update { it.copy(attachmentError = "Couldn't attach that file (too large or unreadable).") }
            }
        }
    }

    fun removeAttachment(id: String) = _state.update { it.copy(pendingAttachments = it.pendingAttachments.filterNot { a -> a.id == id }) }

    fun setVoice(id: String, name: String) {
        tokenStore.voiceId = id
        tokenStore.voiceName = name
        _state.update { it.copy(voiceId = id, voiceName = name, sheet = Sheet.None) }
    }

    fun consumeAttachmentError() = _state.update { it.copy(attachmentError = null) }

    fun send(override: String? = null) {
        val text = (override ?: _state.value.draft).trim()
        val attachments = _state.value.pendingAttachments
        if (text.isEmpty() && attachments.isEmpty()) return
        // Only blocks re-sending into the SAME chat that's already streaming, not every chat.
        val activeChatId = _state.value.currentId
        if (activeChatId != null && streamJobs[activeChatId]?.isActive == true) return
        if (!tokenStore.hasSession()) {
            _state.update { it.copy(authRequired = true) }
            return
        }
        haptic(14)
        val modes = _state.value.modes
        var chatId = _state.value.currentId
        if (chatId == null) {
            chatId = "c-${System.currentTimeMillis()}"
            val thread = ChatThread(id = chatId, title = titleFrom(text), messages = emptyList())
            _state.update { it.copy(chats = listOf(thread) + it.chats, currentId = chatId) }
        }
        val userMsg = ChatMessage(id = "u-${System.currentTimeMillis()}", role = Role.User, content = text, attachments = attachments)
        val asstId = "a-${System.currentTimeMillis()}"
        val asst = ChatMessage(id = asstId, role = Role.Assistant, isStreaming = true, modesUsed = modes)
        val titleSeed = text.ifBlank { attachments.firstOrNull()?.name.orEmpty() }
        patchChat(chatId) { it.copy(messages = it.messages + userMsg + asst, title = if (it.messages.isEmpty()) titleFrom(titleSeed) else it.title, updatedAt = System.currentTimeMillis()) }
        _state.update { it.copy(draft = "", pendingAttachments = emptyList()) }

        val startChatId = chatId!!
        lateinit var job: Job
        job = viewModelScope.launch {
            try {
                val eventFlow = if (tokenStore.hasSession()) {
                    val selectedId = _state.value.selectedModelId
                    val conversationMode = when (selectedId) {
                        AUTO_MODEL_ID -> "auto"
                        TEAMUP_MODEL_ID -> "teamup"
                        else -> "single"
                    }
                    val selected = _state.value.remoteModels.firstOrNull { it.modelId == selectedId }
                    // Reuse the chat's server conversation once it has one. This used to create a
                    // brand-new conversation on EVERY send, so the backend (which builds the model's
                    // context from that conversation's saved messages) only ever saw the current
                    // message: "build me a website" → "name is Stockbricks" got "what can I do for
                    // you?" because the second message landed in an empty conversation.
                    val existingId = chatId!!.takeIf { isServerConversationId(it) }
                    val remoteId = if (existingId != null) {
                        if (conversationModels[existingId] != selectedId &&
                            ChatApi.updateConversation(existingId, selected?.modelId, selected?.providerSlug, conversationMode)
                        ) {
                            conversationModels[existingId] = selectedId
                        }
                        existingId
                    } else {
                        ChatApi.createConversation(selected?.modelId, selected?.providerSlug, conversationMode)
                            ?.also { conversationModels[it] = selectedId }
                    }
                    if (remoteId != null) {
                        val oldId = chatId!!
                        if (remoteId != oldId) {
                            // Swap the locally-generated placeholder id for the real conversation id
                            // returned by the backend, so drawer sync / lazy history fetch line up later.
                            _state.update { s ->
                                s.copy(
                                    currentId = if (s.currentId == oldId) remoteId else s.currentId,
                                    chats = s.chats.map { if (it.id == oldId) it.copy(id = remoteId) else it },
                                )
                            }
                            // Follow the id swap so stop()/the "already streaming" guard, both keyed
                            // on the current chat id, still find this job afterward.
                            streamJobs.remove(oldId)
                            streamJobs[remoteId] = job
                            chatId = remoteId
                        }
                        ChatApi.streamMessage(remoteId, text, modes, attachments)
                    } else {
                        repo.send(text, modes)
                    }
                } else {
                    repo.send(text, modes)
                }
                eventFlow.collect { event ->
                    when (event) {
                        is ChatEvent.Thinking -> patchMessage(chatId!!, asstId) {
                            it.copy(thinkingLabel = event.label, thinkingSteps = event.steps)
                        }
                        is ChatEvent.Status -> patchMessage(chatId!!, asstId) {
                            it.copy(status = event.phase)
                        }
                        is ChatEvent.Sources -> patchMessage(chatId!!, asstId) {
                            it.copy(sources = event.items)
                        }
                        is ChatEvent.Reasoning -> patchMessage(chatId!!, asstId) {
                            it.copy(reasoning = event.text)
                        }
                        is ChatEvent.Token -> patchMessage(chatId!!, asstId) {
                            it.copy(content = event.text)
                        }
                        is ChatEvent.CanvasUpdate -> patchMessage(chatId!!, asstId) {
                            it.copy(canvasHtml = event.html)
                        }
                        is ChatEvent.Agent -> patchMessage(chatId!!, asstId) { msg ->
                            val i = msg.agents.indexOfFirst { it.slug == event.status.slug && it.model == event.status.model }
                            val nextAgents = if (i == -1) msg.agents + event.status else msg.agents.toMutableList().apply { set(i, event.status) }
                            msg.copy(agents = nextAgents)
                        }
                        ChatEvent.Done -> patchMessage(chatId!!, asstId) {
                            it.copy(isStreaming = false)
                        }
                    }
                }
            } finally {
                patchMessage(chatId!!, asstId) { it.copy(isStreaming = false) }
                streamJobs.remove(chatId)
            }
        }
        streamJobs[startChatId] = job
    }

    /** Uploads a recorded voice message for transcription, then writes the recognized text into
     *  the composer draft for the user to review and send themselves (not auto-sent). */
    fun sendVoiceMessage(file: java.io.File) {
        viewModelScope.launch {
            val transcript = if (tokenStore.hasSession()) VoiceApi.transcribe(file) else null
            file.delete()
            transcript?.takeIf { it.isNotBlank() }?.let { setDraft(it) }
        }
    }

    /** Stops the currently displayed chat's turn only — never affects any other chat's own
     *  in-flight generation. */
    fun stop() {
        val id = _state.value.currentId ?: return
        streamJobs.remove(id)?.cancel()
        _state.update { s ->
            s.copy(
                chats = s.chats.map { chat ->
                    if (chat.id != id) chat
                    else chat.copy(messages = chat.messages.map { m -> m.copy(isStreaming = false) })
                },
            )
        }
    }

    private fun patchChat(id: String, block: (ChatThread) -> ChatThread) {
        _state.update { s -> s.copy(chats = s.chats.map { if (it.id == id) block(it) else it }) }
    }

    private fun patchMessage(chatId: String, msgId: String, block: (ChatMessage) -> ChatMessage) {
        patchChat(chatId) { chat ->
            chat.copy(messages = chat.messages.map { if (it.id == msgId) block(it) else it })
        }
    }

    private fun haptic(ms: Long) {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(ms)
            }
        } catch (_: Exception) {
        }
    }

    override fun onCleared() {
        super.onCleared()
        SupabaseRealtime.disconnect()
    }
}

// Real backend conversation ids are UUIDs; everything else ("c-<millis>" for a just-started chat,
// "seed-…"/showcase threads) is a local placeholder that still needs a server conversation.
private val SERVER_CONVERSATION_ID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

private fun isServerConversationId(id: String): Boolean = SERVER_CONVERSATION_ID.matches(id)
