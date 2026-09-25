package com.friday.app.ui.canvas

import android.content.Intent
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import com.friday.app.data.api.BuildApi
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayCanvas
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch
import java.io.File

/**
 * Canvas view for a Build Mode project — mirrors the web app's BuildCanvas: the running app (a
 * WebView on the sandbox's public URL) and its file tree. Sandboxes are short-lived, so unless the
 * URL just came from the live turn ([liveUrl]) the backend is asked to make sure it's alive first
 * (it restores the snapshot and restarts the server if it expired).
 */
@Composable
fun BuildPanel(
    conversationId: String,
    liveUrl: String?,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var url by remember(conversationId) { mutableStateOf(liveUrl) }
    var error by remember(conversationId) { mutableStateOf<String?>(null) }
    var loading by remember(conversationId) { mutableStateOf(liveUrl == null) }
    var tab by remember { mutableStateOf("preview") }
    var reload by remember { mutableIntStateOf(0) }
    var files by remember(conversationId) { mutableStateOf<Map<String, String>?>(null) }
    var selected by remember(conversationId) { mutableStateOf<String?>(null) }

    fun ensure() {
        loading = true
        error = null
        scope.launch {
            when (val r = BuildApi.ensurePreview(conversationId)) {
                is BuildApi.Preview.Ready -> { url = r.url; loading = false }
                is BuildApi.Preview.Failed -> { error = r.message; loading = false }
            }
        }
    }
    LaunchedEffect(conversationId, liveUrl) {
        if (liveUrl != null) { url = liveUrl; loading = false } else if (url == null) ensure()
    }
    LaunchedEffect(tab) {
        if (tab == "files" && files == null) {
            files = BuildApi.files(conversationId) ?: emptyMap()
            selected = files!!.keys.sorted().firstOrNull()
        }
    }

    var showTree by remember { mutableStateOf(true) }
    var mobile by remember { mutableStateOf(false) }
    val expandedDirs = remember { mutableStateOf(setOf<String>()) }

    Column(modifier.fillMaxSize().background(FridayBg)) {
        // Icon tabs: globe = running preview, stack = project files; close on the right.
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            listOf("preview" to Icons.Default.Language, "files" to Icons.Default.Layers).forEach { (id, icon) ->
                Icon(
                    icon, contentDescription = id,
                    tint = if (tab == id) FridayText else FridayMuted,
                    modifier = Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (tab == id) FridaySurface else androidx.compose.ui.graphics.Color.Transparent)
                        .clickable { tab = id }
                        .padding(8.dp).size(20.dp),
                )
                Spacer(Modifier.width(4.dp))
            }
            Spacer(Modifier.weight(1f))
            HeaderIcon(Icons.Default.Close, "Close", onClose)
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (tab == "preview") {
                HeaderIcon(Icons.Default.Refresh, "Reload") { if (url != null) reload++ else ensure() }
                Text(url?.removePrefix("https://").orEmpty(), color = FridayMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 6.dp))
                url?.let { u ->
                    HeaderIcon(Icons.Default.OpenInBrowser, "Open in browser") {
                        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    }
                }
                HeaderIcon(Icons.Default.PhoneAndroid, if (mobile) "Desktop view" else "Mobile view") { mobile = !mobile }
            } else {
                HeaderIcon(Icons.AutoMirrored.Filled.List, "Toggle file list") { showTree = !showTree }
                Text(selected.orEmpty(), color = FridayText, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 6.dp))
                HeaderIcon(Icons.Default.FileDownload, "Download project") {
                    scope.launch {
                        val zip = BuildApi.downloadZip(conversationId, File(ctx.cacheDir, "canvas"))
                        if (zip == null) {
                            Toast.makeText(ctx, "Couldn't download the project — check your connection.", Toast.LENGTH_LONG).show()
                        } else {
                            val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", zip)
                            val send = Intent(Intent.ACTION_SEND).apply {
                                type = "application/zip"
                                putExtra(Intent.EXTRA_STREAM, uri)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            runCatching { ctx.startActivity(Intent.createChooser(send, "Save project").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        }
                    }
                }
            }
        }
        androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth().height(1.dp).background(com.friday.app.ui.theme.FridayHairline))

        if (tab == "preview") {
            when {
                loading -> Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    CircularProgressIndicator(strokeWidth = 2.dp, color = FridayText)
                    Text("Starting your project… restoring files and dependencies can take a minute.", color = FridayMuted, fontSize = 14.sp, modifier = Modifier.padding(top = 12.dp))
                }
                error != null -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
                    Text(error!!, color = com.friday.app.ui.theme.FridayError, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                    TextButton(onClick = { ensure() }) { Text("Try again") }
                }
                url != null -> Box(Modifier.fillMaxSize().background(if (mobile) FridaySurface else FridayBg), contentAlignment = Alignment.TopCenter) {
                    AndroidView(
                        modifier = if (mobile) Modifier.width(390.dp).fillMaxHeight() else Modifier.fillMaxSize(),
                        factory = { c ->
                            WebView(c).apply {
                                settings.javaScriptEnabled = true
                                settings.domStorageEnabled = true
                                settings.allowFileAccess = false
                                webViewClient = WebViewClient()
                            }
                        },
                        update = { web ->
                            val tag = "$url#$reload"
                            if (web.tag != tag) {
                                web.tag = tag
                                web.loadUrl(url!!)
                            }
                        },
                    )
                }
            }
        } else {
            val list = files
            if (list == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp, color = FridayText) }
            } else {
                Row(Modifier.fillMaxSize()) {
                    if (showTree) {
                        Column(Modifier.width(150.dp).fillMaxHeight().verticalScroll(rememberScrollState()).padding(8.dp)) {
                            Text("Files", color = FridayMuted, fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp, bottom = 4.dp))
                            FileTree(list.keys.toList(), selected, expandedDirs) { selected = it }
                        }
                        Box(Modifier.width(1.dp).fillMaxHeight().background(com.friday.app.ui.theme.FridayHairline))
                    }
                    val lines = selected?.let { list[it] }.orEmpty().split("\n")
                    Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
                        lines.forEachIndexed { i, line ->
                            Row {
                                Text("${i + 1}", color = FridayMuted, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 17.sp, modifier = Modifier.width(34.dp).padding(end = 8.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End)
                                Text(line.ifEmpty { " " }, color = FridayText, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 17.sp, softWrap = false)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Collapsible folder tree built from flat paths ("src/components/App.jsx"). */
@Composable
private fun FileTree(
    paths: List<String>,
    selected: String?,
    expanded: androidx.compose.runtime.MutableState<Set<String>>,
    onSelect: (String) -> Unit,
) {
    // Row list flattened depth-first: folders first, then files, each level alphabetical.
    fun children(prefix: String): List<Pair<String, Boolean>> {
        val depth = if (prefix.isEmpty()) 0 else prefix.count { it == '/' } + 1
        val direct = paths.filter { it.startsWith(prefix) }.map { it.removePrefix(prefix).split("/") }
        val dirs = direct.filter { it.size > 1 }.map { it[0] }.distinct().sorted().map { "$prefix$it/" to true }
        val files = direct.filter { it.size == 1 }.map { it[0] }.sorted().map { "$prefix$it" to false }
        return dirs + files
    }
    fun render(prefix: String, out: MutableList<Triple<String, Boolean, Int>>, depth: Int) {
        for ((path, isDir) in children(prefix)) {
            out += Triple(path, isDir, depth)
            if (isDir && (path in expanded.value || depth == 0 && path.count { it == '/' } == 1 && expanded.value.isEmpty())) render(path, out, depth + 1)
        }
    }
    val rows = mutableListOf<Triple<String, Boolean, Int>>().also { render("", it, 0) }
    rows.forEach { (path, isDir, depth) ->
        val name = path.trimEnd('/').substringAfterLast('/')
        val open = isDir && (path in expanded.value || depth == 0 && expanded.value.isEmpty())
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(if (!isDir && path == selected) FridaySurface else androidx.compose.ui.graphics.Color.Transparent)
                .clickable {
                    if (isDir) expanded.value = if (open) expanded.value - path else expanded.value + path else onSelect(path)
                }
                .padding(start = (6 + depth * 12).dp, top = 6.dp, bottom = 6.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (isDir) (if (open) Icons.Default.FolderOpen else Icons.Default.Folder) else Icons.Default.Description,
                null, tint = FridayMuted, modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(name, color = if (!isDir && path == selected) FridayText else FridayMuted, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun HeaderIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Icon(
        icon, contentDescription = label, tint = FridayMuted,
        modifier = Modifier.clip(RoundedCornerShape(20.dp)).clickable(onClick = onClick).padding(6.dp).size(18.dp),
    )
}
