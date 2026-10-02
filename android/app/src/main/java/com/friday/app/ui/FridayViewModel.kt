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
import com.friday.app.data.BuildInfo
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
import com.friday.app.data.api.Announcement
import com.friday.app.data.api.EngagementApi
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
    /** "What's new" product updates not yet seen by this account (shown once, then marked seen). */
    val announcements: List<Announcement> = emptyList(),
    /** Files staged in the composer, not yet sent — cleared once [FridayViewModel.send] fires.
     *  Capped at 4 to match the backend's per-message attachment limit. */
    val pendingAttachments: List<PendingAttachment> = emptyList(),
    val attachmentError: String? = null,
    /** Selected TTS voice for Voice Mode / spoken replies (GET /api/voice/voices id + display name). */
    val voiceId: String? = null,
    val voiceName: String? = null,
    /** Messages typed while a reply was still generating, per chat id. They send one at a time,
     *  in order, as each turn finishes. */
    val queued: Map<String, List<QueuedMessage>> = emptyMap(),
    /** "chat" or "build" — which workspace the main screen is in. Build Mode only runs in "build"
     *  (a new chat there is created as a Build session); the drawer lists that workspace's history. */
    val workspace: String = "chat",
    /** The project the NEXT new chat belongs to (set by "New chat in this project", cleared once it exists). */
    val activeProjectId: String? = null,
    /** A skill pinned from the Skills screen for the next message. */
    val activeSkill: com.friday.app.data.api.Skill? = null,
    /** Build home + drawer: every build session with its live status (GET /api/build/sessions). */
    val buildSessions: List<com.friday.app.data.BuildSessionSummary> = emptyList(),
    val buildSessionsLoaded: Boolean = false,
    val buildSessionsError: String? = null,
    /** Build composer effort picker: low | medium | high (remembered on this device). */
    val buildEffort: String = "medium",
    /** Build permission mode: full_auto | auto_edit | ask (remembered on this device). */
    val buildPermissionMode: String = "full_auto",
    /** Pending Build permission prompts per chat id (from the live stream or polled from the server). */
    val approvals: Map<String, List<com.friday.app.data.BuildApproval>> = emptyMap(),
    val approvalError: String? = null,
    /** Build: ids of user messages with a restore point, per chat id. */
    val checkpoints: Map<String, Set<String>> = emptyMap(),
    /** Build home: the GitHub repo + branch a new build should work on (null = a new project). */
    val buildRepo: Pair<String, String>? = null,
    val restoreError: String? = null,
)

data class QueuedMessage(
    val id: String,
    val text: String,
    val attachments: List<PendingAttachment>,
    val modes: Set<Mode>,
)

class FridayViewModel(app: Application) : AndroidViewModel(app) {
    companion object {
        // Must exactly match backend/src/services/policyService.ts's POLICY_VERSION and
        // frontend/src/lib/site/legal.ts's POLICY_VERSION — compared against the signed-in
        // account's saved FridayUser.policyVersion to decide whether FridayApp.kt shows the
        // blocking "I agree" dialog.
        const val POLICY_VERSION = "2026-09-29"
    }

    private val repo = ChatRepository()
    private val tokenStore = TokenStore(app).also { ApiClient.init(it) }
    private val vibrator = app.getSystemService(Vibrator::class.java)
    private val _state = MutableStateFlow(FridayUiState(plan = if (tokenStore.hasSession()) tokenStore.plan else null))
    val state: StateFlow<FridayUiState> = _state.asStateFlow()
    // Per-chat, not a single shared slot — one Job used to cover the whole app, so sending in a
    // second chat cancelled whatever the first chat was still streaming, and a single isGenerating
    // flag blocked sending into ANY chat while ANY other chat was generating. Reported live as
    // chats "getting stuck" when switching screens or opening a new chat mid-reply. Each chat now
    // owns its own job and can run fully independently of every other chat.
    private val streamJobs = mutableMapOf<String, Job>()
    private val buildPrefs = app.getSharedPreferences("friday_build", android.content.Context.MODE_PRIVATE)
    // Model last applied to each server conversation, so a send only PATCHes the conversation when
    // the picker actually changed. Unknown (e.g. a conversation loaded from the drawer) → PATCH once.
    private val conversationModels = mutableMapOf<String, String?>()

    init {
        _state.update {
            it.copy(
                buildEffort = buildPrefs.getString("effort", "medium") ?: "medium",
                buildPermissionMode = buildPrefs.getString("permissionMode", "full_auto") ?: "full_auto",
            )
        }
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
                                    result.value.policyVersion,
                                ),
                            )
                        }
                        tokenStore.accessToken?.let { connectRealtime(result.value.id, it) }
                        // Only once the current policy is accepted — the consent gate owns the screen until then.
                        if (result.value.policyVersion == POLICY_VERSION) loadAnnouncements()
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
            if (quota != null) {
                tokenStore.plan = quota.plan
                _state.update { it.copy(plan = quota.plan) }
            }
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
        viewModelScope.launch { syncConversationsNow() }
    }

    private suspend fun syncConversationsNow() {
        val remote = ConversationsApi.list() ?: return
        _state.update { s ->
            // Keep any chat that's mid-stream or not yet on the server (local "c-…" ids) —
            // dropping it would orphan the running reply — and reuse already-loaded messages.
            val remoteIds = remote.map { it.id }.toSet()
            val merged = remote.map { r -> s.chats.firstOrNull { it.id == r.id }?.let { old -> r.copy(messages = old.messages) } ?: r }
            val keep = s.chats.filter { it.id !in remoteIds && (streamJobs[it.id]?.isActive == true || !isServerConversationId(it.id) || it.id in projectChatIds) && it.id != Seed.SHOWCASE_ID }
            val chats = keep + merged
            s.copy(chats = chats, currentId = if (s.currentId == null || chats.any { it.id == s.currentId }) s.currentId else null)
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
                        // The conversation may not be in the local list yet (e.g. a brand-new
                        // automation chat) — without this, patchChat below is a silent no-op and
                        // the event is dropped for good.
                        if (_state.value.chats.none { it.id == conversationId }) syncConversationsNow()
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
    fun submitAuth(email: String, password: String, name: String, phone: String, birthday: String, isSignup: Boolean, acceptedTerms: Boolean, onOtpRequired: () -> Unit) {
        val cleanEmail = email.trim()
        if (cleanEmail.isBlank() || password.isBlank()) {
            _state.update { it.copy(authError = "Enter your email and password.") }
            return
        }
        if (isSignup && (phone.isBlank() || birthday.isBlank())) {
            _state.update { it.copy(authError = "Enter your mobile number and birthday (YYYY-MM-DD).") }
            return
        }
        if (isSignup && !acceptedTerms) {
            _state.update { it.copy(authError = "You must agree to the Terms of Service and Privacy Policy to continue.") }
            return
        }
        _state.update { it.copy(authBusy = true, authError = null) }
        viewModelScope.launch {
            val result = if (isSignup) {
                AuthApi.signup(name.ifBlank { nameFromEmail(cleanEmail) }, cleanEmail, password, phone, birthday, acceptedTerms)
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
                                result.value.user.policyVersion,
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
                    if (result.value.user.policyVersion == POLICY_VERSION) loadAnnouncements()
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

    /** Fetches unseen product updates once per app session (best effort). */
    private var announcementsLoaded = false
    fun loadAnnouncements() {
        if (announcementsLoaded) return
        announcementsLoaded = true
        viewModelScope.launch {
            val pending = EngagementApi.pending()
            if (pending.isNotEmpty()) _state.update { it.copy(announcements = pending) }
        }
    }

    /** The What's New dialog closed (optionally via its button) — record the views so it never shows again. */
    fun dismissAnnouncements(clickedId: String? = null) {
        val ids = _state.value.announcements.map { it.id }
        _state.update { it.copy(announcements = emptyList()) }
        if (ids.isNotEmpty()) viewModelScope.launch { EngagementApi.markSeen(ids, clickedId) }
    }

    /** PolicyConsentDialog's "I Agree" button — records acceptance and closes the gate. */
    fun acceptPolicy(onResult: (Boolean, String?) -> Unit) {
        viewModelScope.launch {
            when (val result = AuthApi.acceptPolicy()) {
                is AuthResult.Success -> {
                    _state.update { s -> s.copy(user = s.user?.copy(policyVersion = result.value.policyVersion)) }
                    onResult(true, null)
                    loadAnnouncements()
                }
                is AuthResult.Failure -> onResult(false, result.message)
            }
        }
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
            val policyVersion = userObj.optString("policyVersion").ifBlank { null }
            tokenStore.saveSession(accessToken, refreshToken)
            tokenStore.userName = name
            tokenStore.userEmail = email
            _state.update {
                it.copy(user = FridayUser(name.ifBlank { nameFromEmail(email) }, email, policyVersion = policyVersion), sheet = Sheet.None)
            }
            syncConversations()
            refreshPlan()
            if (policyVersion == POLICY_VERSION) loadAnnouncements()
        }
    }

    fun logout() {
        announcementsLoaded = false
        _state.update { it.copy(announcements = emptyList()) }
        // Every chat is about to be cleared below, not just the one being viewed — stop() alone
        // only stops the current chat's job.
        _state.update { it.copy(queued = emptyMap()) }
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
        cancelLocalStream()
        _state.update { it.copy(currentId = null, draft = "", drawerOpen = false, workspace = "chat", activeProjectId = null) }
    }

    fun setActiveSkill(skill: com.friday.app.data.api.Skill?) {
        _state.update { it.copy(activeSkill = skill) }
    }

    /** Chats that live inside a project: the main chat list never includes them, so the list sync must keep them. */
    private val projectChatIds = mutableSetOf<String>()

    /** "New chat in this project": the next chat created belongs to it. */
    fun startProjectChat(projectId: String) {
        cancelLocalStream()
        _state.update { it.copy(currentId = null, draft = "", drawerOpen = false, workspace = "chat", activeProjectId = projectId) }
    }

    /** Opens one of a project's chats (not in the main list, so add it first). */
    fun openProjectChat(chat: com.friday.app.data.ChatThread) {
        projectChatIds += chat.id
        _state.update { s -> if (s.chats.any { it.id == chat.id }) s else s.copy(chats = s.chats + chat) }
        openChat(chat.id)
    }

    /** Opens the Build workspace on a fresh build session (created on the first send). */
    fun newBuild() {
        cancelLocalStream()
        _state.update { it.copy(currentId = null, draft = "", drawerOpen = false, workspace = "build") }
        loadBuildSessions()
    }

    /** Refreshes the Build home / drawer statuses. A failure keeps the last list and says so. */
    fun loadBuildSessions() {
        if (!tokenStore.hasSession()) return
        viewModelScope.launch {
            val list = com.friday.app.data.api.BuildApi.sessions()
            _state.update {
                if (list == null) it.copy(buildSessionsLoaded = true, buildSessionsError = "Couldn't load your builds — pull to retry.")
                else it.copy(buildSessions = list, buildSessionsLoaded = true, buildSessionsError = null)
            }
        }
    }

    fun setBuildPermissionMode(mode: String) {
        buildPrefs.edit().putString("permissionMode", mode).apply()
        _state.update { it.copy(buildPermissionMode = mode) }
    }

    private fun upsertApproval(chatId: String, a: com.friday.app.data.BuildApproval) = _state.update { s ->
        val list = s.approvals[chatId].orEmpty().filterNot { it.id == a.id }
        s.copy(approvals = s.approvals + (chatId to if (a.state == "pending") list + a else list))
    }

    /** Allow / Deny / Allow all for this build on the chat's pending prompt. Failure shows a message. */
    fun answerApproval(decision: String) {
        val chatId = _state.value.currentId ?: return
        val a = _state.value.approvals[chatId]?.lastOrNull() ?: return
        viewModelScope.launch {
            val err = com.friday.app.data.api.BuildApi.approve(chatId, a.id, decision)
            if (err == null) upsertApproval(chatId, a.copy(state = if (decision == "deny") "denied" else "allowed"))
            _state.update { it.copy(approvalError = err) }
        }
    }

    /** A build started on another device (or before the app restarted) can be waiting on a prompt:
     *  poll for it while the open build session is running / waiting and this device isn't streaming. */
    fun pollApprovals() {
        val chatId = _state.value.currentId ?: return
        if (streamJobs[chatId]?.isActive == true || !isServerConversationId(chatId)) return
        val status = _state.value.buildSessions.firstOrNull { it.id == chatId }?.status
        if (status != "running" && status != "needs_input") return
        viewModelScope.launch {
            val list = com.friday.app.data.api.BuildApi.approvals(chatId) ?: return@launch
            _state.update { it.copy(approvals = it.approvals + (chatId to list)) }
        }
    }

    fun loadCheckpoints(chatId: String) {
        if (!isServerConversationId(chatId) || !tokenStore.hasSession()) return
        viewModelScope.launch {
            val ids = com.friday.app.data.api.BuildApi.checkpoints(chatId) ?: return@launch
            _state.update { it.copy(checkpoints = it.checkpoints + (chatId to ids)) }
        }
    }

    /** "Restore to before this message" — then reloads the rewound conversation. */
    fun restoreTo(messageId: String) {
        val chatId = _state.value.currentId ?: return
        viewModelScope.launch {
            val err = com.friday.app.data.api.BuildApi.restore(chatId, messageId)
            _state.update { it.copy(restoreError = err) }
            if (err == null) {
                val msgs = ConversationsApi.messages(chatId)
                patchChat(chatId) { it.copy(messages = msgs) }
                loadCheckpoints(chatId)
                loadBuildSessions()
            }
        }
    }

    fun consumeRestoreError() = _state.update { it.copy(restoreError = null) }

    fun setBuildRepo(repo: String?, branch: String?) = _state.update { it.copy(buildRepo = if (repo != null && branch != null) repo to branch else null) }

    fun setBuildEffort(effort: String) {
        buildPrefs.edit().putString("effort", effort).apply()
        _state.update { it.copy(buildEffort = effort) }
    }

    /** "Open in Build" under a normal-chat reply: a fresh Build session starting with that request.
     *  Sending it only starts the question/plan round — nothing is built until the plan is approved. */
    fun openInBuild(prompt: String) {
        newBuild()
        send(prompt)
    }

    /** "Approve & build" on a pending plan: mark it approved locally (the server does too) and go. */
    fun approvePlan() {
        val chatId = _state.value.currentId ?: return
        val pending = _state.value.chats.find { it.id == chatId }?.messages?.lastOrNull()
            ?.takeIf { it.role == Role.Assistant && !it.isStreaming && it.build?.plan?.status == "pending" } ?: return
        patchMessage(chatId, pending.id) { m -> m.copy(build = m.build?.copy(plan = m.build.plan?.copy(status = "approved"))) }
        send(com.friday.app.data.PLAN_APPROVE_TEXT)
    }

    fun openChat(id: String) {
        cancelLocalStream()
        _state.update { s ->
            val chat = s.chats.find { it.id == id } ?: return@update s
            val filled = if (chat.id == Seed.SHOWCASE_ID && chat.messages.isEmpty()) Seed.showcase() else chat
            s.copy(
                currentId = id,
                drawerOpen = false,
                chats = s.chats.map { if (it.id == id) filled else it },
                workspace = if (chat.workspace == "build") "build" else "chat",
            )
        }
        if (_state.value.chats.find { it.id == id }?.isBuild == true) loadCheckpoints(id)
        val chat = _state.value.chats.find { it.id == id }
        // Local synthetic ids ("c-...") never have remote history; anything else is a synced thread.
        // Besides the empty-history case, also refetch when the chat was left with a trailing user
        // message and no reply (e.g. a scheduled automation ran while this screen wasn't open and
        // realtime never delivered the reply here), or the last assistant turn was cut off by a
        // local disconnect (app backgrounded/killed mid-stream) — the server finished it regardless.
        val last = chat?.messages?.lastOrNull()
        val needsRefetch = chat != null && chat.messages.none { it.isStreaming } && (
            chat.messages.isEmpty() || last?.role == Role.User || last?.disconnected == true
            )
        if (tokenStore.hasSession() && needsRefetch && !id.startsWith("c-")) {
            viewModelScope.launch {
                val msgs = ConversationsApi.messages(id)
                if (msgs.isNotEmpty()) patchChat(id) { it.copy(messages = msgs) }
            }
        }
    }

    /** Called when the app returns to the foreground (see FridayApp's ON_START observer). Picks up
     *  anything that happened while backgrounded — a scheduled automation's reply, a message sent
     *  from another device. Deliberately does NOT call [openChat]: that cancels this device's own
     *  in-flight stream, which resuming the app must never do. */
    fun onAppForegrounded() {
        if (!tokenStore.hasSession()) return
        syncConversations()
        resumeChatIfRunning()
        val id = _state.value.currentId ?: return
        val chat = _state.value.chats.find { it.id == id } ?: return
        if (id.startsWith("c-") || chat.messages.any { it.isStreaming }) return
        val last = chat.messages.lastOrNull()
        val needsRefetch = chat.messages.isEmpty() || last?.role == Role.User || last?.disconnected == true
        if (needsRefetch) {
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
        val activeChatId = _state.value.currentId
        if (!tokenStore.hasSession()) {
            _state.update { it.copy(authRequired = true) }
            return
        }
        // A reply is still generating in this chat: park the message in the queue instead of
        // dropping it. It sends automatically, in order, once the current turn finishes.
        if (activeChatId != null && streamJobs[activeChatId]?.isActive == true) {
            val item = QueuedMessage("q-${System.nanoTime()}", text, attachments, _state.value.modes)
            _state.update {
                it.copy(
                    draft = "",
                    pendingAttachments = emptyList(),
                    queued = it.queued + (activeChatId to (it.queued[activeChatId].orEmpty() + item)),
                )
            }
            haptic(10)
            return
        }
        _state.update { it.copy(draft = "", pendingAttachments = emptyList()) }
        // A new build with a repo picked: say which repo + branch the way the backend recognises it
        // (it clones github.com/owner/repo/tree/<branch> before the agent starts).
        val repo = _state.value.buildRepo
        val content = if (activeChatId == null && _state.value.workspace == "build" && repo != null && !text.contains("github.com/")) {
            _state.update { it.copy(buildRepo = null) }
            "Work on https://github.com/${repo.first}/tree/${repo.second} (branch ${repo.second}) — $text"
        } else text
        startTurn(activeChatId, content, attachments, _state.value.modes)
    }

    fun removeQueued(chatId: String, id: String) {
        _state.update { it.copy(queued = it.queued + (chatId to it.queued[chatId].orEmpty().filterNot { q -> q.id == id })) }
    }

    private fun startTurn(existingChatId: String?, text: String, attachments: List<PendingAttachment>, modes: Set<Mode>) {
        haptic(14)
        var chatId = existingChatId
        if (chatId == null) {
            chatId = "c-${System.currentTimeMillis()}"
            val thread = ChatThread(id = chatId, title = titleFrom(text), messages = emptyList(), workspace = _state.value.workspace.takeIf { it == "build" })
            _state.update { it.copy(chats = listOf(thread) + it.chats, currentId = chatId) }
        }
        val userMsg = ChatMessage(id = "u-${System.currentTimeMillis()}", role = Role.User, content = text, attachments = attachments)
        val asstId = "a-${System.currentTimeMillis()}"
        val asst = ChatMessage(id = asstId, role = Role.Assistant, isStreaming = true, modesUsed = modes)
        val titleSeed = text.ifBlank { attachments.firstOrNull()?.name.orEmpty() }
        patchChat(chatId) { it.copy(messages = it.messages + userMsg + asst, title = if (it.messages.isEmpty()) titleFrom(titleSeed) else it.title, updatedAt = System.currentTimeMillis()) }

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
                        val workspace = _state.value.chats.find { it.id == chatId }?.workspace
                        val projectId = _state.value.activeProjectId
                        ChatApi.createConversation(selected?.modelId, selected?.providerSlug, conversationMode, workspace, projectId)
                            ?.also {
                                conversationModels[it] = selectedId
                                if (projectId != null) {
                                    projectChatIds += it
                                    _state.update { s -> s.copy(activeProjectId = null) }
                                }
                            }
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
                                    queued = s.queued[oldId]?.let { q -> s.queued - oldId + (remoteId to q) } ?: s.queued,
                                )
                            }
                            // Follow the id swap so stop()/the "already streaming" guard, both keyed
                            // on the current chat id, still find this job afterward.
                            streamJobs.remove(oldId)
                            streamJobs[remoteId] = job
                            chatId = remoteId
                        }
                        val isBuild = _state.value.chats.find { it.id == remoteId }?.workspace == "build"
                        // A pinned skill applies to this one message, then the chip clears.
                        val pinnedSkillId = _state.value.activeSkill?.id
                        if (pinnedSkillId != null) _state.update { it.copy(activeSkill = null) }
                        ChatApi.streamMessage(remoteId, text, if (isBuild) modes - Mode.Research else modes, attachments, effort = if (isBuild) _state.value.buildEffort else null, permissionMode = if (isBuild) _state.value.buildPermissionMode else null, skillId = pinnedSkillId)
                    } else {
                        repo.send(text, modes)
                    }
                } else {
                    repo.send(text, modes)
                }
                eventFlow.collect { event -> applyChatEvent(chatId!!, asstId, event, userMsg.id) }
            } finally {
                patchMessage(chatId!!, asstId) { it.copy(isStreaming = false) }
                streamJobs.remove(chatId)
                if (_state.value.chats.find { it.id == chatId }?.isBuild == true) {
                    loadBuildSessions()
                    loadCheckpoints(chatId!!)
                }
                val next = _state.value.queued[chatId]?.firstOrNull()
                if (next != null && tokenStore.hasSession()) {
                    removeQueued(chatId!!, next.id)
                    startTurn(chatId, next.text, next.attachments, next.modes)
                }
            }
        }
        streamJobs[startChatId] = job
    }

    private var resumeJob: Job? = null

    /**
     * Build live resume: the open build is running with no stream on this device (started on another
     * device, or before the app restarted) — replay its event log into a live message and keep
     * following it until it ends, then load the saved result. Only starts once the server confirms
     * it's running.
     */
    fun resumeBuildIfRunning() {
        val chatId = _state.value.currentId ?: return
        val status = _state.value.buildSessions.firstOrNull { it.id == chatId }?.status
        if (status != "running" && status != "needs_input") return
        followRunningTurn(chatId, initialStatus = "building", isBuild = true) { id, after -> com.friday.app.data.api.BuildApi.events(id, after) }
    }

    /**
     * Background turns: a normal chat reply keeps running on the server after the app is closed or the
     * device changes. Opening that chat (or returning to the app) re-attaches to it live, same as the web.
     */
    fun resumeChatIfRunning() {
        val chatId = _state.value.currentId ?: return
        if (_state.value.workspace == "build") return
        followRunningTurn(chatId, initialStatus = "thinking", isBuild = false) { id, after -> ConversationsApi.live(id, after) }
    }

    private fun followRunningTurn(
        chatId: String,
        initialStatus: String,
        isBuild: Boolean,
        fetch: suspend (String, Long) -> Pair<List<Pair<Long, org.json.JSONObject>>, Boolean>?,
    ) {
        if (!isServerConversationId(chatId) || streamJobs[chatId]?.isActive == true || resumeJob?.isActive == true) return
        resumeJob = viewModelScope.launch {
            val parser = com.friday.app.data.api.FrameParser()
            val asstId = "a-resume-${System.currentTimeMillis()}"
            var after = 0L
            var started = false
            try {
                while (true) {
                    val page = fetch(chatId, after)
                    if (page != null) {
                        val (events, running) = page
                        if (!started) {
                            if (!running) break
                            started = true
                            patchChat(chatId) { it.copy(messages = it.messages + ChatMessage(id = asstId, role = Role.Assistant, isStreaming = true, status = initialStatus)) }
                        }
                        for ((id, frame) in events) {
                            after = id
                            if (frame.optString("t") == "done") continue
                            parser.parse(frame)?.let { applyChatEvent(chatId, asstId, it, null) }
                        }
                        if (!running && events.isEmpty()) break
                    }
                    if (_state.value.currentId != chatId) break
                    kotlinx.coroutines.delay(1200)
                }
            } finally {
                if (started) {
                    val msgs = ConversationsApi.messages(chatId)
                    if (msgs.isNotEmpty()) patchChat(chatId) { it.copy(messages = msgs) }
                    if (isBuild) loadBuildSessions()
                }
            }
        }
    }

    /** Applies one stream event to a chat's assistant message — shared by live sends and Build live resume. */
    private fun applyChatEvent(chatId: String, asstId: String, event: ChatEvent, userMsgId: String?) {
        when (event) {
            is ChatEvent.Thinking -> patchMessage(chatId, asstId) {
                it.copy(thinkingLabel = event.label, thinkingSteps = event.steps)
            }
            is ChatEvent.Status -> patchMessage(chatId, asstId) {
                // "building" = Build Mode started: keep a BuildInfo around so the start-up
                // banner stays visible until the first step exists (narration flips status meanwhile).
                it.copy(status = event.phase, build = if (event.phase == "building" && it.build == null) BuildInfo() else it.build)
            }
            is ChatEvent.Sources -> patchMessage(chatId, asstId) {
                it.copy(sources = event.items)
            }
            is ChatEvent.Reasoning -> patchMessage(chatId, asstId) {
                it.copy(reasoning = event.text)
            }
            is ChatEvent.Token -> patchMessage(chatId, asstId) {
                it.copy(content = event.text)
            }
            is ChatEvent.CanvasUpdate -> patchMessage(chatId, asstId) {
                it.copy(canvasHtml = event.html)
            }
            is ChatEvent.Agent -> patchMessage(chatId, asstId) { msg ->
                val i = msg.agents.indexOfFirst { it.slug == event.status.slug && it.model == event.status.model }
                val nextAgents = if (i == -1) msg.agents + event.status else msg.agents.toMutableList().apply { set(i, event.status) }
                msg.copy(agents = nextAgents)
            }
            is ChatEvent.Step -> patchMessage(chatId, asstId) { msg ->
                val cur = msg.build ?: BuildInfo()
                val i = cur.steps.indexOfFirst { it.id == event.step.id }
                val steps = if (i == -1) cur.steps + event.step else cur.steps.toMutableList().apply { set(i, event.step) }
                msg.copy(build = cur.copy(steps = steps))
            }
            is ChatEvent.File -> patchMessage(chatId, asstId) { msg ->
                if (msg.files.any { it.id == event.file.id }) msg else msg.copy(files = msg.files + event.file)
            }
            is ChatEvent.Preview -> patchMessage(chatId, asstId) { msg ->
                msg.copy(build = (msg.build ?: BuildInfo()).copy(previewUrl = event.url, port = event.port))
            }
            is ChatEvent.Plan -> patchMessage(chatId, asstId) { msg ->
                msg.copy(build = (msg.build ?: BuildInfo()).copy(plan = event.plan))
            }
            is ChatEvent.BuildMeta -> patchMessage(chatId, asstId) { msg ->
                msg.copy(build = (msg.build ?: BuildInfo()).copy(elapsedMs = event.elapsedMs, zipBytes = event.zipBytes, zipName = event.zipName))
            }
            is ChatEvent.Ask -> patchMessage(chatId, asstId) { msg ->
                msg.copy(build = (msg.build ?: BuildInfo()).copy(ask = event.questions))
            }
            is ChatEvent.SuggestBuild -> patchMessage(chatId, asstId) {
                it.copy(suggestBuildPrompt = event.prompt)
            }
            is ChatEvent.Approval -> upsertApproval(chatId, event.approval)
            is ChatEvent.Meta -> patchChat(chatId) { c ->
                c.copy(messages = c.messages.map { if (it.id == userMsgId) it.copy(id = event.userMessageId) else it })
            }
            ChatEvent.Disconnected -> patchMessage(chatId, asstId) {
                it.copy(disconnected = true)
            }
            ChatEvent.Done -> patchMessage(chatId, asstId) {
                it.copy(isStreaming = false)
            }
        }
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

    /** Drops the on-screen stream when switching chats. Unlike [stop] this does NOT tell the server
     *  to stop — the reply keeps generating and lands via realtime sync. */
    private fun cancelLocalStream() {
        val id = _state.value.currentId ?: return
        streamJobs.remove(id)?.cancel()
        _state.update { s ->
            s.copy(chats = s.chats.map { chat ->
                if (chat.id != id) chat else chat.copy(messages = chat.messages.map { m -> m.copy(isStreaming = false) })
            })
        }
    }

    /** Deletes a chat locally and on the server; if the server call fails the list is resynced so
     *  the chat visibly comes back instead of silently reappearing later. */
    fun deleteChat(id: String, onFailure: () -> Unit = {}) {
        streamJobs.remove(id)?.cancel()
        _state.update { s ->
            s.copy(
                chats = s.chats.filterNot { it.id == id },
                currentId = if (s.currentId == id) null else s.currentId,
                queued = s.queued - id,
            )
        }
        if (isServerConversationId(id) && tokenStore.hasSession()) {
            viewModelScope.launch {
                if (!ConversationsApi.delete(id)) {
                    syncConversations()
                    onFailure()
                }
            }
        }
    }

    /** Stops the currently displayed chat's turn only — never affects any other chat's own
     *  in-flight generation. */
    fun stop() {
        val id = _state.value.currentId ?: return
        streamJobs.remove(id)?.cancel()
        // The server keeps generating after a disconnect, so cancelling the local stream isn't
        // enough — tell it to stop too.
        if (isServerConversationId(id)) viewModelScope.launch { ChatApi.stopMessage(id) }
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
