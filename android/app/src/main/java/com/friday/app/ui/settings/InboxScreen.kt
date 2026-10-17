package com.friday.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.ui.FridayViewModel
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Notifications inbox (GET /notifications, supabase 0062) — the same list as the web's sidebar bell:
 * credits granted, programme decisions, and anything else sent to this person. Opening it marks
 * everything read; unread rows keep their dot until then.
 */
@Composable
fun InboxScreen(vm: FridayViewModel, onBack: () -> Unit) {
    val ui by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.refreshInbox() }
    // Mark read after the first frame so the person still sees which ones were new.
    LaunchedEffect(ui.unreadNotifications) { if (ui.unreadNotifications > 0) { kotlinx.coroutines.delay(1500); vm.openedInbox() } }
    Column(Modifier.fillMaxSize().background(FridayBg).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onBack), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = FridayText)
            }
            Text("Notifications", color = FridayText, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 6.dp))
        }
        if (ui.inbox.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("You're all caught up.", color = FridayMuted, fontSize = 14.sp)
            }
        } else {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(ui.inbox, key = { it.id }) { n ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(FridaySurface).padding(14.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(Modifier.padding(top = 6.dp).size(8.dp).clip(CircleShape).background(if (n.read) FridaySurface else FridaySearch))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(n.title, color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                            if (n.body.isNotBlank()) com.friday.app.ui.chat.MarkdownText(n.body)
                            shortDate(n.createdAt)?.let { Text(it, color = FridayMuted, fontSize = 12.sp) }
                        }
                    }
                }
                item { Spacer(Modifier.size(8.dp)) }
            }
        }
    }
}

private fun shortDate(iso: String): String? = runCatching {
    DateTimeFormatter.ofPattern("d MMM, h:mm a").withZone(ZoneId.systemDefault()).format(Instant.parse(iso))
}.getOrNull()
