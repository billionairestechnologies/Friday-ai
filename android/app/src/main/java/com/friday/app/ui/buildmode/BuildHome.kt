package com.friday.app.ui.buildmode

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.BuildSessionSummary
import com.friday.app.ui.theme.FridayChip
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText

private val NeedsInput = Color(0xFFD97706)

/** Colour + label for a session status (running | needs_input | done | error | idle). */
fun buildStatusMeta(status: String?): Pair<Color, String>? = when (status) {
    "needs_input" -> NeedsInput to "Needs input"
    "running" -> FridaySearch to "Running"
    "done" -> FridayMuted to "Done"
    "error" -> FridayError to "Error"
    "idle" -> FridayChip to "Stopped"
    else -> null
}

fun relativeTime(ms: Long): String {
    if (ms <= 0) return ""
    val m = (System.currentTimeMillis() - ms) / 60000
    return when {
        m < 1 -> "just now"
        m < 60 -> "${m}m ago"
        m < 60 * 24 -> "${m / 60}h ago"
        m < 60 * 24 * 7 -> "${m / 60 / 24}d ago"
        else -> "${m / 60 / 24 / 7}w ago"
    }
}

/** Build workspace home (Claude Code layout): welcome, Sessions with live status, Pull requests. */
@Composable
fun BuildHome(
    firstName: String?,
    sessions: List<BuildSessionSummary>,
    loaded: Boolean,
    error: String?,
    onOpen: (String) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ctx = LocalContext.current
    var showAll by remember { mutableStateOf(false) }
    val ordered = sessions.sortedWith(compareBy<BuildSessionSummary> { if (it.status == "needs_input") 0 else if (it.status == "running") 1 else 2 }.thenByDescending { it.updatedAt })
    val shown = if (showAll) ordered else ordered.take(3)
    val prs = sessions.filter { it.prUrl != null }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(FridaySurface), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Build, null, tint = FridayText, modifier = Modifier.size(16.dp))
            }
            Spacer(Modifier.width(10.dp))
            Text(if (firstName.isNullOrBlank()) "Welcome to Build" else "Welcome back, $firstName", color = FridayText, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        }

        Row(Modifier.fillMaxWidth().padding(top = 28.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Sessions", color = FridayText, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            if (ordered.size > 3) {
                Text(if (showAll) "Show less" else "Show ${ordered.size - 3} more", color = FridayMuted, fontSize = 12.sp, modifier = Modifier.clickable { showAll = !showAll })
            }
        }
        when {
            error != null -> Text(error, color = FridayError, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(FridaySurface).clickable(onClick = onRetry).padding(14.dp))
            !loaded -> repeat(3) { Box(Modifier.fillMaxWidth().padding(bottom = 8.dp).height(56.dp).clip(RoundedCornerShape(12.dp)).background(FridaySurface)) }
            shown.isEmpty() -> Text(
                "No builds yet. Describe an app below — Friday plans it with you, then builds, runs and previews it.",
                color = FridayMuted, fontSize = 13.sp, lineHeight = 18.sp,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(FridaySurface).padding(16.dp),
            )
            else -> shown.forEach { s ->
                val meta = buildStatusMeta(s.status)
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(RoundedCornerShape(12.dp)).background(FridaySurface).clickable { onOpen(s.id) }.padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (meta != null) {
                                Box(Modifier.size(6.dp).clip(CircleShape).background(meta.first))
                                Spacer(Modifier.width(6.dp))
                                Text(meta.second, color = if (s.status == "needs_input" || s.status == "error") meta.first else FridayMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                                Spacer(Modifier.width(8.dp))
                            }
                            Text(relativeTime(s.updatedAt), color = FridayMuted, fontSize = 12.sp)
                        }
                        Text(s.title, color = FridayText, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                        Text(s.activity, color = FridayMuted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Icon(Icons.Default.ChevronRight, null, tint = FridayMuted, modifier = Modifier.size(18.dp))
                }
            }
        }

        if (prs.isNotEmpty()) {
            Text("Pull requests", color = FridayText, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))
            prs.forEach { s ->
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(RoundedCornerShape(12.dp)).background(FridaySurface)
                        .clickable { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(s.prUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(s.title, color = FridayText, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(s.repo, relativeTime(s.updatedAt)).joinToString(" · "), color = FridayMuted, fontSize = 12.sp)
                    }
                    Icon(Icons.Default.ChevronRight, null, tint = FridayMuted, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

private val EFFORTS = listOf("low" to "Low · quick, fewer checks", "medium" to "Medium · balanced", "high" to "High · extra verification")

/** Above the Build composer: how hard the agent works (the model picker is in the composer). */
@Composable
fun BuildEffortChip(effort: String, onChange: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.padding(bottom = 6.dp)) {
        Row(
            Modifier.clip(RoundedCornerShape(10.dp)).background(FridaySurface).clickable { open = true }.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(Icons.Default.Speed, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
            Text("${effort.replaceFirstChar { it.uppercase() }} effort", color = FridayText, fontSize = 12.5.sp)
            Icon(Icons.Default.ExpandMore, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            EFFORTS.forEach { (id, label) ->
                DropdownMenuItem(
                    text = { Text(label, fontWeight = if (id == effort) FontWeight.SemiBold else FontWeight.Normal) },
                    onClick = { onChange(id); open = false },
                )
            }
        }
    }
}
