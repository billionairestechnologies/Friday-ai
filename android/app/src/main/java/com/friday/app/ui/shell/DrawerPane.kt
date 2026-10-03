package com.friday.app.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.LibraryBooks
import androidx.compose.material.icons.filled.AutoMode
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.SupportAgent
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.ChatThread
import com.friday.app.data.FridayUser
import com.friday.app.data.Sheet
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridaySoftBlue
import com.friday.app.ui.theme.FridayStop
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle as JTextStyle
import java.util.Locale

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun DrawerPane(
    user: FridayUser?,
    plan: String?,
    updateAvailable: Boolean = false,
    recents: List<ChatThread>,
    currentId: String?,
    onNewChat: () -> Unit,
    onOpenChat: (String) -> Unit,
    /** "chat" or "build": which workspace's history the list shows. */
    workspace: String = "chat",
    onNewBuild: () -> Unit = {},
    /** Build session id → status, for the status dot next to each build in the list. */
    buildStatuses: Map<String, String> = emptyMap(),
    onDeleteChat: (String) -> Unit = {},
    onOpenSheet: (Sheet) -> Unit,
    onNavigate: (String) -> Unit,
    onClose: () -> Unit,
    onUpdate: () -> Unit = {},
    /** True while the drawer is on screen — the Projects dropdown refreshes then. */
    drawerOpen: Boolean = false,
    onOpenProject: (String) -> Unit = {},
    onNewProject: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val webContext = androidx.compose.ui.platform.LocalContext.current
    val openWeb: (String) -> Unit = { path ->
        androidx.browser.customtabs.CustomTabsIntent.Builder().build()
            .launchUrl(webContext, android.net.Uri.parse("https://friday.billionairestechnologies.com$path"))
    }
    var query by remember { mutableStateOf("") }
    var pendingDelete by remember { mutableStateOf<ChatThread?>(null) }
    // Build sessions (and older chats that made a project) are listed under Build; chats under Chat.
    val filtered = recents.filter { it.title.contains(query, ignoreCase = true) && if (workspace == "build") it.isBuild else it.workspace != "build" }
    var hits by remember { mutableStateOf<List<com.friday.app.data.api.SearchHit>>(emptyList()) }
    var searchError by remember { mutableStateOf<String?>(null) }
    var actionChat by remember { mutableStateOf<ChatThread?>(null) }
    var shareNote by remember { mutableStateOf<String?>(null) }
    val drawerScope = androidx.compose.runtime.rememberCoroutineScope()
    val drawerCtx = androidx.compose.ui.platform.LocalContext.current
    // Debounced full-text search across message bodies (GET /api/chat/search); titles filter locally above.
    androidx.compose.runtime.LaunchedEffect(query, user?.email) {
        hits = emptyList(); searchError = null
        if (user == null || query.trim().length < 2) return@LaunchedEffect
        kotlinx.coroutines.delay(350)
        val r = com.friday.app.data.api.AgentApi.search(query.trim())
        hits = r.value ?: emptyList()
        searchError = r.error
    }

    Column(
        modifier
            .fillMaxHeight()
            .background(FridayBg)
            .statusBarsPadding(),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 18.dp)
                .clip(RoundedCornerShape(12.dp))
                .clickable { onNavigate("settings") }
                .padding(6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.size(38.dp).clip(CircleShape).background(FridaySoftBlue),
                contentAlignment = Alignment.Center,
            ) {
                Text((user?.name?.take(1) ?: "G").uppercase(), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = FridayText)
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        user?.name ?: "Guest",
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = FridayText,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Icon(Icons.Default.ExpandMore, null, tint = FridayMuted, modifier = Modifier.size(20.dp))
                }
                // A plain small-caps label, not a filled pill — reads as a status line under the
                // name rather than a second tappable button sitting next to it.
                if (user != null && plan != null) {
                    val free = plan.isNullOrBlank() || plan.equals("free", ignoreCase = true)
                    Text(
                        (plan?.replaceFirstChar { it.uppercase() } ?: "Free") + " plan",
                        // FridaySoftBlue is a pale pastel meant for fills/backgrounds, not text —
                        // used as a text color it read as barely legible light gray. FridaySearch
                        // is the same blue family but dark enough to actually read as text.
                        color = if (free) FridayMuted else FridaySearch,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
            Box(
                Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(FridaySurface)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Close, "Close menu", tint = FridayText, modifier = Modifier.size(18.dp))
            }
        }

        Column(Modifier.padding(horizontal = 12.dp)) {
            PlainRow(Icons.Default.Edit, "New chat", onNewChat)
            PlainRow(Icons.Default.Build, "Build", onNewBuild)
            PlainRow(Icons.AutoMirrored.Filled.LibraryBooks, "Library") { onNavigate("library") }
            PlainRow(Icons.Default.Description, "Pages") { onNavigate("pages") }
            PlainRow(Icons.Default.AutoMode, "Automations") { onNavigate("automations") }
            // Skills live in Plugins; Help & support and System status live in Settings (same as web).

            // Same as the web sidebar: a collapsible "Projects" group with a + button and one row per project.
            var projects by remember { mutableStateOf<List<com.friday.app.data.api.ProjectSummary>>(emptyList()) }
            var projectsOpen by remember { mutableStateOf(true) }
            androidx.compose.runtime.LaunchedEffect(drawerOpen, user?.email) {
                if (user == null) { projects = emptyList(); return@LaunchedEffect }
                com.friday.app.data.api.ProjectsApi.list()?.let { projects = it }
            }
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).clickable { projectsOpen = !projectsOpen }.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Icons.Default.KeyboardArrowDown, null, tint = FridayMuted, modifier = Modifier.size(16.dp).rotate(if (projectsOpen) 0f else -90f))
                    Text("Projects", color = FridayMuted, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                }
                Box(Modifier.size(36.dp).clip(CircleShape).clickable(onClick = onNewProject), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Add, "New project", tint = FridayMuted, modifier = Modifier.size(18.dp))
                }
            }
            if (projectsOpen) {
                if (projects.isEmpty()) Text("No projects yet", color = FridayMuted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                projects.forEach { p -> PlainRow(Icons.Default.Folder, p.name) { onOpenProject(p.id) } }
            }
        }

        Spacer(Modifier.height(16.dp))
        Text(
            if (workspace == "build") "Builds" else "Conversations",
            color = FridayMuted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(start = 24.dp, bottom = 6.dp),
        )

        actionChat?.let { chat ->
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { actionChat = null },
                title = { Text(chat.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                text = {
                    Column {
                        Text(
                            "Copy a public read-only link", color = FridayText, fontSize = 16.sp,
                            modifier = Modifier.fillMaxWidth().clickable {
                                actionChat = null
                                drawerScope.launch {
                                    val r = com.friday.app.data.api.AgentApi.shareConversation(chat.id)
                                    val link = r.value
                                    if (link != null) {
                                        val cm = drawerCtx.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                                        cm.setPrimaryClip(android.content.ClipData.newPlainText("Friday chat link", link))
                                        android.widget.Toast.makeText(drawerCtx, "Link copied — anyone with it can read this chat", android.widget.Toast.LENGTH_LONG).show()
                                    } else {
                                        android.widget.Toast.makeText(drawerCtx, r.error ?: "Couldn't create a link", android.widget.Toast.LENGTH_LONG).show()
                                    }
                                }
                            }.padding(vertical = 12.dp),
                        )
                        Text(
                            "Turn off sharing", color = FridayText, fontSize = 16.sp,
                            modifier = Modifier.fillMaxWidth().clickable {
                                actionChat = null
                                drawerScope.launch {
                                    val r = com.friday.app.data.api.AgentApi.unshareConversation(chat.id)
                                    android.widget.Toast.makeText(drawerCtx, if (r.error == null) "Sharing turned off" else r.error, android.widget.Toast.LENGTH_LONG).show()
                                }
                            }.padding(vertical = 12.dp),
                        )
                        Text(
                            "Delete chat", color = com.friday.app.ui.theme.FridayError, fontSize = 16.sp,
                            modifier = Modifier.fillMaxWidth().clickable { pendingDelete = chat; actionChat = null }.padding(vertical = 12.dp),
                        )
                    }
                },
                confirmButton = { androidx.compose.material3.TextButton(onClick = { actionChat = null }) { Text("Close") } },
            )
        }

        pendingDelete?.let { chat ->
            androidx.compose.material3.AlertDialog(
                onDismissRequest = { pendingDelete = null },
                title = { Text("Delete chat?") },
                text = { Text("\"${chat.title}\" will be deleted on all your devices.") },
                confirmButton = {
                    androidx.compose.material3.TextButton(onClick = { onDeleteChat(chat.id); pendingDelete = null }) { Text("Delete") }
                },
                dismissButton = {
                    androidx.compose.material3.TextButton(onClick = { pendingDelete = null }) { Text("Cancel") }
                },
            )
        }

        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
            if (searchError != null) Text("Search failed: $searchError", color = com.friday.app.ui.theme.FridayError, fontSize = 13.sp, modifier = Modifier.padding(12.dp))
            if (hits.isNotEmpty()) {
                Text("In messages", color = FridayMuted, fontSize = 13.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp))
                hits.forEach { h ->
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onOpenChat(h.conversationId) }.padding(horizontal = 14.dp, vertical = 10.dp),
                    ) {
                        Text(h.title, color = FridayText, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(h.snippet, color = FridayMuted, fontSize = 12.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
            if (filtered.isEmpty()) {
                Text(if (query.isNotBlank()) "No matching titles" else if (workspace == "build") "No builds yet — describe an app to start one" else "No conversations yet", color = FridayMuted, fontSize = 14.sp, modifier = Modifier.padding(12.dp))
            } else {
                filtered.forEach { chat ->
                    val active = chat.id == currentId
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (active) FridaySurface else Color.Transparent)
                            .combinedClickable(onClick = { onOpenChat(chat.id) }, onLongClick = { actionChat = chat })
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val dot = if (workspace == "build") com.friday.app.ui.buildmode.buildStatusMeta(buildStatuses[chat.id]) else null
                            // A chat still producing its answer shows a round spinner until it finishes (like web).
                            if (chat.messages.any { it.isStreaming }) {
                                androidx.compose.material3.CircularProgressIndicator(
                                    modifier = Modifier.size(14.dp),
                                    strokeWidth = 2.dp,
                                    color = androidx.compose.ui.graphics.Color(0xFF0EA5E9),
                                )
                                Spacer(Modifier.width(8.dp))
                            } else if (dot != null) {
                                Box(Modifier.size(7.dp).clip(CircleShape).background(dot.first))
                                Spacer(Modifier.width(8.dp))
                            }
                            Text(
                                chat.title,
                                color = FridayText,
                                fontSize = 15.sp,
                                fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(relativeDay(chat.updatedAt), color = FridayMuted, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(FridayBg)
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(FridaySurface).clickable { onNavigate("settings") },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Settings, "Settings", tint = FridayText, modifier = Modifier.size(19.dp))
            }
            Row(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(20.dp))
                    .background(FridaySurface)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Default.Search, null, tint = FridayMuted, modifier = Modifier.size(16.dp))
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    textStyle = TextStyle(color = FridayText, fontSize = 14.5.sp),
                    modifier = Modifier.weight(1f),
                    decorationBox = { inner ->
                        Box {
                            if (query.isEmpty()) Text("Search", color = FridayMuted, fontSize = 14.5.sp)
                            inner()
                        }
                    },
                )
            }
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(FridayText).clickable(onClick = onNewChat),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Edit, "New chat", tint = FridayBg, modifier = Modifier.size(17.dp))
            }
        }
        if (updateAvailable) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 10.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Brush.horizontalGradient(listOf(FridayStop, FridaySearch)))
                    .clickable(onClick = onUpdate)
                    .padding(horizontal = 14.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(Icons.Default.SystemUpdate, null, tint = Color.White, modifier = Modifier.size(19.dp))
                Text("Update available", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                Icon(Icons.AutoMirrored.Filled.ArrowForward, null, tint = Color.White, modifier = Modifier.size(16.dp))
            }
        }
        if (user == null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 14.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(FridaySurface)
                    .clickable { onOpenSheet(Sheet.Auth) }
                    .padding(horizontal = 14.dp, vertical = 13.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Icon(Icons.Default.Person, null, tint = FridayText, modifier = Modifier.size(19.dp))
                Text("Log in to sync", color = FridayText, fontSize = 15.sp)
            }
        }
        Spacer(Modifier.navigationBarsPadding())
    }
}

private fun relativeDay(millis: Long): String {
    val zone = ZoneId.systemDefault()
    val date = Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()
    val today = Instant.now().atZone(zone).toLocalDate()
    val days = today.toEpochDay() - date.toEpochDay()
    return when {
        days <= 0L -> "Today"
        days == 1L -> "Yesterday"
        days < 7L -> date.dayOfWeek.getDisplayName(JTextStyle.FULL, Locale.getDefault())
        else -> "${date.monthValue}/${date.dayOfMonth}"
    }
}

@Composable
private fun PlainRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, null, tint = FridayText, modifier = Modifier.size(21.dp))
        Text(label, color = FridayText, fontSize = 16.sp, fontWeight = FontWeight.Normal)
    }
}
