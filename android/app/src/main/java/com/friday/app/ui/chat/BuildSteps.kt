package com.friday.app.ui.chat

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.FolderZip
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.animation.core.animateFloat
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.alpha
import kotlinx.coroutines.launch
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

/** Spinning multicolor ring — the "working" symbol next to steps and "Working for 26s". */
@Composable
fun BuildOrb(size: androidx.compose.ui.unit.Dp = 14.dp) {
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "orb")
    val angle by t.animateFloat(
        0f, 360f,
        androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(900, easing = androidx.compose.animation.core.LinearEasing)),
        label = "angle",
    )
    androidx.compose.foundation.Canvas(Modifier.size(size).rotate(angle)) {
        val stroke = this.size.minDimension * 0.22f
        drawArc(
            brush = androidx.compose.ui.graphics.Brush.sweepGradient(
                listOf(
                    androidx.compose.ui.graphics.Color(0xFF4F8CFF), androidx.compose.ui.graphics.Color(0xFFA855F7),
                    androidx.compose.ui.graphics.Color(0xFFFF6B6B), androidx.compose.ui.graphics.Color(0xFFFFB547),
                    androidx.compose.ui.graphics.Color(0xFF34D399), androidx.compose.ui.graphics.Color(0xFF4F8CFF),
                ),
            ),
            startAngle = 0f, sweepAngle = 360f, useCenter = false,
            topLeft = androidx.compose.ui.geometry.Offset(stroke / 2, stroke / 2),
            size = androidx.compose.ui.geometry.Size(this.size.width - stroke, this.size.height - stroke),
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke),
        )
    }
}

/** "Build Mode" start-up card shown the instant a build begins (before any step exists). */
@Composable
fun BuildBanner() {
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "sheen")
    val x by t.animateFloat(
        -300f, 900f,
        androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(2400, easing = androidx.compose.animation.core.LinearEasing)),
        label = "x",
    )
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(
                androidx.compose.ui.graphics.Brush.horizontalGradient(
                    listOf(FridaySurface, androidx.compose.ui.graphics.Color(0x2E788CFF), FridaySurface),
                    startX = x, endX = x + 300f,
                ),
            )
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Build, null, tint = FridayText, modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(com.friday.app.ui.theme.FridayChip).padding(8.dp).size(20.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Build Mode", color = FridayText, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold)
                BuildOrb()
            }
            Text("Spinning up a sandbox to build, install, run and test your project…", color = FridayMuted, fontSize = 12.sp)
        }
    }
}

private fun formatDuration(totalSeconds: Long): String {
    val s = totalSeconds.coerceAtLeast(0)
    return if (s >= 60) "${s / 60}m ${s % 60}s" else "${s}s"
}

private fun formatBytes(bytes: Long): String =
    if (bytes >= 1024 * 1024) "%.2f MB".format(bytes / 1024.0 / 1024.0) else "%.2f KB".format(bytes / 1024.0)

/** The plan Build Mode drafts before coding. As a proposal (pending/revised, nothing built yet) it
 *  reads as a full plan to judge — what gets built, the architecture, numbered steps; once a build
 *  runs it becomes the live checklist, ticked off as items finish. */
@Composable
private fun PlanCard(plan: com.friday.app.data.BuildPlan) {
    val proposal = plan.status == "pending" || plan.status == "revised" || (plan.status == "approved" && plan.items.all { it.state == "todo" })
    var showArch by remember { mutableStateOf(plan.status == "pending") }
    val done = plan.items.count { it.state == "done" }
    val badge = when {
        plan.status == "pending" -> "Waiting for your approval"
        plan.status == "revised" -> "Replaced by a newer plan"
        plan.status == "approved" && proposal -> "Approved"
        else -> null
    }
    Column(
        Modifier.fillMaxWidth().padding(bottom = 10.dp).clip(RoundedCornerShape(16.dp)).background(FridaySurface)
            .alpha(if (plan.status == "revised") 0.6f else 1f).padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (proposal) "Build plan" else "Plan", color = FridayText, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (badge != null) {
                Text(
                    badge, fontSize = 11.sp, fontWeight = FontWeight.Medium,
                    color = if (plan.status == "pending") FridaySurface else FridayMuted,
                    modifier = Modifier.clip(RoundedCornerShape(50)).background(if (plan.status == "pending") FridayText else com.friday.app.ui.theme.FridayChip).padding(horizontal = 8.dp, vertical = 3.dp),
                )
            } else {
                Text("$done/${plan.items.size}", color = FridayMuted, fontSize = 12.sp)
            }
        }
        if (!proposal) {
            Spacer(Modifier.height(8.dp))
            Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(50)).background(com.friday.app.ui.theme.FridayChip)) {
                Box(Modifier.fillMaxWidth(if (plan.items.isEmpty()) 0f else done.toFloat() / plan.items.size).height(4.dp).clip(RoundedCornerShape(50)).background(FridayText))
            }
        }
        if (!plan.summary.isNullOrBlank()) {
            Text("What I'll build", color = FridayMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 10.dp))
            Text(plan.summary, color = FridayText, fontSize = 13.5.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 2.dp))
        }
        if (plan.architecture.isNotBlank()) {
            Row(Modifier.padding(top = 10.dp).clickable { showArch = !showArch }, verticalAlignment = Alignment.CenterVertically) {
                Text("Architecture", color = FridayMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                Icon(Icons.Default.ChevronRight, null, tint = FridayMuted, modifier = Modifier.size(14.dp).rotate(if (showArch) 90f else 0f))
            }
            if (showArch) Text(plan.architecture, color = FridayMuted, fontSize = 12.sp, lineHeight = 17.sp, modifier = Modifier.padding(top = 4.dp))
        }
        if (proposal) Text("Steps", color = FridayMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 10.dp))
        Spacer(Modifier.height(if (proposal) 4.dp else 8.dp))
        plan.items.forEachIndexed { index, item ->
            Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.padding(top = 2.dp).size(16.dp), contentAlignment = Alignment.Center) {
                    when {
                        proposal -> Text("${index + 1}.", color = FridayMuted, fontSize = 12.sp)
                        item.state == "done" -> Icon(
                            Icons.Default.Check, null, tint = FridaySurface,
                            modifier = Modifier.size(16.dp).clip(androidx.compose.foundation.shape.CircleShape).background(FridayText).padding(2.dp),
                        )
                        item.state == "doing" -> BuildOrb(14.dp)
                        else -> Box(Modifier.size(14.dp).clip(androidx.compose.foundation.shape.CircleShape).background(com.friday.app.ui.theme.FridayChip))
                    }
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    item.text, fontSize = 13.5.sp, lineHeight = 19.sp,
                    color = if (item.state == "done") FridayMuted else FridayText,
                    textDecoration = if (item.state == "done") androidx.compose.ui.text.style.TextDecoration.LineThrough else null,
                )
            }
        }
    }
}

/** Build Mode's task list, laid out like the reference product: while working, flat rows joined by
 *  a thin vertical line plus "Working for 15s"; once finished it folds into one
 *  "Worked for 7m 39s ›" line that expands to the same rows. */
@Composable
fun BuildStepsCard(build: BuildInfo, streaming: Boolean, onOpenPreview: () -> Unit) {
    var elapsed by remember { mutableStateOf(0L) }
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(streaming) {
        if (streaming) while (true) {
            delay(1000)
            elapsed += 1
        }
    }
    val rows: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().animateContentSize()) {
            // Consecutive file writes fold into one "Edited 9 files" row, like the reference product.
            val groups = mutableListOf<List<BuildStep>>()
            build.steps.forEach { st ->
                val last = groups.lastOrNull()
                if (st.kind == "write" && last != null && last.first().kind == "write") groups[groups.lastIndex] = last + st
                else groups += listOf(st)
            }
            groups.forEach { g -> if (g.first().kind == "write") WriteGroup(g) else StepRow(g.first()) }
        }
    }
    // A chat turn that only used tools (web search, reading a page, Gmail…) isn't Build Mode.
    val toolsOnly = build.steps.isNotEmpty() && build.steps.all { it.kind == "tool" || it.kind == "agent" } && build.plan == null
    // A plan-round message (no build steps yet) is just the plan — no "0 steps" row under it.
    if (build.plan != null && build.steps.isEmpty() && build.previewUrl == null) {
        PlanCard(build.plan)
        return
    }
    Column(Modifier.fillMaxWidth().animateContentSize()) {
        build.plan?.let { PlanCard(it) }
        if (streaming) {
            if (!toolsOnly) Row(
                Modifier.padding(bottom = 6.dp).clip(RoundedCornerShape(50)).background(com.friday.app.ui.theme.FridayChip).padding(horizontal = 10.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Default.Build, null, tint = FridayText, modifier = Modifier.size(12.dp))
                Text("Build Mode", color = FridayText, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }
            rows()
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BuildOrb(13.dp)
                Text("Working for ${formatDuration(elapsed)}", color = FridayMuted, fontSize = 13.sp)
            }
        } else {
            val seconds = (build.elapsedMs ?: 0L) / 1000
            Row(
                Modifier.clip(RoundedCornerShape(8.dp)).clickable { expanded = !expanded }.padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    when {
                        toolsOnly -> "Used ${build.steps.size} tool${if (build.steps.size == 1) "" else "s"}"
                        seconds > 0 -> "Worked for ${formatDuration(seconds)}"
                        else -> "${build.steps.size} steps"
                    },
                    color = FridayMuted, fontSize = 13.5.sp,
                )
                Icon(
                    Icons.Default.ChevronRight, null, tint = FridayMuted,
                    modifier = Modifier.size(16.dp).rotate(if (expanded) 90f else 0f),
                )
            }
            if (expanded) {
                Spacer(Modifier.height(4.dp))
                rows()
            }
            if (build.previewUrl != null) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Open live preview",
                    color = FridayText, fontSize = 12.5.sp,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(com.friday.app.ui.theme.FridayChip)
                        .clickable(onClick = onOpenPreview)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
    }
}

/** The downloadable project as a file card: "name.zip · Archive · 29.69 KB · Download". */
@Composable
fun ProjectZipCard(build: BuildInfo, conversationId: String) {
    val bytes = build.zipBytes ?: return
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(FridaySurface)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.FolderZip, null, tint = FridayMuted, modifier = Modifier.size(34.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(build.zipName ?: "project.zip", color = FridayText, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Archive · ${formatBytes(bytes)}", color = FridayMuted, fontSize = 12.sp)
        }
        Text(
            "Download", color = FridayText, fontSize = 13.sp,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(com.friday.app.ui.theme.FridayChip)
                .clickable {
                    scope.launch {
                        val zip = com.friday.app.data.api.BuildApi.downloadZip(conversationId, java.io.File(ctx.cacheDir, "canvas"))
                        if (zip == null) {
                            android.widget.Toast.makeText(ctx, "Couldn't download the project — check your connection.", android.widget.Toast.LENGTH_LONG).show()
                        } else {
                            val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", zip)
                            val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                                type = "application/zip"
                                putExtra(android.content.Intent.EXTRA_STREAM, uri)
                                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            runCatching { ctx.startActivity(android.content.Intent.createChooser(send, "Save project").addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        }
                    }
                }
                .padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun StepRow(step: BuildStep) {
    var open by remember { mutableStateOf(false) }
    if (step.kind == "agent" && step.agent != null) {
        SubAgentCard(step, step.agent)
        return
    }
    // Narration between actions — a plain thought line, not a command.
    if (step.kind == "note") {
        Row(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
            Icon(Icons.Default.Lightbulb, null, tint = FridayMuted, modifier = Modifier.padding(top = 2.dp).size(14.dp))
            Spacer(Modifier.width(8.dp))
            Text(step.label, color = FridayText, fontSize = 13.5.sp, lineHeight = 19.sp)
        }
        return
    }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = step.detail != null) { open = !open }
                .padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                step.state == "running" -> BuildOrb(14.dp)
                step.state == "error" -> Icon(Icons.Default.Error, null, tint = FridayError, modifier = Modifier.size(14.dp))
                else -> Icon(
                    when (step.kind) {
                        "write", "read" -> Icons.Default.Edit
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

@Composable
private fun WriteGroup(steps: List<BuildStep>) {
    var open by remember { mutableStateOf(false) }
    val running = steps.any { it.state == "running" }
    val failed = steps.any { it.state == "error" }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                running -> BuildOrb(14.dp)
                failed -> Icon(Icons.Default.Error, null, tint = FridayError, modifier = Modifier.size(14.dp))
                else -> Icon(Icons.Default.Edit, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
            }
            Spacer(Modifier.width(8.dp))
            Text("${if (running) "Editing" else "Edited"} ${steps.size} file${if (steps.size == 1) "" else "s"}", color = FridayText, fontSize = 13.5.sp)
            Spacer(Modifier.width(6.dp))
            Text(
                steps.joinToString(", ") { it.label.removePrefix("Wrote ") },
                color = FridayMuted, fontSize = 13.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
        }
        if (open) {
            Text(
                steps.joinToString("\n") { it.label.removePrefix("Wrote ") },
                fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = FridayMuted,
                modifier = Modifier.fillMaxWidth().padding(start = 22.dp, bottom = 6.dp).clip(RoundedCornerShape(8.dp)).background(com.friday.app.ui.theme.FridayChip).padding(8.dp),
            )
        }
    }
}

/** One parallel helper: what it was asked, its own live actions, and (when done) its short report. */
@Composable
private fun SubAgentCard(step: BuildStep, agent: com.friday.app.data.SubAgentInfo) {
    var open by remember { mutableStateOf(false) }
    val running = step.state == "running"
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(FridaySurface)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable(enabled = agent.report != null) { open = !open },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                running -> BuildOrb(14.dp)
                step.state == "error" -> Icon(Icons.Default.Error, null, tint = FridayError, modifier = Modifier.size(14.dp))
                else -> Icon(if (agent.kind == "research") Icons.Default.Visibility else Icons.Default.Description, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
            }
            Spacer(Modifier.width(8.dp))
            Text(step.label, color = FridayText, fontSize = 13.5.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (agent.report != null) {
                Icon(Icons.Default.ChevronRight, null, tint = FridayMuted, modifier = Modifier.size(16.dp).rotate(if (open) 90f else 0f))
            }
        }
        if (running) {
            agent.actions.takeLast(3).forEach { action ->
                Text(action.label, color = FridayMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 22.dp, top = 2.dp))
            }
        }
        if (open && agent.report != null) {
            Text(
                agent.report,
                color = FridayText,
                fontSize = 12.5.sp,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(com.friday.app.ui.theme.FridayChip)
                    .padding(10.dp),
            )
        }
    }
}
