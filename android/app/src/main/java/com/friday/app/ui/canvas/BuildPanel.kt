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

    Column(modifier.fillMaxSize().background(FridayBg)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Live project", color = FridayCanvas, fontWeight = FontWeight.Medium, fontSize = 15.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                HeaderIcon(Icons.Default.Refresh, "Reload") { if (url != null) reload++ else ensure() }
                url?.let { u ->
                    HeaderIcon(Icons.Default.OpenInBrowser, "Open in browser") {
                        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    }
                }
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
                HeaderIcon(Icons.Default.Close, "Close", onClose)
            }
        }
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(10.dp)).background(FridaySurface),
        ) {
            listOf("preview" to "Preview", "files" to "Files").forEach { (id, label) ->
                val on = tab == id
                Box(
                    Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (on) FridayBg else androidx.compose.ui.graphics.Color.Transparent)
                        .clickable { tab = id }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) { Text(label, color = if (on) FridayText else FridayMuted, fontSize = 13.sp, fontWeight = FontWeight.Medium) }
            }
        }

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
                url != null -> AndroidView(
                    modifier = Modifier.fillMaxSize(),
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
        } else {
            val list = files
            if (list == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp, color = FridayText) }
            } else {
                Column(Modifier.fillMaxSize()) {
                    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        list.keys.sorted().forEach { p ->
                            Text(
                                p, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                color = if (p == selected) FridayText else FridayMuted,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(if (p == selected) FridaySurface else androidx.compose.ui.graphics.Color.Transparent)
                                    .clickable { selected = p }
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                    }
                    Text(
                        selected?.let { list[it] }.orEmpty(),
                        fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 17.sp, color = FridayText,
                        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(14.dp),
                    )
                }
            }
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
