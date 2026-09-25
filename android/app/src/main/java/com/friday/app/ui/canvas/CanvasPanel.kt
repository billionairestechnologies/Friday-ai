package com.friday.app.ui.canvas

import android.content.Intent
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import com.friday.app.data.api.SandboxApi
import com.friday.app.data.api.SandboxResult
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayCanvas
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch
import java.io.File

private enum class CanvasTab { Preview, Code }

private sealed class RunState {
    data object Idle : RunState()
    data object Running : RunState()
    data class Done(val output: String, val autoFixed: Boolean = false) : RunState()
    data class Failed(val message: String) : RunState()
}

/**
 * Auto-opens when [artifact] is detected in the streamed reply (see ArtifactDetect.kt — there is no
 * dedicated backend artifact event, so this is populated from a client-side fence scan).
 */
@Composable
fun CanvasPanel(
    artifact: DetectedArtifact?,
    generating: Boolean,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by remember(artifact?.kind) { mutableStateOf(CanvasTab.Preview) }
    var runState by remember(artifact?.code) { mutableStateOf<RunState>(RunState.Idle) }

    fun runNow() {
        val a = artifact ?: return
        runState = RunState.Running
        scope.launch {
            // The backend's own auto-fix loop already ran to completion before this call
            // returned — there is nothing left to retry client-side.
            when (val result = SandboxApi.run(a.lang, a.code)) {
                is SandboxResult.Success -> runState = RunState.Done(result.output, result.autoFixed)
                is SandboxResult.Error -> runState = RunState.Failed(result.message)
            }
        }
    }

    LaunchedEffect(artifact?.complete, artifact?.kind) {
        if (artifact?.complete == true && artifact.kind == ArtifactKind.Runnable && runState is RunState.Idle) {
            runNow()
        }
    }

    Column(modifier.fillMaxSize().background(FridayBg)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Canvas", color = FridayCanvas, fontWeight = FontWeight.Medium, fontSize = 15.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (artifact != null && artifact.previewable) {
                    HeaderIcon(Icons.Default.OpenInBrowser, "Open in browser") {
                        openInBrowser(ctx, artifact)
                    }
                }
                if (artifact != null) {
                    HeaderIcon(Icons.Default.FileDownload, "Download") {
                        shareArtifact(ctx, artifact)
                    }
                }
                HeaderIcon(Icons.Default.Close, "Close canvas", onClose)
            }
        }

        if (artifact != null && artifact.previewable) {
            SegmentedTabs(tab, onSelect = { tab = it })
        }

        when {
            artifact == null && generating -> ShimmerBody()
            artifact == null -> Text(
                "Turn on Canvas and ask Friday to build something…",
                color = FridayMuted,
                fontSize = 14.sp,
                modifier = Modifier.padding(20.dp),
            )
            artifact.kind == ArtifactKind.Runnable -> RunnableBody(artifact, runState, onRunAgain = { runNow() })
            artifact.kind == ArtifactKind.Code -> CodeBody(artifact.code)
            tab == CanvasTab.Preview -> ArtifactWebView(
                html = renderableContent(artifact),
                modifier = Modifier.fillMaxSize().padding(top = 4.dp),
            )
            else -> CodeBody(artifact.code)
        }
    }
}

@Composable
private fun HeaderIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Icon(
        icon,
        contentDescription = label,
        tint = FridayMuted,
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .clickable(onClick = onClick)
            .padding(6.dp)
            .size(18.dp),
    )
}

@Composable
private fun SegmentedTabs(selected: CanvasTab, onSelect: (CanvasTab) -> Unit) {
    Row(
        Modifier
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(FridaySurface),
    ) {
        listOf(CanvasTab.Preview to "Preview", CanvasTab.Code to "Code").forEach { (t, label) ->
            val on = t == selected
            Box(
                Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (on) FridayBg else androidx.compose.ui.graphics.Color.Transparent)
                    .clickable { onSelect(t) }
                    .padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Text(label, color = if (on) FridayText else FridayMuted, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun ArtifactWebView(html: String, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { c ->
            WebView(c).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                webViewClient = WebViewClient()
            }
        },
        update = { webView -> webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null) },
    )
}

@Composable
private fun CodeBody(code: String) {
    Text(
        code,
        fontFamily = FontFamily.Monospace,
        fontSize = 12.5.sp,
        lineHeight = 18.sp,
        color = FridayText,
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
    )
}

@Composable
private fun RunnableBody(artifact: DetectedArtifact, state: RunState, onRunAgain: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        CodeBody(artifact.code)
        Column(
            Modifier
                .fillMaxWidth()
                .background(FridaySurface)
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            when (state) {
                RunState.Idle -> {}
                RunState.Running -> RunStatusRow(spinning = true, label = "Running…", color = FridayMuted)
                is RunState.Done -> {
                    RunStatusRow(
                        spinning = false,
                        label = if (state.autoFixed) "Fixed automatically and ran successfully" else "Ran successfully",
                        color = if (state.autoFixed) FridayCanvas else FridaySearch,
                    )
                    if (state.output.isNotBlank()) {
                        Text(state.output, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = FridayText)
                    }
                }
                is RunState.Failed -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Icons.Default.Error, null, tint = FridayError, modifier = Modifier.size(16.dp))
                        Text("Error (couldn't auto-fix)", color = FridayError, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                    Text(state.message, color = FridayError, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                }
            }
            Row(
                Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .clickable(onClick = onRunAgain)
                    .padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Default.PlayArrow, null, tint = FridayText, modifier = Modifier.size(16.dp))
                Text("Run again", color = FridayText, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun RunStatusRow(spinning: Boolean, label: String, color: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (spinning) {
            CircularProgressIndicator(strokeWidth = 2.dp, color = color, modifier = Modifier.size(14.dp))
        }
        Text(label, color = color, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun ShimmerBody() {
    val t = rememberInfiniteTransition(label = "shimmer")
    val x by t.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Restart),
        label = "x",
    )
    val brush = Brush.horizontalGradient(
        listOf(FridaySurface, FridaySurface.copy(alpha = 0.4f), FridaySurface),
        startX = x * 600f - 200f,
        endX = x * 600f + 200f,
    )
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Analyzing the request", color = FridayCanvas, fontSize = 13.sp)
        Text("Making it pixel-perfect…", color = FridayMuted, fontSize = 13.sp)
        repeat(4) {
            Box(
                Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(12.dp)).background(brush),
            )
        }
    }
}

private fun extensionFor(artifact: DetectedArtifact): String = when (artifact.kind) {
    ArtifactKind.Html -> "html"
    ArtifactKind.React -> "html"
    ArtifactKind.Code -> when (artifact.lang) {
        "css" -> "css"; "json" -> "json"; "sql" -> "sql"; "go" -> "go"; "php" -> "php"; "rust", "rs" -> "rs"
        "kotlin", "kt" -> "kt"; "swift" -> "swift"; "c" -> "c"; "cpp", "c++" -> "cpp"; "yaml", "yml" -> "yml"
        else -> "txt"
    }
    ArtifactKind.Runnable -> when (artifact.lang) {
        "python", "py" -> "py"
        "javascript", "js" -> "js"
        "typescript", "ts" -> "ts"
        "java" -> "java"
        "r" -> "r"
        "bash", "sh", "shell" -> "sh"
        else -> "txt"
    }
}

private fun renderableContent(artifact: DetectedArtifact): String = when (artifact.kind) {
    ArtifactKind.Html -> htmlWithCss(artifact.code, artifact.css)
    ArtifactKind.React -> reactPreviewHtml(artifact.code, artifact.css)
    ArtifactKind.Runnable, ArtifactKind.Code -> artifact.code
}

private fun writeCanvasFile(ctx: android.content.Context, artifact: DetectedArtifact): android.net.Uri? = runCatching {
    val dir = File(ctx.cacheDir, "canvas").apply { mkdirs() }
    val file = File(dir, "canvas-artifact.${extensionFor(artifact)}")
    file.writeText(renderableContent(artifact))
    FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
}.getOrNull()

private fun openInBrowser(ctx: android.content.Context, artifact: DetectedArtifact) {
    val uri = writeCanvasFile(ctx, artifact) ?: return
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "text/html")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    runCatching { ctx.startActivity(intent) }
}

private fun shareArtifact(ctx: android.content.Context, artifact: DetectedArtifact) {
    val uri = writeCanvasFile(ctx, artifact) ?: return
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = if (artifact.kind == ArtifactKind.Runnable) "text/plain" else "text/html"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    runCatching { ctx.startActivity(Intent.createChooser(intent, "Save canvas").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}
