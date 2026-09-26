package com.friday.app.ui.agent

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.api.AgentApi
import com.friday.app.data.api.Automation
import com.friday.app.data.api.McpServer
import com.friday.app.data.api.MemoryItem
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridaySidebar
import com.friday.app.ui.theme.FridaySuccess
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch
import java.util.TimeZone

@Composable
private fun Card(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(FridayBg).padding(14.dp), content = content)
}

@Composable
private fun ErrorText(message: String?) {
    if (message != null) Text(message, color = FridayError, fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp))
}

@Composable
private fun Pill(label: String, onClick: () -> Unit, filled: Boolean = true, danger: Boolean = false, enabled: Boolean = true) {
    val bg = if (!filled) FridaySurface else if (danger) FridayError else FridayText
    val fg = if (!filled) (if (danger) FridayError else FridayText) else FridayBg
    Text(
        label, color = fg, fontSize = 14.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(bg).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 9.dp),
    )
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, singleLine: Boolean = true, minLines: Int = 1) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = singleLine, minLines = minLines,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    )
}

/** Settings > Memory — what Friday remembers about the user (GET/POST/DELETE /api/memory). */
@Composable
fun MemoryContent() {
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<MemoryItem>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var confirmClear by remember { mutableStateOf(false) }

    fun reload() = scope.launch {
        val r = AgentApi.memories()
        items = r.value ?: items ?: emptyList()
        error = r.error
    }
    LaunchedEffect(Unit) { reload() }

    Text("Facts Friday keeps across chats. Ask it to \"remember …\" in a conversation, or add one here.", color = FridayMuted, fontSize = 13.5.sp)
    Spacer(Modifier.height(12.dp))
    Card {
        Field(draft, { draft = it }, "Add a memory", singleLine = false, minLines = 2)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Pill("Save", enabled = draft.isNotBlank(), onClick = {
                val text = draft.trim()
                scope.launch {
                    val r = AgentApi.addMemory(text)
                    if (r.error != null) error = r.error else { draft = ""; reload() }
                }
            })
        }
    }
    ErrorText(error)
    Spacer(Modifier.height(12.dp))
    val list = items
    when {
        list == null -> Text("Loading…", color = FridayMuted, fontSize = 14.sp)
        list.isEmpty() -> Text("Nothing remembered yet.", color = FridayMuted, fontSize = 14.sp)
        else -> {
            list.forEach { m ->
                Card {
                    Text(m.content, color = FridayText, fontSize = 14.5.sp)
                    Text(
                        "Forget", color = FridayError, fontSize = 13.sp, fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(top = 8.dp).clickable {
                            scope.launch {
                                val r = AgentApi.deleteMemory(m.id)
                                if (r.error != null) error = r.error else reload()
                            }
                        },
                    )
                }
                Spacer(Modifier.height(8.dp))
            }
            Pill("Clear all memories", filled = false, danger = true, onClick = { confirmClear = true })
        }
    }
    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Clear all memories?") },
            text = { Text("Friday will forget everything it saved about you. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    scope.launch {
                        val r = AgentApi.clearMemories()
                        if (r.error != null) error = r.error else reload()
                    }
                }) { Text("Clear", color = FridayError) }
            },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
        )
    }
}

/** Settings > MCP servers — remote MCP servers whose tools Friday can call (/api/mcp). */
@Composable
fun ConnectorsContent() {
    val scope = rememberCoroutineScope()
    var servers by remember { mutableStateOf<List<McpServer>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var auth by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }

    fun reload() = scope.launch {
        val r = AgentApi.mcpServers()
        servers = r.value ?: servers ?: emptyList()
        error = r.error
    }
    LaunchedEffect(Unit) { reload() }

    Text("Connect a remote MCP server (https) and Friday can use its tools in chat.", color = FridayMuted, fontSize = 13.5.sp)
    Spacer(Modifier.height(12.dp))
    Card {
        Field(name, { name = it }, "Name")
        Field(url, { url = it }, "Server URL (https://…)")
        Field(auth, { auth = it }, "Authorization header (optional)")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Pill(if (adding) "Connecting…" else "Connect", enabled = !adding && name.isNotBlank() && url.isNotBlank(), onClick = {
                adding = true; error = null; notice = null
                scope.launch {
                    val r = AgentApi.addMcpServer(name.trim(), url.trim(), auth.trim())
                    adding = false
                    if (r.error != null) error = r.error else {
                        notice = "Connected — ${r.value?.size ?: 0} tools available."
                        name = ""; url = ""; auth = ""; reload()
                    }
                }
            })
        }
    }
    ErrorText(error)
    if (notice != null) Text(notice!!, color = FridaySuccess, fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp))
    Spacer(Modifier.height(12.dp))
    val list = servers
    when {
        list == null -> Text("Loading…", color = FridayMuted, fontSize = 14.sp)
        list.isEmpty() -> Text("No servers connected.", color = FridayMuted, fontSize = 14.sp)
        else -> list.forEach { s ->
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(s.name, color = FridayText, fontSize = 15.5.sp, fontWeight = FontWeight.Medium)
                        Text(s.url, color = FridayMuted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Switch(checked = s.enabled, onCheckedChange = { on ->
                        scope.launch {
                            val r = AgentApi.setMcpEnabled(s.id, on)
                            if (r.error != null) error = r.error
                            reload()
                        }
                    })
                }
                Text(
                    "Remove", color = FridayError, fontSize = 13.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier.padding(top = 8.dp).clickable {
                        scope.launch {
                            val r = AgentApi.deleteMcpServer(s.id)
                            if (r.error != null) error = r.error else reload()
                        }
                    },
                )
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

private val FREQUENCIES = listOf("hourly" to "Hourly", "daily" to "Daily", "weekdays" to "Weekdays", "weekly" to "Weekly")
private val DAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

private fun describe(a: Automation): String {
    val freq = FREQUENCIES.firstOrNull { it.first == a.frequency }?.second ?: a.frequency
    return when (a.frequency) {
        "hourly" -> "Every hour"
        "weekly" -> "$freq on ${DAYS.getOrNull(a.weekday ?: 0) ?: "Sun"} at ${a.timeOfDay}"
        else -> "$freq at ${a.timeOfDay}"
    } + if (a.research) " · Deep Research" else ""
}

/** Full-page Automations — scheduled Friday runs (/api/automations). Replaces the old "coming soon" stub. */
@Composable
fun AutomationsScreen(onClose: () -> Unit, onOpenChat: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<Automation>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }

    fun reload() = scope.launch {
        val r = AgentApi.automations()
        items = r.value ?: items ?: emptyList()
        error = r.error
    }
    LaunchedEffect(Unit) { reload() }

    Column(Modifier.fillMaxSize().background(FridaySidebar).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Automations", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = FridayText, modifier = Modifier.weight(1f))
            Pill("New", onClick = { creating = true })
            Spacer(Modifier.padding(horizontal = 4.dp))
            Box(Modifier.clip(CircleShape).background(FridayBg).clickable(onClick = onClose).padding(8.dp)) {
                Icon(Icons.Default.Close, "Close", tint = FridayText)
            }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            Text("Friday runs these prompts on a schedule and notifies you with the result.", color = FridayMuted, fontSize = 13.5.sp)
            ErrorText(error)
            if (notice != null) Text(notice!!, color = FridaySuccess, fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp))
            Spacer(Modifier.height(12.dp))
            val list = items
            when {
                list == null -> Text("Loading…", color = FridayMuted, fontSize = 14.sp)
                list.isEmpty() -> Text("No automations yet. Tap New to schedule one.", color = FridayMuted, fontSize = 14.sp)
                else -> list.forEach { a ->
                    Card {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(a.title, color = FridayText, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                                Text(describe(a), color = FridayMuted, fontSize = 12.5.sp)
                            }
                            Switch(checked = a.enabled, onCheckedChange = { on ->
                                scope.launch {
                                    val r = AgentApi.setAutomationEnabled(a.id, on)
                                    if (r.error != null) error = r.error
                                    reload()
                                }
                            })
                        }
                        Text(a.prompt, color = FridayText, fontSize = 13.5.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                        if (a.lastStatus == "error") Text("Last run failed${a.lastError?.let { ": $it" } ?: ""}", color = FridayError, fontSize = 12.5.sp, modifier = Modifier.padding(top = 6.dp))
                        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Pill("Run now", filled = false, onClick = {
                                error = null
                                scope.launch {
                                    val r = AgentApi.runAutomation(a.id)
                                    if (r.error != null) error = r.error else { notice = "Started “${a.title}”. You'll get a notification when it's done."; reload() }
                                }
                            })
                            if (a.conversationId != null) Pill("Open chat", filled = false, onClick = { onOpenChat(a.conversationId) })
                            Pill("Delete", filled = false, danger = true, onClick = {
                                scope.launch {
                                    val r = AgentApi.deleteAutomation(a.id)
                                    if (r.error != null) error = r.error else reload()
                                }
                            })
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                }
            }
        }
    }

    if (creating) {
        var title by remember { mutableStateOf("") }
        var prompt by remember { mutableStateOf("") }
        var frequency by remember { mutableStateOf("daily") }
        var time by remember { mutableStateOf("09:00") }
        var weekday by remember { mutableStateOf(1) }
        var research by remember { mutableStateOf(false) }
        var saving by remember { mutableStateOf(false) }
        var formError by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { if (!saving) creating = false },
            title = { Text("New automation") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Field(title, { title = it }, "Title")
                    Field(prompt, { prompt = it }, "What should Friday do?", singleLine = false, minLines = 3)
                    Text("Repeat", color = FridayMuted, fontSize = 12.5.sp, modifier = Modifier.padding(top = 8.dp))
                    Row(Modifier.padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FREQUENCIES.forEach { (id, label) ->
                            Text(
                                label, fontSize = 13.sp, color = if (frequency == id) FridayBg else FridayText,
                                modifier = Modifier.clip(RoundedCornerShape(50)).background(if (frequency == id) FridayText else FridaySurface)
                                    .clickable { frequency = id }.padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                    }
                    if (frequency == "weekly") {
                        Row(Modifier.padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            DAYS.forEachIndexed { i, d ->
                                Text(
                                    d, fontSize = 12.sp, color = if (weekday == i) FridayBg else FridayText,
                                    modifier = Modifier.clip(RoundedCornerShape(50)).background(if (weekday == i) FridaySearch else FridaySurface)
                                        .clickable { weekday = i }.padding(horizontal = 8.dp, vertical = 6.dp),
                                )
                            }
                        }
                    }
                    if (frequency != "hourly") Field(time, { time = it }, "Time (HH:MM, 24h)")
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                        Text("Use Deep Research", color = FridayText, fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Switch(checked = research, onCheckedChange = { research = it })
                    }
                    ErrorText(formError)
                }
            },
            confirmButton = {
                TextButton(enabled = !saving && title.isNotBlank() && prompt.isNotBlank(), onClick = {
                    saving = true; formError = null
                    scope.launch {
                        val r = AgentApi.createAutomation(
                            title.trim(), prompt.trim(), frequency, time.trim().ifBlank { "09:00" },
                            if (frequency == "weekly") weekday else null, TimeZone.getDefault().id, research,
                        )
                        saving = false
                        if (r.error != null) formError = r.error else { creating = false; reload() }
                    }
                }) { Text(if (saving) "Saving…" else "Create") }
            },
            dismissButton = { TextButton(onClick = { creating = false }, enabled = !saving) { Text("Cancel") } },
        )
    }
}
