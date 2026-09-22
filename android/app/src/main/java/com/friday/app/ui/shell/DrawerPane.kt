package com.friday.app.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.material.icons.filled.AutoMode
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
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
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle as JTextStyle
import java.util.Locale

@Composable
fun DrawerPane(
    user: FridayUser?,
    plan: String?,
    updateAvailable: Boolean = false,
    recents: List<ChatThread>,
    currentId: String?,
    onNewChat: () -> Unit,
    onOpenChat: (String) -> Unit,
    onOpenSheet: (Sheet) -> Unit,
    onNavigate: (String) -> Unit,
    onClose: () -> Unit,
    onUpdate: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var query by remember { mutableStateOf("") }
    val filtered = recents.filter { it.title.contains(query, ignoreCase = true) }

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
                if (user != null) {
                    val free = plan.isNullOrBlank() || plan.equals("free", ignoreCase = true)
                    Text(
                        (plan?.replaceFirstChar { it.uppercase() } ?: "Free") + " plan",
                        color = if (free) FridayMuted else FridaySoftBlue,
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
            PlainRow(Icons.Default.AutoMode, "Automations") { onNavigate("automations") }
            PlainRow(Icons.Default.Folder, "Projects") { onNavigate("library") }
        }

        Spacer(Modifier.height(16.dp))
        Text(
            "Conversations",
            color = FridayMuted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(start = 24.dp, bottom = 6.dp),
        )

        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
            if (filtered.isEmpty()) {
                Text("No conversations yet", color = FridayMuted, fontSize = 14.sp, modifier = Modifier.padding(12.dp))
            } else {
                filtered.forEach { chat ->
                    val active = chat.id == currentId
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (active) FridaySurface else Color.Transparent)
                            .clickable { onOpenChat(chat.id) }
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                    ) {
                        Text(
                            chat.title,
                            color = FridayText,
                            fontSize = 15.sp,
                            fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
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
