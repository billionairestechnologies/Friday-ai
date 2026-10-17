package com.friday.app.ui.settings

import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Cake
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CardMembership
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DataUsage
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PersonOutline
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Vibration
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.friday.app.data.Sheet
import com.friday.app.data.api.BillingApi
import com.friday.app.data.api.BillingOrder
import com.friday.app.data.api.UsageApi
import com.friday.app.data.api.UsageBreakdown
import com.friday.app.data.api.UsageBreakdownEntry
import com.friday.app.data.api.UsageQuota
import com.friday.app.data.api.VoiceApi
import com.friday.app.data.api.VoiceOption
import com.friday.app.ui.BirthdayPickerDialog
import com.friday.app.ui.FridayUiState
import com.friday.app.ui.FridayViewModel
import com.friday.app.data.FridayUser
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridaySidebar
import com.friday.app.ui.theme.FridayStop
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Settings — an Android-style drill-down list mirroring the web app's 8 sections. Each row on
 * the home list opens its own dedicated page; only Account/Appearance/Notifications are visible
 * to guests, everything else needs a session.
 */
private enum class SettingsSub { Profile, Appearance, Behavior, Voice, Billing, Usage, DataControls, Memory, Connectors }

@Composable
fun SettingsScreen(
    vm: FridayViewModel,
    onBack: () -> Unit,
    onOpenSheet: (Sheet) -> Unit,
    onLogin: () -> Unit,
    onOpenPlans: () -> Unit,
) {
    val ui by vm.state.collectAsState()
    val user = ui.user
    var sub by remember { mutableStateOf<SettingsSub?>(null) }

    when (sub) {
        null -> SettingsHome(
            vm = vm,
            ui = ui,
            user = user,
            onBack = onBack,
            onOpenSheet = onOpenSheet,
            onLogin = onLogin,
            onOpen = { sub = it },
        )
        SettingsSub.Profile -> SubPageScaffold("Profile", onBack = { sub = null }) {
            ProfilePage(vm, user?.name, user?.email, user?.phone, user?.birthday, onSignedOut = { sub = null; onBack() })
        }
        SettingsSub.Appearance -> SubPageScaffold("Appearance", onBack = { sub = null }) {
            AppearancePage()
        }
        SettingsSub.Behavior -> SubPageScaffold("Behavior", onBack = { sub = null }) {
            BehaviorPage(vm, ui, onOpenSheet)
        }
        SettingsSub.Voice -> SubPageScaffold("Voice", onBack = { sub = null }) {
            VoiceSection(vm, ui.voiceId)
        }
        SettingsSub.Billing -> SubPageScaffold("Billing", onBack = { sub = null }) {
            BillingSection(ui.plan, onOpenPlans)
        }
        SettingsSub.Usage -> SubPageScaffold("Usage", onBack = { sub = null }) {
            UsageSection(onUpgrade = onOpenPlans)
        }
        SettingsSub.Memory -> SubPageScaffold("Memory", onBack = { sub = null }) {
            com.friday.app.ui.agent.MemoryContent()
        }
        SettingsSub.Connectors -> SubPageScaffold("MCP servers", onBack = { sub = null }) {
            com.friday.app.ui.agent.ConnectorsContent()
        }
        SettingsSub.DataControls -> SubPageScaffold("Data Controls", onBack = { sub = null }) {
            DataControlsSection(vm, onAccountDeleted = { sub = null; onBack() })
        }
    }
}

@Composable
private fun SettingsHome(
    vm: FridayViewModel,
    ui: FridayUiState,
    user: FridayUser?,
    onBack: () -> Unit,
    onOpenSheet: (Sheet) -> Unit,
    onLogin: () -> Unit,
    onOpen: (SettingsSub) -> Unit,
) {
    val ctx = LocalContext.current

    Column(
        Modifier
            .fillMaxSize()
            .background(FridaySidebar)
            .statusBarsPadding(),
    ) {
        Box(Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
            Icon(
                Icons.Default.Close,
                "Close",
                tint = FridayText,
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 16.dp)
                    .clip(CircleShape)
                    .background(FridayBg)
                    .clickable(onClick = onBack)
                    .padding(8.dp),
            )
            Text("Settings", fontSize = 17.sp, fontWeight = FontWeight.Bold, color = FridayText)
        }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            SectionLabel("Account")
            SettingsCard {
                SettingsRow(
                    icon = Icons.Default.PersonOutline,
                    label = user?.name ?: "Guest",
                    subtitle = user?.email ?: "Not logged in",
                    onClick = { if (user != null) onOpen(SettingsSub.Profile) else onLogin() },
                )
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("General")
            SettingsCard {
                SettingsRow(
                    icon = Icons.Default.Palette,
                    label = "Appearance",
                    value = "Light",
                    onClick = { onOpen(SettingsSub.Appearance) },
                )
                if (user != null) {
                    SettingsDivider()
                    SettingsRow(Icons.Default.Psychology, "Behavior", onClick = { onOpen(SettingsSub.Behavior) })
                    SettingsDivider()
                    SettingsRow(Icons.Default.RecordVoiceOver, "Voice", onClick = { onOpen(SettingsSub.Voice) })
                }
                SettingsDivider()
                SettingsRow(Icons.Default.NotificationsNone, "Notifications", onClick = { openNotificationSettings(ctx) })
            }

            if (user != null) {
                Spacer(Modifier.height(18.dp))
                SectionLabel("Payments")
                SettingsCard {
                    SettingsRow(
                        icon = Icons.Default.CardMembership,
                        label = "Billing",
                        value = ui.plan?.replaceFirstChar { it.uppercase() } ?: "Free",
                        onClick = { onOpen(SettingsSub.Billing) },
                    )
                    SettingsDivider()
                    SettingsRow(Icons.Default.DataUsage, "Usage", onClick = { onOpen(SettingsSub.Usage) })
                }

                Spacer(Modifier.height(18.dp))
                SectionLabel("Friday")
                SettingsCard {
                    SettingsRow(Icons.Default.Extension, "Plugins") { onOpenSheet(Sheet.Plugins) }
                    SettingsDivider()
                    SettingsRow(Icons.Default.Psychology, "Memory", onClick = { onOpen(SettingsSub.Memory) })
                    SettingsDivider()
                    SettingsRow(Icons.Default.Extension, "MCP servers", onClick = { onOpen(SettingsSub.Connectors) })
                }

                Spacer(Modifier.height(18.dp))
                SectionLabel("Data & Information")
                SettingsCard {
                    SettingsRow(Icons.Default.Storage, "Data Controls", onClick = { onOpen(SettingsSub.DataControls) })
                }

                // Support and status live on the web (same account, same tickets) — opened in a Custom Tab.
                Spacer(Modifier.height(18.dp))
                SectionLabel("Help")
                val webContext = androidx.compose.ui.platform.LocalContext.current
                val openWeb: (String) -> Unit = { path ->
                    androidx.browser.customtabs.CustomTabsIntent.Builder().build()
                        .launchUrl(webContext, android.net.Uri.parse("https://friday.billionairestechnologies.com$path"))
                }
                SettingsCard {
                    SettingsRow(Icons.Default.SupportAgent, "Help & support") { openWeb("/?support=contact") }
                    SettingsDivider()
                    SettingsRow(Icons.Default.MonitorHeart, "System status") { openWeb("/status") }
                }
            }
        }
    }
}

@Composable
private fun SubPageScaffold(title: String, onBack: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .background(FridaySidebar)
            .statusBarsPadding(),
    ) {
        Box(Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
            Icon(
                Icons.AutoMirrored.Filled.ArrowBack,
                "Back",
                tint = FridayText,
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 16.dp)
                    .clip(CircleShape)
                    .background(FridayBg)
                    .clickable(onClick = onBack)
                    .padding(8.dp),
            )
            Text(title, fontSize = 17.sp, fontWeight = FontWeight.Bold, color = FridayText)
        }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            content = content,
        )
    }
}

@Composable
private fun ProfilePage(
    vm: FridayViewModel,
    name: String?,
    email: String?,
    phone: String?,
    birthday: String?,
    onSignedOut: () -> Unit,
) {
    SettingsCard {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(
                Modifier.size(48.dp).clip(CircleShape).background(FridaySurface),
                contentAlignment = Alignment.Center,
            ) {
                Text(name?.firstOrNull()?.uppercase() ?: "?", color = FridayText, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            }
            Column {
                Text(name ?: "Guest", color = FridayText, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                Text(email ?: "Not logged in", color = FridayMuted, fontSize = 13.sp)
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    SettingsCard {
        var phoneField by remember(phone) { mutableStateOf(phone.orEmpty()) }
        var birthdayField by remember(birthday) { mutableStateOf(birthday.orEmpty()) }
        var saving by remember { mutableStateOf(false) }
        var saved by remember { mutableStateOf(false) }
        val dirty = phoneField != phone.orEmpty() || birthdayField != birthday.orEmpty()

        EditableRow(Icons.Default.Phone, "Phone", phoneField, "Mobile number") {
            phoneField = it
            saved = false
        }
        SettingsDivider()
        BirthdayRow(birthdayField) {
            birthdayField = it
            saved = false
        }
        if (dirty || saving || saved) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                when {
                    saving -> CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    saved -> Text("Saved", color = FridaySearch, fontSize = 13.sp)
                    else -> TextButton(onClick = {
                        saving = true
                        vm.updateProfile(phoneField, birthdayField) { ok, _ ->
                            saving = false
                            saved = ok
                        }
                    }) { Text("Save") }
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))
    SettingsCard {
        SettingsRow(
            icon = Icons.AutoMirrored.Filled.Logout,
            label = "Sign out",
            tint = FridayStop,
            showChevron = false,
            onClick = { vm.logout(); onSignedOut() },
        )
    }
}

@Composable
private fun AppearancePage() {
    SettingsCard {
        SettingsRow(
            icon = Icons.Default.Palette,
            label = "Light",
            tint = FridaySearch,
            showChevron = false,
            trailingIcon = Icons.Default.Check,
        )
        SettingsDivider()
        SettingsRow(
            icon = Icons.Default.Palette,
            label = "Dark",
            value = "Coming soon",
            tint = FridayMuted,
            showChevron = false,
        )
    }
    Spacer(Modifier.height(10.dp))
    Text(
        "Dark mode is on the way — we'll let you know when it ships.",
        color = FridayMuted,
        fontSize = 12.5.sp,
        modifier = Modifier.padding(start = 8.dp),
    )
}

@Composable
private fun BehaviorPage(vm: FridayViewModel, ui: FridayUiState, onOpenSheet: (Sheet) -> Unit) {
    var instructions by remember(ui.user?.instructions) { mutableStateOf(ui.user?.instructions.orEmpty()) }
    var saving by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    val dirty = instructions != ui.user?.instructions.orEmpty()

    SettingsCard {
        SettingsRow(
            icon = Icons.Default.Psychology,
            label = "Default model",
            value = ui.remoteModels.firstOrNull { it.modelId == ui.selectedModelId }?.displayName ?: ui.model.label,
            onClick = { onOpenSheet(Sheet.Model) },
        )
    }

    Spacer(Modifier.height(18.dp))
    SectionLabel("Custom instructions")
    SettingsCard {
        BasicTextField(
            value = instructions,
            onValueChange = {
                instructions = it
                saved = false
            },
            textStyle = TextStyle(color = FridayText, fontSize = 14.5.sp, lineHeight = 20.sp),
            modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).padding(14.dp),
            decorationBox = { inner ->
                Box {
                    if (instructions.isEmpty()) {
                        Text(
                            "How should Friday respond? Tone, formatting, things to avoid…",
                            color = FridayMuted,
                            fontSize = 14.5.sp,
                            lineHeight = 20.sp,
                        )
                    }
                    inner()
                }
            },
        )
    }
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            when {
                saving -> "Saving…"
                saved -> "Saved"
                else -> "Applies to every new chat."
            },
            color = if (saved) FridaySearch else FridayMuted,
            fontSize = 12.sp,
            modifier = Modifier.padding(start = 8.dp),
        )
        if (dirty && !saving) {
            TextButton(onClick = {
                saving = true
                vm.updateInstructions(instructions) { ok, _ ->
                    saving = false
                    saved = ok
                }
            }) { Text("Save") }
        }
    }
}

@Composable
private fun BirthdayRow(value: String, onChange: (String) -> Unit) {
    var showPicker by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { showPicker = true }
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Default.Cake, null, tint = FridayText, modifier = Modifier.size(20.dp))
        Text("Birthday", color = FridayText, fontSize = 15.sp, modifier = Modifier.width(90.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Text(value.ifEmpty { "YYYY-MM-DD" }, color = if (value.isEmpty()) FridayMuted else FridayText, fontSize = 14.5.sp)
        }
    }
    if (showPicker) {
        BirthdayPickerDialog(current = value, onPicked = onChange, onDismiss = { showPicker = false })
    }
}

@Composable
private fun EditableRow(icon: ImageVector, label: String, value: String, placeholder: String, onChange: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, tint = FridayText, modifier = Modifier.size(20.dp))
        Text(label, color = FridayText, fontSize = 15.sp, modifier = Modifier.width(90.dp))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(color = FridayText, fontSize = 14.5.sp, textAlign = androidx.compose.ui.text.style.TextAlign.End),
            modifier = Modifier.fillMaxWidth(),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterEnd) {
                    if (value.isEmpty()) Text(placeholder, color = FridayMuted, fontSize = 14.5.sp)
                    inner()
                }
            },
        )
    }
}

/** The picked voice is used for Voice Mode's spoken replies (VoiceModeScreen) — persisted via
 * [FridayViewModel.setVoice]/[TokenStore], not just held in local Compose state, so it actually
 * sticks across app restarts instead of resetting to the first voice every time this opens. */
@Composable
private fun VoiceSection(vm: FridayViewModel, selectedVoiceId: String?) {
    var voices by remember { mutableStateOf<List<VoiceOption>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var playingId by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    LaunchedEffect(Unit) {
        voices = VoiceApi.voices()
        if (selectedVoiceId == null) {
            voices.firstOrNull()?.let { vm.setVoice(it.id, it.name) }
        }
        loading = false
    }

    SettingsCard {
        when {
            loading -> Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            }
            voices.isEmpty() -> SettingsRow(Icons.Default.Psychology, "No voices available", showChevron = false)
            else -> voices.forEachIndexed { i, voice ->
                if (i > 0) SettingsDivider()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { vm.setVoice(voice.id, voice.name) }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(
                        Modifier.size(20.dp).clip(CircleShape)
                            .background(if (selectedVoiceId == voice.id) FridaySearch else FridaySurface),
                    )
                    Text(voice.name, color = FridayText, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    val isPlaying = playingId == voice.id
                    Icon(
                        if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                        "Preview",
                        tint = FridayMuted,
                        modifier = Modifier
                            .size(22.dp)
                            .clickable {
                                if (isPlaying) return@clickable
                                scope.launch {
                                    playingId = voice.id
                                    val bytes = VoiceApi.speak("Hi, this is Friday.", voice.id)
                                    if (bytes != null) playPreview(ctx, bytes)
                                    playingId = null
                                }
                            },
                    )
                }
            }
        }
    }
}

@Composable
private fun BillingSection(plan: String?, onOpenPlans: () -> Unit) {
    var orders by remember { mutableStateOf<List<BillingOrder>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        orders = BillingApi.orders()
        loading = false
    }

    val planLabel = plan?.replaceFirstChar { it.uppercase() } ?: if (loading) "…" else "Free"

    SettingsCard {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 13.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Default.CardMembership, null, tint = FridayText, modifier = Modifier.size(20.dp))
                Text(planLabel, color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                Box(
                    Modifier
                        .clip(RoundedCornerShape(50))
                        .background(FridaySearch.copy(alpha = 0.12f))
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                ) {
                    Text("Current plan", color = FridaySearch, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
                }
            }
        }
        SettingsDivider()
        SettingsRow(
            icon = Icons.AutoMirrored.Filled.OpenInNew,
            label = if (isFreePlan(plan)) "Upgrade to Premium" else "Manage subscription",
            onClick = onOpenPlans,
        )
    }

    if (orders.isNotEmpty()) {
        Spacer(Modifier.height(10.dp))
        SettingsCard {
            orders.forEachIndexed { i, order ->
                if (i > 0) SettingsDivider()
                val date = if (order.createdAt > 0) SimpleDateFormat("MMM d, yyyy", Locale.getDefault()).format(Date(order.createdAt)) else "—"
                SettingsRow(Icons.Default.Receipt, date, "${order.plan} · ${order.status} · ₹${order.amountPaise / 100.0}", showChevron = false)
            }
        }
    }
}

private fun formatTokens(n: Double): String = when {
    n >= 1_000_000 -> if (n % 1_000_000 == 0.0) "${(n / 1_000_000).toInt()}M" else "%.1fM".format(n / 1_000_000)
    n >= 1_000 -> if (n % 1_000 == 0.0) "${(n / 1_000).toInt()}K" else "%.1fK".format(n / 1_000)
    else -> n.roundToInt().toString()
}

private fun formatReset(iso: String?): String? = runCatching {
    val d = java.time.Instant.parse(iso ?: return null)
    "Resets " + java.time.format.DateTimeFormatter.ofPattern("MMM d, yyyy, h:mm a", Locale.getDefault()).withZone(java.time.ZoneId.systemDefault()).format(d)
}.getOrNull()

private fun usageLabel(type: String): String = when (type) {
    "chat_message" -> "Chat"; "web_search" -> "Search"; "voice_second" -> "Voice"; "sandbox_run" -> "Build"
    "attachment_upload" -> "Attachments"; "image_generation" -> "Image generation"
    "chat" -> "Chat"; "build" -> "Build"; "research" -> "Deep Research"; "teamup" -> "Team Up"; "spark" -> "Spark"; "automation" -> "Automations"; "code" -> "FridayX"; else -> type
}

/** Usage — the same balance as the web's Usage pane: this month's tokens (or the organization pool and your cap), when
 *  they renew and what used them, plus what your plan includes (all from GET /usage/quota). The weekly / 5-hour bars only
 *  appear for an older server that still sends them. */
@Composable
private fun UsageSection(onUpgrade: () -> Unit = {}) {
    var quota by remember { mutableStateOf<UsageQuota?>(null) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        quota = UsageApi.quota()
        loading = false
    }
    val q = quota
    when {
        loading -> Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp)) }
        q == null -> SettingsCard { SettingsRow(Icons.Default.DataUsage, "Usage unavailable", showChevron = false) }
        else -> Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    (if (q.isEnterprise) "Enterprise" else q.plan.replaceFirstChar { it.uppercase() }) + " plan",
                    color = FridayText, fontSize = 12.5.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier.clip(RoundedCornerShape(50)).background(FridaySurface).padding(horizontal = 10.dp, vertical = 4.dp),
                )
                Spacer(Modifier.weight(1f))
                if (!q.isEnterprise && q.plan.lowercase() != "premium") {
                    Text("Upgrade", color = FridayBg, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clip(RoundedCornerShape(50)).background(FridayText).clickable(onClick = onUpgrade).padding(horizontal = 12.dp, vertical = 5.dp))
                }
            }
            q.monthly?.let { UsageBar("This month", it, q.monthlyBreakdown, "Your tokens renew every month on the day your plan started. Use them whenever you like.") }
            q.orgPool?.let { UsageBar("Team pool (${q.orgSeats} seats)", it, q.monthlyBreakdown, null) }
            q.weekly?.let { UsageBar("Weekly Limit", it, q.breakdown, null) }
            q.rolling?.let { UsageBar("5-Hour Limit", it, q.rollingBreakdown, null) }
            if (q.credits > 0 || q.creditDrawn > 0) CreditsCard(q)
            q.memberCap?.let { UsageBar("Your Monthly Cap", it, emptyList(), "A personal sub-limit your org admin set within the shared pool.") }
            q.entitlements?.let { PlanIncludes(it) }
        }
    }
}

/** 2,450,000 → "2.45M", 12,300 → "12.3K" (the web's formatTokens). */
private fun compactTokens(n: Double): String {
    val v = maxOf(0.0, n)
    fun trim(x: Double, digits: Int) = String.format(java.util.Locale.US, "%.${digits}f", x).trimEnd('0').trimEnd('.')
    return when {
        v >= 1_000_000 -> trim(v / 1_000_000, 2) + "M"
        v >= 1_000 -> trim(v / 1_000, 1) + "K"
        else -> v.toLong().toString()
    }
}

@Composable
private fun UsageBar(title: String, bucket: UsageBreakdown?, breakdown: List<UsageBreakdownEntry>, help: String?) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(FridaySurface.copy(alpha = 0.5f)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(if (bucket != null) "${compactTokens(bucket.used)} / ${compactTokens(bucket.limit)} · ${bucket.pct}%" else "—", color = FridayMuted, fontSize = 13.sp)
        }
        if (bucket != null && bucket.limit > 0) {
            LinearProgressIndicator(
                progress = { bucket.pct / 100f },
                modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
                color = if (bucket.pct >= 90) FridayError else FridaySearch,
                trackColor = FridaySurface,
            )
        }
        formatReset(bucket?.resetAt)?.let { Text(it, color = FridayMuted, fontSize = 12.sp) }
        help?.let { Text(it, color = FridayMuted, fontSize = 12.sp) }
        if (breakdown.isNotEmpty()) Text(breakdown.joinToString("  ·  ") { "${usageLabel(it.type)} ${maxOf(0, it.percent)}%" }, color = FridayMuted, fontSize = 12.sp)
    }
}

/** Bonus credits (granted by the team or a programme) — used only after the month's tokens run out. */
@Composable
private fun CreditsCard(q: UsageQuota) {
    val usingCredits = (q.monthly ?: q.orgPool)?.let { it.limit > 0 && it.used >= it.limit } == true && q.credits > 0
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(FridaySurface.copy(alpha = 0.5f)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Bonus credits", color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text("${compactTokens(q.credits)} left", color = FridayMuted, fontSize = 13.sp)
        }
        if (q.creditDrawn > 0) Text("${compactTokens(q.creditDrawn)} used this month", color = FridayMuted, fontSize = 12.sp)
        Text(
            if (usingCredits) "You've used this month's tokens — you're now using your bonus credits."
            else "Used automatically after this month's tokens run out. They don't renew.",
            color = if (usingCredits) FridayText else FridayMuted, fontSize = 12.sp,
        )
    }
}

@Composable
private fun PlanIncludes(e: com.friday.app.data.api.PlanEntitlements) {
    val storage = if (e.libraryStorageMb >= 1024) "%.1f GB".format(e.libraryStorageMb / 1024.0) else "${e.libraryStorageMb} MB"
    val rows = listOf(
        "Build Mode" to if (e.buildMode) "${e.buildMaxRounds} rounds per run" else "Not included",
        "Deep Research" to if (e.deepResearchPerDay > 0) "${e.deepResearchPerDay} per day" else "Not included",
        "Documents" to "${e.documentsPerDay} per day",
        "Custom skills" to "${e.customSkills}",
        "Library storage" to storage,
        "Team Up" to "Up to ${e.teamUpModels} models",
        "MCP servers" to "${e.mcpServers}",
        "Automations" to "${e.automations}",
        "Support" to if (e.prioritySupport) "Priority" else "Standard",
    )
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).border(1.dp, FridayMuted.copy(alpha = 0.2f), RoundedCornerShape(14.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("What your plan includes", color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        rows.forEach { (k, v) ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(k, color = FridayMuted, fontSize = 13.5.sp)
                Text(v, color = FridayText, fontSize = 13.5.sp)
            }
        }
    }
}

@Composable
private fun DataControlsSection(vm: FridayViewModel, onAccountDeleted: () -> Unit) {
    val ctx = LocalContext.current
    var exporting by remember { mutableStateOf(false) }
    var showClearConfirm by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }

    SettingsCard {
        SettingsRow(
            icon = Icons.Default.Download,
            label = "Export chats",
            value = if (exporting) "…" else null,
            onClick = {
                if (!exporting) {
                    exporting = true
                    vm.exportData { json ->
                        exporting = false
                        if (json != null) shareExport(ctx, json)
                    }
                }
            },
        )
        SettingsDivider()
        SettingsRow(Icons.Default.Storage, "Clear all chats", tint = FridayError, showChevron = false, onClick = { showClearConfirm = true })
    }

    Spacer(Modifier.height(10.dp))
    SettingsCard {
        SettingsRow(
            icon = Icons.Default.DeleteForever,
            label = "Delete account",
            tint = FridayError,
            showChevron = false,
            onClick = { showDeleteConfirm = true },
        )
    }

    if (showClearConfirm) {
        AlertDialog(
            onDismissRequest = { showClearConfirm = false },
            title = { Text("Clear all chats?") },
            text = { Text("This deletes every synced conversation. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    showClearConfirm = false
                    vm.clearAllChats {}
                }) { Text("Clear", color = FridayError) }
            },
            dismissButton = { TextButton(onClick = { showClearConfirm = false }) { Text("Cancel") } },
        )
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { if (!deleting) showDeleteConfirm = false },
            title = { Text("Delete your account?") },
            text = { Text("This permanently deletes your account and all its data. This can't be undone.") },
            confirmButton = {
                TextButton(
                    enabled = !deleting,
                    onClick = {
                        deleting = true
                        vm.deleteAccount { ok ->
                            deleting = false
                            showDeleteConfirm = false
                            if (ok) onAccountDeleted()
                        }
                    },
                ) { Text(if (deleting) "Deleting…" else "Delete", color = FridayError) }
            },
            dismissButton = { TextButton(onClick = { showDeleteConfirm = false }, enabled = !deleting) { Text("Cancel") } },
        )
    }
}

private fun openNotificationSettings(ctx: android.content.Context) {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(AndroidSettings.EXTRA_APP_PACKAGE, ctx.packageName)
    } else {
        Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:${ctx.packageName}"))
    }
    runCatching { ctx.startActivity(intent) }
}

private fun playPreview(ctx: android.content.Context, bytes: ByteArray) {
    runCatching {
        val dir = File(ctx.cacheDir, "voice-preview").apply { mkdirs() }
        val file = File(dir, "preview.mp3")
        file.writeBytes(bytes)
        MediaPlayer().apply {
            setDataSource(file.absolutePath)
            setOnCompletionListener { release() }
            prepare()
            start()
        }
    }
}

private fun shareExport(ctx: android.content.Context, json: String) {
    runCatching {
        val dir = File(ctx.cacheDir, "exports").apply { mkdirs() }
        val file = File(dir, "friday-export.json")
        file.writeText(json)
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "application/json"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(Intent.createChooser(intent, "Save export").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        color = FridayMuted,
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier.padding(start = 8.dp, bottom = 6.dp),
    )
}

@Composable
private fun SettingsCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(FridayBg),
        content = content,
    )
}

@Composable
private fun SettingsDivider() {
    Box(Modifier.fillMaxWidth().padding(start = 52.dp).height(1.dp).background(Color(0x14000000)))
}

@Composable
private fun SettingsRow(
    icon: ImageVector,
    label: String,
    value: String? = null,
    tint: Color = FridayText,
    showChevron: Boolean = true,
    trailingIcon: ImageVector? = null,
    subtitle: String? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
        if (subtitle != null) {
            Column(Modifier.weight(1f)) {
                Text(label, color = tint, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                Text(subtitle, color = FridayMuted, fontSize = 13.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            }
        } else {
            Text(label, color = tint, fontSize = 15.sp, fontWeight = FontWeight.Normal, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        if (value != null) {
            Text(value, color = FridayMuted, fontSize = 13.5.sp, maxLines = 1)
        }
        if (trailingIcon != null) {
            Icon(trailingIcon, null, tint = FridaySearch, modifier = Modifier.size(18.dp))
        } else if (showChevron) {
            Icon(Icons.Default.ChevronRight, null, tint = FridayMuted, modifier = Modifier.size(18.dp))
        }
    }
}
