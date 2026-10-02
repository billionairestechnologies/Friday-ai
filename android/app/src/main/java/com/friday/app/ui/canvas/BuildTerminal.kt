package com.friday.app.ui.canvas

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.BuildStep

private val TermBg = Color(0xFF0C0C0D)
private val TermFg = Color(0xFFC9CCD1)
private val TermDim = Color(0xFF5C6370)
private val TermGreen = Color(0xFF34D399)
private val TermRed = Color(0xFFF87171)

private fun duration(ms: Int): String = if (ms < 1000) "${ms}ms" else "%.1fs".format(ms / 1000.0)

/**
 * Everything the build ran, as one continuous terminal session (web parity: SessionTerminal in build-preview.tsx): each
 * command with its output and how it ended, file writes as dim comment lines, the running command live at the bottom.
 */
@Composable
fun BuildTerminal(steps: List<BuildStep>, building: Boolean) {
    val entries = steps.filter { (it.cmd != null && (it.kind == "run" || it.kind == "start")) || (it.kind == "write" && it.state != "running" && it.path != null) }
    if (entries.isEmpty()) {
        Box(Modifier.fillMaxSize().background(TermBg).padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                if (building) "Waiting for the first command…" else "Commands Friday runs for this project show up here.",
                color = Color(0xFF6B7078), fontFamily = FontFamily.Monospace, fontSize = 12.sp,
            )
        }
        return
    }
    val listState = rememberLazyListState()
    // Follows new output as it streams in.
    val signature = entries.joinToString("|") { "${it.id}:${it.state}:${it.output?.length ?: 0}" }
    LaunchedEffect(signature) { listState.scrollToItem(entries.lastIndex) }
    LazyColumn(Modifier.fillMaxSize().background(TermBg), state = listState, contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(entries, key = { it.id }) { st ->
            if (st.kind == "write") {
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(color = TermDim)) { append("# ${if (st.lang == "diff") "edited" else "wrote"} ${st.path}") }
                        if ((st.added ?: 0) > 0) withStyle(SpanStyle(color = TermGreen.copy(alpha = 0.7f))) { append(" +${st.added}") }
                        if ((st.removed ?: 0) > 0) withStyle(SpanStyle(color = TermRed.copy(alpha = 0.7f))) { append(" −${st.removed}") }
                    },
                    fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                )
            } else {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        buildAnnotatedString {
                            withStyle(SpanStyle(color = if (st.state == "error") TermRed else TermGreen)) { append("$ ") }
                            withStyle(SpanStyle(color = Color(0xFFE8EAED))) { append(st.cmd.orEmpty()) }
                        },
                        fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                    )
                    val out = (st.output ?: if (st.state != "running") st.detail else null).orEmpty().trimEnd()
                    if (out.isNotEmpty()) Text(out, color = Color(0xFFAEB3BA), fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                    if (st.state == "running") {
                        Text("▍", color = TermFg, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                    } else {
                        val ended = if (st.kind == "start") (if (st.state == "ok") "✓ server running" else "✗ server failed to start") else "exit ${st.exitCode ?: if (st.state == "ok") 0 else 1}"
                        Text(ended + (st.ms?.let { " · " + duration(it) } ?: ""), color = if (st.state == "error") TermRed else TermDim, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                    }
                }
            }
        }
    }
}
