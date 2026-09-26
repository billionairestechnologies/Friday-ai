package com.friday.app

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material.icons.outlined.WorkspacePremium
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import kotlin.math.roundToInt
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.friday.app.data.Mode
import com.friday.app.data.Sheet
import com.friday.app.ui.FridayViewModel
import com.friday.app.ui.auth.AuthAnimatedHeadline
import com.friday.app.ui.auth.AuthLandingPage
import com.friday.app.ui.auth.AuthOtpBody
import com.friday.app.ui.auth.AuthSheetBody
import com.friday.app.ui.canvas.CanvasPanel
import com.friday.app.ui.canvas.detectArtifact
import com.friday.app.ui.chat.ChatThread
import com.friday.app.ui.composer.ComposerBar
import com.friday.app.ui.shell.AttachSheet
import com.friday.app.ui.shell.DrawerPane
import com.friday.app.ui.shell.ModelSheet
import com.friday.app.ui.shell.PluginsSheet
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayCanvas
import com.friday.app.ui.theme.FridayGlow
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridayScrim
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridaySidebar
import com.friday.app.ui.theme.FridayStop
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FridayApp(
    vm: FridayViewModel = viewModel(),
    oauthIntents: MutableStateFlow<Intent?>? = null,
    onStartCheckout: (CheckoutRequest) -> Unit = {},
    paymentResults: MutableStateFlow<PaymentOutcome?>? = null,
) {
    val ui by vm.state.collectAsState()
    val drawerState = com.friday.app.ui.shell.rememberSwipeDrawerState(ui.drawerOpen)
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var page by remember { mutableStateOf("chat") }
    var updatePopupDismissed by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }

    val photoPickerLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) vm.addAttachment(uri)
        vm.closeSheet()
    }
    val filePickerLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) vm.addAttachment(uri)
        vm.closeSheet()
    }
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val uri = pendingCameraUri
        if (success && uri != null) vm.addAttachment(uri)
        pendingCameraUri = null
        vm.closeSheet()
    }
    fun launchCamera() {
        val file = java.io.File(ctx.cacheDir.resolve("attachments").apply { mkdirs() }, "camera_${System.currentTimeMillis()}.jpg")
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        pendingCameraUri = uri
        cameraLauncher.launch(uri)
    }

    fun openUpdate() {
        val url = ui.updateInfo?.url ?: return
        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    fun launchOAuth(google: Boolean) {
        scope.launch {
            val url = vm.oauthStartUrl(google)
            if (url != null) {
                CustomTabsIntent.Builder().build().launchUrl(ctx, Uri.parse(url))
            }
        }
    }

    if (oauthIntents != null) {
        val pending by oauthIntents.collectAsState()
        LaunchedEffect(pending) {
            val uri = pending?.data
            if (uri != null) {
                vm.handleOAuthCallback(uri)
                oauthIntents.value = null
                page = "chat"
            }
        }
    }

    LaunchedEffect(ui.drawerOpen) {
        if (ui.drawerOpen != drawerState.isOpen) {
            if (ui.drawerOpen) drawerState.open() else drawerState.close()
        }
    }
    LaunchedEffect(drawerState.isOpen) {
        vm.setDrawer(drawerState.isOpen)
    }

    com.friday.app.ui.shell.SwipeDrawer(
        state = drawerState,
        gesturesEnabled = page == "chat",
        drawerContent = {
            Box(Modifier.fillMaxWidth()) {
                DrawerPane(
                    user = ui.user,
                    plan = ui.plan,
                    updateAvailable = ui.updateInfo != null,
                    recents = ui.chats,
                    currentId = ui.currentId,
                    onNewChat = {
                        vm.newChat()
                        page = "chat"
                    },
                    onOpenChat = {
                        vm.openChat(it)
                        page = "chat"
                    },
                    onDeleteChat = { id -> vm.deleteChat(id) { android.widget.Toast.makeText(ctx, "Couldn't delete that chat — check your connection.", android.widget.Toast.LENGTH_LONG).show() } },
                    onOpenSheet = { dest ->
                        if (dest == Sheet.Auth) {
                            vm.setDrawer(false)
                            page = "auth"
                        } else {
                            vm.openSheet(dest)
                        }
                    },
                    onNavigate = { dest ->
                        vm.setDrawer(false)
                        page = dest
                    },
                    onClose = { drawerState.close() },
                    onUpdate = { openUpdate() },
                )
            }
        },
    ) {
        when (page) {
            "library" -> com.friday.app.ui.library.LibraryScreen(onClose = { page = "chat" })
            "projects" -> StubPage("Projects", "Project-scoped chats and files will live here.") { page = "chat" }
            "automations" -> StubPage("Automations", "Scheduled prompts are coming soon.") { page = "chat" }
            "settings" -> com.friday.app.ui.settings.SettingsScreen(
                vm = vm,
                onBack = { page = "chat" },
                onOpenSheet = vm::openSheet,
                onLogin = { page = "auth" },
                onOpenPlans = { page = "plans" },
            )
            "plans" -> com.friday.app.ui.settings.PlansScreen(
                vm = vm,
                onBack = { page = "chat" },
                onStartCheckout = onStartCheckout,
                paymentResults = paymentResults,
            )
            "auth" -> AuthLandingPage(
                onGoogleAuth = { launchOAuth(google = true) },
                onGithubAuth = { launchOAuth(google = false) },
                onOpenForm = {
                    vm.resetAuthFlow()
                    page = "welcome"
                },
                onClose = { page = "chat" },
            )
            "welcome", "signup" -> FullAuthPage(
                isSignup = page == "signup",
                busy = ui.authBusy,
                error = ui.authError,
                onSubmit = { email, password, name, phone, birthday ->
                    vm.submitAuth(email, password, name, phone, birthday, isSignup = page == "signup") { page = "otp" }
                },
                onGoogleAuth = { launchOAuth(google = true) },
                onGithubAuth = { launchOAuth(google = false) },
                onClose = { page = "chat" },
                onSwitch = {
                    vm.clearAuthError()
                    page = if (page == "welcome") "signup" else "welcome"
                },
            )
            "otp" -> OtpPage(
                email = ui.authEmail,
                busy = ui.authBusy,
                error = ui.authError,
                onVerify = { code -> vm.verifyOtp(code) { page = "chat" } },
                onResend = vm::resendOtp,
                onClose = {
                    vm.resetAuthFlow()
                    page = "chat"
                },
            )
            else -> ChatShell(
                vm = vm,
                swipe = drawerState,
                onOpenDrawer = { drawerState.open() },
                onOpenAuth = { page = "auth" },
                onOpenPlans = { page = "plans" },
                onOpenUpdate = { openUpdate() },
            )
        }
    }

    val pendingUpdate = ui.updateInfo
    if (pendingUpdate != null && !updatePopupDismissed) {
        AlertDialog(
            onDismissRequest = { updatePopupDismissed = true },
            title = { Text("Update available") },
            text = { Text("Friday ${pendingUpdate.version} is ready — update for the latest improvements.") },
            confirmButton = {
                TextButton(onClick = {
                    updatePopupDismissed = true
                    openUpdate()
                }) { Text("Update") }
            },
            dismissButton = {
                TextButton(onClick = { updatePopupDismissed = true }) { Text("Later") }
            },
        )
    }

    if (ui.sheet == Sheet.Model || ui.sheet == Sheet.Attach) {
        CompactAnchoredPopup(
            onDismiss = vm::closeSheet,
            anchor = if (ui.sheet == Sheet.Attach) Alignment.BottomStart else Alignment.BottomEnd,
            widthFraction = if (ui.sheet == Sheet.Attach) 0.72f else 0.66f,
        ) {
            when (ui.sheet) {
                Sheet.Model -> ModelSheet(
                    remoteModels = ui.remoteModels,
                    selectedModelId = ui.selectedModelId,
                    localSelected = ui.model,
                    plan = ui.plan,
                    onPickRemote = vm::setRemoteModel,
                    onLocked = { vm.closeSheet(); page = "plans" },
                    onPickLocal = vm::setModel,
                )
                Sheet.Attach -> AttachSheet(
                    onCamera = { launchCamera() },
                    onPhotos = { photoPickerLauncher.launch("image/*") },
                    // Widened alongside the backend's plain-text/code attachment support
                    // (.py/.xml/.json/.csv/.md/etc — see plainTextDocs.ts): "text/*" is a real
                    // SAF wildcard (Android's document picker honors it same as an exact mime),
                    // application/json and application/xml are common cases browsers/OSes report
                    // outside the text/* prefix. Without this the picker itself hid these files
                    // before the backend fix could ever matter.
                    onFiles = {
                        filePickerLauncher.launch(
                            arrayOf(
                                "image/*",
                                "application/pdf",
                                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                "text/*",
                                "application/json",
                                "application/xml",
                            ),
                        )
                    },
                    onPlugins = { vm.openSheet(Sheet.Plugins) },
                )
                else -> {}
            }
        }
    } else if (ui.sheet != Sheet.None) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = vm::closeSheet,
            sheetState = sheetState,
            containerColor = FridayBg,
            tonalElevation = 0.dp,
        ) {
            when (ui.sheet) {
                Sheet.Auth, Sheet.Welcome, Sheet.Signup -> {}
                Sheet.Plugins -> PluginsSheet(ui.pluginsTab, vm::setPluginsTab)
                else -> {}
            }
        }
    }
}

@Composable
private fun CompactAnchoredPopup(
    onDismiss: () -> Unit,
    anchor: Alignment = Alignment.BottomCenter,
    widthFraction: Float = 0.9f,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(
        Modifier
            .fillMaxSize()
            .background(FridayScrim)
            .clickable(
                indication = null,
                interactionSource = remember { MutableInteractionSource() },
                onClick = onDismiss,
            ),
    ) {
        Column(
            Modifier
                .align(anchor)
                .then(
                    when (anchor) {
                        Alignment.BottomStart -> Modifier.padding(start = 16.dp)
                        Alignment.BottomEnd -> Modifier.padding(end = 16.dp)
                        else -> Modifier
                    },
                )
                .fillMaxWidth(widthFraction)
                .navigationBarsPadding()
                .padding(bottom = 116.dp)
                .shadow(16.dp, RoundedCornerShape(28.dp), clip = false)
                .clip(RoundedCornerShape(28.dp))
                .background(FridayBg)
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                    onClick = {},
                )
                .padding(vertical = 4.dp),
            content = content,
        )
    }
}

@Composable
private fun ChatShell(
    vm: FridayViewModel,
    swipe: com.friday.app.ui.shell.SwipeDrawerState,
    onOpenDrawer: () -> Unit,
    onOpenAuth: () -> Unit,
    onOpenPlans: () -> Unit,
    onOpenUpdate: () -> Unit,
) {
    val ui by vm.state.collectAsState()
    LaunchedEffect(ui.authRequired) {
        if (ui.authRequired) {
            onOpenAuth()
            vm.consumeAuthRequired()
        }
    }
    val chat = ui.chats.find { it.id == ui.currentId }
    val empty = chat == null || chat.messages.isEmpty()
    // Per-chat, not a single app-wide flag — a chat streaming in the background (another chat
    // open, or one the user switched away from) must not disable the composer for whatever chat
    // is actually being viewed right now. See FridayViewModel.send()'s per-chat streamJobs map.
    val isGenerating = chat?.messages?.any { it.isStreaming } == true
    // Auto-open: no dedicated backend artifact event exists (verified live), so this is a client-side
    // fence scan over the latest assistant message — see ArtifactDetect.kt. Falls back to the mock
    // ChatRepository's separate canvasHtml field (used only as a resiliency path if remote conversation
    // creation fails for a logged-in user).
    fun artifactFor(msg: com.friday.app.data.ChatMessage): com.friday.app.ui.canvas.DetectedArtifact? =
        detectArtifact(msg.content) ?: msg.canvasHtml?.let {
            com.friday.app.ui.canvas.DetectedArtifact(com.friday.app.ui.canvas.ArtifactKind.Html, "html", it, complete = true)
        }
    var autoClosedMessageId by remember { mutableStateOf<String?>(null) }
    val latestArtifactMsg = chat?.messages?.asReversed()?.firstOrNull { artifactFor(it) != null }
    val latestArtifact = latestArtifactMsg?.let { artifactFor(it) }
    // Plain code (ArtifactKind.Code) only shows when Canvas is turned on — it never auto-opens the panel.
    val autoOpen = latestArtifact != null && latestArtifact.kind != com.friday.app.ui.canvas.ArtifactKind.Code && latestArtifactMsg?.id != autoClosedMessageId
    // Build Mode: a running project newer than any single-file artifact takes over the panel.
    val messages = chat?.messages.orEmpty()
    val buildMsg = messages.lastOrNull { it.build?.previewUrl != null }
    val buildIdx = buildMsg?.let { messages.indexOf(it) } ?: -1
    val artifactIdx = latestArtifactMsg?.let { messages.indexOf(it) } ?: -1
    val buildActive = buildMsg != null && buildIdx > artifactIdx
    var buildOpen by remember { mutableStateOf(false) }
    // Opens on its own the moment a preview URL first appears (live or when loading history is
    // deliberately NOT auto-opened — only when this device is watching it stream in).
    LaunchedEffect(buildMsg?.build?.previewUrl) {
        if (buildMsg?.isStreaming == true) buildOpen = true
    }
    val canvasOn = (Mode.Canvas in ui.modes || autoOpen) && !buildActive || (buildActive && buildOpen)
    val ctx = LocalContext.current
    val reduce = remember {
        Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    val play = ui.playEntrance && empty && !reduce
    val glowA by animateFloatAsState(1f, tween(if (play) 400 else 0, easing = FastOutSlowInEasing), label = "glow")
    val heroA by animateFloatAsState(1f, tween(if (play) 500 else 0, delayMillis = 80, easing = FastOutSlowInEasing), label = "hero")
    val heroY by animateFloatAsState(0f, tween(if (play) 500 else 0, delayMillis = 80, easing = FastOutSlowInEasing), label = "heroY")
    val compA by animateFloatAsState(1f, tween(if (play) 480 else 0, delayMillis = 140, easing = FastOutSlowInEasing), label = "comp")
    val barA by animateFloatAsState(1f, tween(if (play) 400 else 0, delayMillis = 100, easing = FastOutSlowInEasing), label = "bar")
    LaunchedEffect(Unit) { vm.consumeEntrance() }

    var voiceModeOpen by remember { mutableStateOf(false) }
    val lastAssistant = chat?.messages?.lastOrNull { it.role == com.friday.app.data.Role.Assistant }

    Box(Modifier.fillMaxSize()) {
    Column(
        Modifier
            .fillMaxSize()
            .background(FridayBg)
            .statusBarsPadding(),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(56.dp)
                .alpha(barA)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onOpenDrawer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Menu, "Open menu", tint = FridayText)
            }
            if (ui.user == null || (ui.plan != null && com.friday.app.ui.settings.isFreePlan(ui.plan))) {
                Spacer(Modifier.width(6.dp))
                Box(
                    Modifier
                        .clip(RoundedCornerShape(50))
                        .background(FridayText)
                        .clickable(onClick = if (ui.user == null) onOpenAuth else onOpenPlans)
                        .padding(horizontal = 14.dp, vertical = 7.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (ui.user == null) "Log in" else "Upgrade", color = Color.White, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.weight(1f))
            Text("Friday", fontSize = 17.sp, fontWeight = FontWeight.Medium, color = FridayText)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier
                    .padding(end = 4.dp)
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(if (canvasOn) FridayCanvas.copy(alpha = 0.12f) else Color.Transparent)
                    .clickable(onClick = { vm.toggleMode(Mode.Canvas) }),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.GridView, "Canvas", tint = if (canvasOn) FridayCanvas else FridayText)
            }
        }

        if (ui.updateInfo != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp)
                    .padding(bottom = 8.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(Brush.horizontalGradient(listOf(FridayStop, FridaySearch)))
                    .clickable(onClick = onOpenUpdate)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.SystemUpdate, null, tint = Color.White, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    "Update available — v${ui.updateInfo!!.version} is ready",
                    color = Color.White,
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f),
                )
                Text("Update", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
        }

        Column(Modifier.weight(1f).fillMaxWidth()) {
            var dragTotal by remember { mutableStateOf(0f) }
            val composerFocus = remember { androidx.compose.ui.focus.FocusRequester() }
            val keyboardController = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
            val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
            val hideKeyboardOnPull = remember {
                object : androidx.compose.ui.input.nestedscroll.NestedScrollConnection {
                    override fun onPreScroll(
                        available: androidx.compose.ui.geometry.Offset,
                        source: androidx.compose.ui.input.nestedscroll.NestedScrollSource,
                    ): androidx.compose.ui.geometry.Offset {
                        if (available.y > 8f) {
                            keyboardController?.hide()
                            focusManager.clearFocus()
                        }
                        return androidx.compose.ui.geometry.Offset.Zero
                    }
                }
            }
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .nestedScroll(hideKeyboardOnPull)
                    .pointerInput(empty) {
                        var upTotal = 0f
                        detectVerticalDragGestures(
                            onDragStart = { upTotal = 0f },
                            onVerticalDrag = { _, dragAmount ->
                                if (dragAmount > 10f) {
                                    keyboardController?.hide()
                                    focusManager.clearFocus()
                                }
                                // Swipe up on the (non-scrolling) start screen brings up the keyboard.
                                if (empty && dragAmount < 0f) {
                                    upTotal += dragAmount
                                    if (upTotal < -60f) {
                                        upTotal = 0f
                                        composerFocus.requestFocus()
                                        keyboardController?.show()
                                    }
                                }
                            },
                        )
                    },
                contentAlignment = if (empty) Alignment.Center else Alignment.TopStart,
            ) {
                if (empty) {
                    Box(
                        Modifier
                            .alpha(heroA)
                            .padding(bottom = 12.dp)
                            .padding(top = (12 * heroY).dp)
                            .padding(horizontal = 28.dp),
                    ) {
                        Text(
                            mainLineFor(ui.user?.name),
                            fontSize = 28.sp,
                            fontWeight = FontWeight.Bold,
                            color = FridayText,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        )
                    }
                } else {
                    ChatThread(chat?.messages.orEmpty(), onOpenPreview = { buildOpen = true }, conversationId = chat?.id)
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .alpha(compA)
                    .scale(if (play) 0.96f + 0.04f * compA else 1f),
            ) {
              Column {
                val queuedHere = ui.currentId?.let { ui.queued[it] }.orEmpty()
                queuedHere.forEachIndexed { i, q ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(bottom = 6.dp)
                            .clip(RoundedCornerShape(14.dp))
                            .background(com.friday.app.ui.theme.FridaySurface)
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Queued ${i + 1}", color = FridayMuted, fontSize = 12.sp)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            q.text.ifBlank { "Attachment" },
                            color = FridayText,
                            fontSize = 14.sp,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Icon(
                            Icons.Default.Close,
                            contentDescription = "Remove queued message",
                            tint = FridayMuted,
                            modifier = Modifier
                                .size(18.dp)
                                .clickable { ui.currentId?.let { id -> vm.removeQueued(id, q.id) } },
                        )
                    }
                }
                val lastMsg = chat?.messages.orEmpty().lastOrNull()
                val pendingAsk = lastMsg?.takeIf { it.role == com.friday.app.data.Role.Assistant && !it.isStreaming }?.build?.ask.orEmpty()
                var dismissedAskFor by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<String?>(null) }
                if (pendingAsk.isNotEmpty() && lastMsg != null && dismissedAskFor != lastMsg.id) {
                    com.friday.app.ui.chat.AskPanel(
                        questions = pendingAsk,
                        onDismiss = { dismissedAskFor = lastMsg.id },
                        onSubmit = { text -> dismissedAskFor = lastMsg.id; vm.send(text) },
                    )
                }
                ComposerBar(
                    draft = ui.draft,
                    onDraft = vm::setDraft,
                    modes = ui.modes,
                    onToggleMode = vm::toggleMode,
                    modelLabel = com.friday.app.ui.shell.shortModelName(
                        ui.remoteModels.firstOrNull { it.modelId == ui.selectedModelId }?.displayName ?: ui.model.label,
                    ),
                    modelId = ui.selectedModelId,
                    isGenerating = isGenerating,
                    onSend = { vm.send() },
                    onStop = vm::stop,
                    onAttach = { vm.openSheet(Sheet.Attach) },
                    onVoice = { voiceModeOpen = true },
                    onModel = { vm.openSheet(Sheet.Model) },
                    onVoiceMessage = vm::sendVoiceMessage,
                    attachments = ui.pendingAttachments,
                    onRemoveAttachment = vm::removeAttachment,
                    focusRequester = composerFocus,
                )
              }
            }
        }
    }

    // Canvas slides in from the right, following the finger — the same single horizontal drag that
    // drives the left drawer (see SwipeDrawer), so both feel identical to iOS.
    val density = androidx.compose.ui.platform.LocalDensity.current
    val panelW = with(density) { androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp.dp.toPx() }
    val canvasX = remember(panelW) { androidx.compose.animation.core.Animatable(if (canvasOn) 0f else panelW) }
    val canvasSpring = androidx.compose.animation.core.spring<Float>(dampingRatio = 0.9f, stiffness = 650f)
    val canvasScope = rememberCoroutineScope()
    val canvasOnNow by androidx.compose.runtime.rememberUpdatedState(canvasOn)
    val buildActiveNow by androidx.compose.runtime.rememberUpdatedState(buildActive)
    val closeCanvas = {
        if (buildActive) buildOpen = false
        if (Mode.Canvas in ui.modes) vm.toggleMode(Mode.Canvas)
        if (latestArtifactMsg != null) autoClosedMessageId = latestArtifactMsg.id
    }
    LaunchedEffect(canvasOn, panelW) { canvasX.animateTo(if (canvasOn) 0f else panelW, canvasSpring) }
    androidx.compose.runtime.DisposableEffect(swipe, panelW) {
        swipe.registerRightPanel(object : com.friday.app.ui.shell.RightPanel {
            override val isOpen get() = canvasOnNow
            override fun dragBy(delta: Float) {
                canvasScope.launch { canvasX.snapTo((canvasX.value + delta).coerceIn(0f, panelW)) }
            }
            override fun settle(velocity: Float, fromOpen: Boolean) {
                val revealed = 1f - canvasX.value / panelW
                val open = when {
                    kotlin.math.abs(velocity) > 500f -> velocity < 0
                    fromOpen -> revealed > 0.75f
                    else -> revealed > 0.25f
                }
                if (open && !canvasOnNow) { if (buildActiveNow) buildOpen = true else vm.toggleMode(Mode.Canvas) }
                if (!open && canvasOnNow) closeCanvas()
                canvasScope.launch { canvasX.animateTo(if (open) 0f else panelW, canvasSpring, initialVelocity = velocity) }
            }
        })
        onDispose { swipe.registerRightPanel(null) }
    }
    if (canvasX.value < panelW - 1f) {
        val panelModifier = Modifier
            .fillMaxSize()
            .offset { androidx.compose.ui.unit.IntOffset(canvasX.value.roundToInt(), 0) }
            .statusBarsPadding()
            .shadow(24.dp)
        if (buildActive && buildMsg != null && chat != null) {
            com.friday.app.ui.canvas.BuildPanel(
                conversationId = chat.id,
                // Just-built (this device is watching it) → known-good URL; a loaded-from-history
                // build gets re-verified/restored by the backend first.
                liveUrl = buildMsg.build?.previewUrl?.takeIf { buildMsg.id.startsWith("a-") },
                onClose = { buildOpen = false },
                modifier = panelModifier,
            )
        } else {
            CanvasPanel(
                artifact = latestArtifact,
                generating = isGenerating && latestArtifact == null,
                onClose = closeCanvas,
                modifier = panelModifier,
            )
        }
    }

    if (voiceModeOpen) {
        com.friday.app.ui.voice.VoiceModeScreen(
            voiceId = ui.voiceId,
            replyText = lastAssistant?.content.orEmpty(),
            isReplying = isGenerating,
            onSubmitTranscript = { text -> vm.send(text) },
            onClose = { voiceModeOpen = false },
            modifier = Modifier.fillMaxSize().statusBarsPadding(),
        )
    }
    }
}

/** Single-line home greeting: just the time-of-day greeting + name, big and bold, no extra
 *  descriptive text (kept to 2-3 words so it never wraps or truncates). */
private fun mainLineFor(name: String?): String {
    val hour = java.time.LocalTime.now().hour
    val prefix = when {
        hour < 5 -> "Good night"
        hour < 12 -> "Good morning"
        hour < 17 -> "Good afternoon"
        hour < 21 -> "Good evening"
        else -> "Good night"
    }
    val first = name?.trim()?.substringBefore(" ")?.takeIf { it.isNotBlank() }
    return if (first != null) "$prefix, $first" else prefix
}

@Composable
private fun StubPage(title: String, body: String, onClose: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .background(FridayBg)
            .statusBarsPadding()
            .padding(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontSize = 22.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            Icon(Icons.Default.Close, "Close", modifier = Modifier.clickable(onClick = onClose).padding(8.dp))
        }
        Spacer(Modifier.height(12.dp))
        Text(body, color = FridayMuted, fontSize = 15.sp)
    }
}

@Composable
private fun FullAuthPage(
    isSignup: Boolean,
    busy: Boolean,
    error: String?,
    onSubmit: (email: String, password: String, name: String, phone: String, birthday: String) -> Unit,
    onGoogleAuth: () -> Unit,
    onGithubAuth: () -> Unit,
    onClose: () -> Unit,
    onSwitch: () -> Unit,
) {
    val ctx = LocalContext.current
    val reduce = remember {
        Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { visible = true }
    val entrance by animateFloatAsState(
        if (visible) 1f else 0f,
        tween(if (reduce) 0 else 380, easing = FastOutSlowInEasing),
        label = "authFormEntrance",
    )

    Column(
        Modifier
            .fillMaxSize()
            .background(FridayBg)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .alpha(entrance)
            .offset(y = ((1f - entrance) * 56).dp),
    ) {
        Spacer(Modifier.height(24.dp))
        AuthSheetBody(
            sheet = if (isSignup) Sheet.Signup else Sheet.Welcome,
            busy = busy,
            error = error,
            onSubmit = onSubmit,
            onGoogleAuth = onGoogleAuth,
            onGithubAuth = onGithubAuth,
            onOpen = { onSwitch() },
            onClose = onClose,
        )
    }
}

@Composable
private fun OtpPage(
    email: String,
    busy: Boolean,
    error: String?,
    onVerify: (String) -> Unit,
    onResend: () -> Unit,
    onClose: () -> Unit,
) {
    val ctx = LocalContext.current
    val reduce = remember {
        Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { visible = true }
    val entrance by animateFloatAsState(
        if (visible) 1f else 0f,
        tween(if (reduce) 0 else 380, easing = FastOutSlowInEasing),
        label = "otpEntrance",
    )

    Column(
        Modifier
            .fillMaxSize()
            .background(FridayBg)
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .alpha(entrance)
            .offset(y = ((1f - entrance) * 56).dp),
    ) {
        Spacer(Modifier.height(24.dp))
        AuthOtpBody(
            email = email,
            busy = busy,
            error = error,
            onVerify = onVerify,
            onResend = onResend,
            onClose = onClose,
        )
    }
}
