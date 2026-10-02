package com.friday.app.ui.plugins

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.api.ConnectorAccount
import com.friday.app.data.api.ConnectorPreviewItem
import com.friday.app.data.api.ConnectorSpec
import com.friday.app.data.api.FEATURED_PLUGINS
import com.friday.app.data.api.PLUGIN_CATEGORIES
import com.friday.app.data.api.PluginItem
import com.friday.app.data.api.PluginsApi
import com.friday.app.data.api.Skill
import com.friday.app.ui.skills.SkillsList
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayChip
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch

private fun pluginColor(id: String): Color? = PLUGIN_COLORS[id]?.let { Color(it) }

/** The plugin's mark in its tinted tile — the real brand paths (same as web); Razorpay / Canva / Finance have no
 *  public mark, so a monogram / generic icon, never a faked logo. */
@Composable
fun PluginTile(id: String, size: Dp = 38.dp) {
    val brand = pluginColor(id)
    val color = brand ?: FridayText
    Box(
        Modifier.size(size).clip(RoundedCornerShape(size * 0.28f)).background(brand?.copy(alpha = 0.12f) ?: FridayChip),
        contentAlignment = Alignment.Center,
    ) {
        val path = PLUGIN_PATHS[id]
        when {
            path != null -> {
                val parsed = remember(id) { PathParser().parsePathString(path).toPath() }
                Canvas(Modifier.size(size * 0.52f)) {
                    scale(this.size.width / 24f, pivot = Offset.Zero) { drawPath(parsed, color) }
                }
            }
            id == "razorpay" -> Text("R", color = color, fontSize = (size.value * 0.46f).sp, fontWeight = FontWeight.ExtraBold)
            id == "canva" -> Text("C", color = color, fontSize = (size.value * 0.46f).sp, fontWeight = FontWeight.Bold)
            else -> Icon(Icons.Default.AccountBalance, null, tint = color, modifier = Modifier.size(size * 0.46f))
        }
    }
}

/**
 * Plugins: connectors by category (real connect / disconnect / preview from the backend) and Skills — the same two
 * tabs as the web's Plugins drawer.
 */
@Composable
fun PluginsScreen(signedIn: Boolean, onClose: () -> Unit, onUseSkill: (Skill) -> Unit) {
    var tab by remember { mutableStateOf("connectors") }
    var query by remember { mutableStateOf("") }
    var specs by remember { mutableStateOf<Map<String, ConnectorSpec>>(emptyMap()) }
    var accounts by remember { mutableStateOf<List<ConnectorAccount>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var active by remember { mutableStateOf<PluginItem?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        if (!signedIn) { loaded = true; return }
        PluginsApi.config()?.let { specs = it }
        PluginsApi.accounts()?.let { accounts = it }
        loaded = true
    }
    LaunchedEffect(signedIn) { load() }
    // Coming back from the browser after an OAuth sign-in: refresh what is connected.
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event -> if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) scope.launch { load() } }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    fun providerOf(p: PluginItem): String? = specs.entries.firstOrNull { p.id in it.value.pluginIds }?.key
    fun connected(p: PluginItem): Boolean = providerOf(p)?.let { prov -> accounts.any { it.provider == prov } } == true

    Column(Modifier.fillMaxSize().background(FridayBg).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 16.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Plugins", color = FridayText, fontSize = 22.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            Box(Modifier.size(40.dp).clickable(onClick = onClose), contentAlignment = Alignment.Center) { Icon(Icons.Default.Close, "Close", tint = FridayText) }
        }
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("connectors" to "Connectors", "skills" to "Skills").forEach { (id, label) ->
                Text(
                    label,
                    color = if (tab == id) FridayBg else FridayText,
                    fontSize = 13.sp,
                    modifier = Modifier.clip(RoundedCornerShape(50)).background(if (tab == id) FridayText else FridaySurface).clickable { tab = id }.padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }
        if (tab == "skills") {
            SkillsList(onUse = onUseSkill)
            return@Column
        }
        OutlinedTextField(query, { query = it }, placeholder = { Text("Search…") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp))
        when {
            !signedIn -> Text("Log in to connect your apps.", color = FridayMuted, fontSize = 14.sp, modifier = Modifier.padding(20.dp))
            !loaded -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp) }
            else -> {
                val q = query.trim().lowercase()
                val matches = FEATURED_PLUGINS.filter { q.isEmpty() || it.name.lowercase().contains(q) || it.desc.lowercase().contains(q) }
                Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    val on = matches.filter { connected(it) }
                    if (on.isNotEmpty()) PluginSection("Connected", on, ::connected, { p -> providerOf(p)?.let { prov -> accounts.firstOrNull { it.provider == prov }?.accountLogin } }) { active = it }
                    PLUGIN_CATEGORIES.forEach { category ->
                        val items = matches.filter { it.category == category && !connected(it) }
                        if (items.isNotEmpty()) PluginSection(category, items, ::connected, { null }) { active = it }
                    }
                }
            }
        }
    }

    active?.let { plugin ->
        val provider = providerOf(plugin)
        PluginDetailDialog(
            plugin = plugin,
            provider = provider,
            spec = provider?.let { specs[it] },
            account = provider?.let { prov -> accounts.firstOrNull { it.provider == prov } },
            onClose = { active = null },
            onChanged = { scope.launch { load() } },
        )
    }
}

@Composable
private fun PluginSection(title: String, items: List<PluginItem>, isOn: (PluginItem) -> Boolean, accountOf: (PluginItem) -> String?, onOpen: (PluginItem) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, color = FridayText, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        items.forEach { p ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { onOpen(p) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PluginTile(p.id)
                Column(Modifier.weight(1f)) {
                    Text(p.name, color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    Text(accountOf(p) ?: p.desc, color = FridayMuted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(
                    if (isOn(p)) "On" else "Add",
                    color = if (isOn(p)) FridayText else FridayMuted,
                    fontSize = 12.5.sp,
                    modifier = Modifier.clip(RoundedCornerShape(50)).background(if (isOn(p)) FridayChip else FridayBg).padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun PluginDetailDialog(
    plugin: PluginItem,
    provider: String?,
    spec: ConnectorSpec?,
    account: ConnectorAccount?,
    onClose: () -> Unit,
    onChanged: () -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var values by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    var preview by remember { mutableStateOf<List<ConnectorPreviewItem>>(emptyList()) }
    LaunchedEffect(account?.id) {
        preview = if (provider != null && account != null) PluginsApi.preview(provider) else emptyList()
    }
    AlertDialog(
        onDismissRequest = onClose,
        confirmButton = { TextButton(onClick = onClose) { Text("Done") } },
        title = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PluginTile(plugin.id, 44.dp)
                Column {
                    Text(plugin.name, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                    Text(plugin.desc, color = FridayMuted, fontSize = 13.sp)
                }
            }
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                notice?.let { Text(it, color = FridayMuted, fontSize = 13.5.sp) }
                when {
                    account != null && provider != null -> {
                        Text("Connected as ${account.accountLogin ?: "your account"}.", fontSize = 14.sp)
                        preview.forEach { item ->
                            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(FridayChip).padding(10.dp)) {
                                Text(item.title, fontSize = 14.sp)
                                item.subtitle?.let { Text(it, color = FridayMuted, fontSize = 12.sp) }
                            }
                        }
                        TextButton(enabled = !busy, onClick = {
                            busy = true
                            scope.launch { notice = if (PluginsApi.disconnect(provider)) "Disconnected." else "Couldn't disconnect."; busy = false; onChanged() }
                        }) { Text("Disconnect", color = FridayError) }
                    }
                    spec != null && provider != null && spec.mode == "oauth" -> {
                        Text(
                            if (spec.configured) "Connect ${plugin.name} with a secure sign-in in your browser. Come back here when you are done." else "${plugin.name} sign-in isn't set up yet.",
                            color = FridayMuted, fontSize = 14.sp,
                        )
                        TextButton(enabled = !busy && spec.configured, onClick = {
                            busy = true
                            scope.launch {
                                val url = PluginsApi.oauthStart(provider)
                                if (url != null) androidx.browser.customtabs.CustomTabsIntent.Builder().build().launchUrl(ctx, android.net.Uri.parse(url))
                                else notice = "Couldn't start the sign-in. Try again."
                                busy = false
                            }
                        }) { Text("Connect ${plugin.name}") }
                    }
                    spec != null && provider != null -> {
                        spec.fields.forEach { f ->
                            OutlinedTextField(
                                value = values[f.key].orEmpty(),
                                onValueChange = { values = values + (f.key to it) },
                                label = { Text(f.label) },
                                placeholder = f.placeholder?.let { { Text(it) } },
                                singleLine = true,
                                visualTransformation = if (f.secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                            )
                        }
                        TextButton(enabled = !busy, onClick = {
                            busy = true
                            scope.launch {
                                val error = PluginsApi.connect(provider, values)
                                notice = error ?: "Connected."
                                if (error == null) values = emptyMap()
                                busy = false
                                onChanged()
                            }
                        }) { Text(if (busy) "Connecting…" else "Connect") }
                    }
                    else -> Text("This plugin isn't available yet.", color = FridayMuted, fontSize = 14.sp)
                }
            }
        },
    )
}
