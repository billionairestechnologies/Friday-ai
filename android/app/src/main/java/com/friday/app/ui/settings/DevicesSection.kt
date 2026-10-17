package com.friday.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.api.DeviceSession
import com.friday.app.data.api.SessionsApi
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val Danger = Color(0xFFDC2626)

/** Settings → Devices: everywhere this account is signed in, same list as the web (supabase 0068). */
@Composable
internal fun DevicesSection() {
    var sessions by remember { mutableStateOf<List<DeviceSession>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var confirmOthers by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun load() {
        val r = SessionsApi.list()
        failed = r == null
        sessions = r ?: emptyList()
    }
    LaunchedEffect(Unit) { load() }
    val list = sessions
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Where your account is signed in. If you don't recognise one, sign it out — it stops working straight away.", color = FridayMuted, fontSize = 13.sp)
        when {
            list == null -> Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp)) }
            failed -> Text("Couldn't load your devices — check your connection.", color = FridayMuted, fontSize = 13.sp)
            else -> {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).border(1.dp, FridayMuted.copy(alpha = 0.2f), RoundedCornerShape(14.dp))) {
                    list.forEachIndexed { i, s ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Icon(
                                when (s.platform) { "cli" -> Icons.Default.Terminal; "android", "ios" -> Icons.Default.PhoneAndroid; else -> Icons.Default.Computer },
                                null, tint = FridayMuted, modifier = Modifier.size(20.dp),
                            )
                            Column(Modifier.weight(1f)) {
                                Text(s.client + if (s.current) "  · This device" else "", color = FridayText, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                                Text(
                                    listOfNotNull(if (s.current) "Active now" else lastActive(s.lastSeenAt), s.ipPrefix, signedIn(s.createdAt)).joinToString(" · "),
                                    color = FridayMuted, fontSize = 12.sp,
                                )
                            }
                            if (!s.current) {
                                Text(
                                    if (busy == s.id) "…" else "Sign out",
                                    color = FridayText, fontSize = 12.5.sp, fontWeight = FontWeight.Medium,
                                    modifier = Modifier.clip(RoundedCornerShape(50)).background(FridaySurface).clickable(enabled = busy == null) {
                                        busy = s.id
                                        scope.launch {
                                            if (SessionsApi.signOut(s)) sessions = sessions?.filter { it.id != s.id } else notice = "Couldn't sign that device out — try again."
                                            busy = null
                                        }
                                    }.padding(horizontal = 12.dp, vertical = 6.dp),
                                )
                            }
                        }
                        if (i < list.size - 1) Box(Modifier.fillMaxWidth().padding(horizontal = 14.dp).size(height = 1.dp, width = 1.dp).background(FridayMuted.copy(alpha = 0.15f)))
                    }
                }
                if (list.any { !it.current }) {
                    Text(
                        "Sign out everywhere else",
                        color = Danger, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                        modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, FridayMuted.copy(alpha = 0.3f), RoundedCornerShape(50)).clickable(enabled = busy == null) { confirmOthers = true }.padding(horizontal = 16.dp, vertical = 9.dp),
                    )
                }
                notice?.let { Text(it, color = FridayMuted, fontSize = 12.sp) }
            }
        }
    }
    if (confirmOthers) {
        AlertDialog(
            onDismissRequest = { confirmOthers = false },
            title = { Text("Sign out everywhere else?") },
            text = { Text("Every other browser, phone and FridayX sign-in will need to sign in again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmOthers = false
                    busy = "others"
                    scope.launch {
                        val n = SessionsApi.signOutOthers()
                        notice = when (n) { null -> "Couldn't sign the other devices out — try again."; 0 -> "No other devices were signed in."; 1 -> "Signed out 1 other device."; else -> "Signed out $n other devices." }
                        load()
                        busy = null
                    }
                }) { Text("Sign out", color = Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmOthers = false }) { Text("Cancel") } },
        )
    }
}

private fun lastActive(iso: String?): String {
    val at = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return "Not used yet"
    val mins = Duration.between(at, Instant.now()).toMinutes()
    return when {
        mins < 2 -> "Active now"
        mins < 60 -> "Active $mins min ago"
        mins < 24 * 60 -> "Active ${mins / 60} h ago"
        else -> "Active " + DateTimeFormatter.ofPattern("d MMM").withZone(ZoneId.systemDefault()).format(at)
    }
}

private fun signedIn(iso: String): String? =
    runCatching { "signed in " + DateTimeFormatter.ofPattern("d MMM yyyy").withZone(ZoneId.systemDefault()).format(Instant.parse(iso)) }.getOrNull()
