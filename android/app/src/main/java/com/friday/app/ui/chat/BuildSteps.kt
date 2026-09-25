package com.friday.app.ui.chat

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.BuildInfo
import com.friday.app.data.BuildStep
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.delay

private fun verbFor(step: BuildStep): String = when (step.kind) {
    "run" -> if (step.state == "running") "Running command" else "Ran command"
    "start" -> if (step.state == "running") "Starting server" else "Started server"
    else -> ""
}

/** Build Mode's live task list, matching the web app: one row per step with a state icon, tap to
 *  expand its output, a "Working for 1m 21s" footer while it runs, and an "Open preview" card once
 *  the app is up. */
@Composable
fun BuildStepsCard(build: BuildInfo, streaming: Boolean, onOpenPreview: () -> Unit) {
    var elapsed by remember { mutableStateOf(0) }
    LaunchedEffect(streaming) {
        if (streaming) while (true) {
            delay(1000)
            elapsed += 1
        }
    }
    val done = build.steps.count { it.state == "ok" }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(FridaySurface)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .animateContentSize(),
    ) {
        build.steps.forEach { StepRow(it) }
        Spacer(Modifier.height(4.dp))
        if (streaming) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CircularProgressIndicator(strokeWidth = 1.5.dp, color = FridayMuted, modifier = Modifier.size(12.dp))
                val time = if (elapsed >= 60) "${elapsed / 60}m ${elapsed % 60}s" else "${elapsed}s"
                Text("Working for $time", color = FridayMuted, fontSize = 12.sp)
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Default.Check, null, tint = FridayMuted, modifier = Modifier.size(12.dp))
                Text("$done step${if (done == 1) "" else "s"} completed", color = FridayMuted, fontSize = 12.sp)
            }
        }
        if (build.previewUrl != null) {
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(com.friday.app.ui.theme.FridayChip)
                    .clickable(onClick = onOpenPreview)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.Visibility, null, tint = FridayText, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text("Live preview is ready", color = FridayText, fontSize = 14.sp, modifier = Modifier.weight(1f))
                Text("Open", color = FridayMuted, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun StepRow(step: BuildStep) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = step.detail != null) { open = !open }
                .padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                step.state == "running" -> CircularProgressIndicator(strokeWidth = 1.5.dp, color = FridayMuted, modifier = Modifier.size(14.dp))
                step.state == "error" -> Icon(Icons.Default.Error, null, tint = FridayError, modifier = Modifier.size(14.dp))
                else -> Icon(
                    when (step.kind) {
                        "write", "read" -> Icons.Default.Description
                        "start" -> Icons.Default.PlayArrow
                        else -> Icons.Default.Terminal
                    },
                    null, tint = FridayMuted, modifier = Modifier.size(14.dp),
                )
            }
            Spacer(Modifier.width(8.dp))
            val verb = verbFor(step)
            if (verb.isNotEmpty()) {
                Text(verb, color = FridayText, fontSize = 13.5.sp)
                Spacer(Modifier.width(6.dp))
            }
            Text(
                step.label,
                color = if (step.state == "error") FridayError else FridayMuted,
                fontSize = 13.5.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (open && step.detail != null) {
            Text(
                step.detail,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                color = FridayMuted,
                fontWeight = FontWeight.Normal,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 22.dp, bottom = 6.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(com.friday.app.ui.theme.FridayChip)
                    .horizontalScroll(rememberScrollState())
                    .padding(8.dp),
            )
        }
    }
}
