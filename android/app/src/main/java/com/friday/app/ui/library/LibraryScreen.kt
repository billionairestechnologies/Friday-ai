package com.friday.app.ui.library

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.friday.app.data.api.LibraryApi
import com.friday.app.data.api.LibraryItem
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch

private val EXTENSIONS = mapOf(
    "html" to "html", "python" to "py", "py" to "py", "javascript" to "js", "js" to "js",
    "typescript" to "ts", "ts" to "ts", "jsx" to "jsx", "tsx" to "tsx", "css" to "css",
    "bash" to "sh", "sh" to "sh", "shell" to "sh", "sql" to "sql", "json" to "json",
    "yaml" to "yml", "yml" to "yml", "xml" to "xml", "csv" to "csv", "java" to "java",
    "kotlin" to "kt", "swift" to "swift", "go" to "go", "rust" to "rs", "r" to "r",
)

private fun fileNameFor(item: LibraryItem): String {
    val base = item.title.replace(Regex("[^\\w.-]+"), "_").trim('_').take(50).ifBlank { "friday" }
    val ext = EXTENSIONS[item.lang?.lowercase()] ?: if (item.kind == "react") "jsx" else "txt"
    return "$base.$ext"
}

/** Saves the text into the device's Downloads folder (API 29+), else hands it to the share sheet. */
private fun download(ctx: Context, item: LibraryItem) {
    if (item.kind == "image") {
        ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"; putExtra(Intent.EXTRA_TEXT, item.content)
        }, "Share image link"))
        return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileNameFor(item))
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/Friday")
        }
        val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri != null) {
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(item.content.toByteArray()) }
            Toast.makeText(ctx, "Saved to Downloads/Friday", Toast.LENGTH_SHORT).show()
            return
        }
        Toast.makeText(ctx, "Couldn't save the file", Toast.LENGTH_LONG).show()
        return
    }
    ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"; putExtra(Intent.EXTRA_TEXT, item.content)
    }, "Share code"))
}

@Composable
fun LibraryScreen(onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var items by remember { mutableStateOf<List<LibraryItem>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var category by remember { mutableStateOf("All") }
    var open by remember { mutableStateOf<LibraryItem?>(null) }
    var confirmDelete by remember { mutableStateOf<LibraryItem?>(null) }

    fun load() {
        scope.launch {
            val result = LibraryApi.list()
            failed = result == null
            if (result != null) items = result
        }
    }
    LaunchedEffect(Unit) { load() }

    val all = items.orEmpty()
    val categories = all.groupingBy { it.category }.eachCount()
    val visible = all.filter { category == "All" || it.category == category }

    Column(Modifier.fillMaxSize().background(FridayBg).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(20.dp, 16.dp, 12.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Library", fontSize = 22.sp, fontWeight = FontWeight.Medium, color = FridayText)
                Text("Saved automatically from your chats", fontSize = 13.sp, color = FridayMuted)
            }
            Icon(Icons.Default.Close, "Close", tint = FridayText, modifier = Modifier.clickable(onClick = onClose).padding(8.dp))
        }

        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            (listOf("All" to all.size) + categories.toList()).forEach { (name, count) ->
                val active = category == name
                Text(
                    "$name  $count",
                    color = if (active) FridayBg else FridayText,
                    fontSize = 13.sp,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(if (active) FridayText else FridaySurface)
                        .clickable { category = name }
                        .padding(horizontal = 14.dp, vertical = 7.dp),
                )
            }
        }

        when {
            failed && items == null -> Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Text("Couldn't load your library.", color = FridayMuted)
                TextButton(onClick = { failed = false; load() }) { Text("Try again") }
            }
            items == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = FridayText, strokeWidth = 2.dp) }
            visible.isEmpty() -> Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                Text(
                    if (all.isEmpty()) "Nothing here yet. Code, pages and images from your chats are saved here automatically." else "Nothing in this category.",
                    color = FridayMuted, fontSize = 14.sp,
                )
            }
            else -> LazyColumn(contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(visible, key = { it.id }) { item ->
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(FridaySurface)
                            .clickable {
                                if (item.category == "Documents" || item.category == "Uploads") {
                                    // Generated documents and uploads download through the web Library.
                                    androidx.browser.customtabs.CustomTabsIntent.Builder().build()
                                        .launchUrl(ctx, android.net.Uri.parse("https://friday.billionairestechnologies.com/library"))
                                } else {
                                    open = item
                                    if (item.kind != "image") scope.launch { LibraryApi.get(item.id)?.let { open = it } }
                                }
                            }
                            .padding(12.dp),
                    ) {
                        Text("${item.category} · ${item.createdAt.take(10)}", fontSize = 12.sp, color = FridayMuted)
                        Text(item.title, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = FridayText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                        Spacer(Modifier.height(6.dp))
                        if (item.kind == "image") {
                            AsyncImage(item.content, item.title, Modifier.fillMaxWidth().height(140.dp).clip(RoundedCornerShape(10.dp)), contentScale = ContentScale.Crop)
                        } else {
                            Text(item.content, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = FridayMuted, maxLines = 4, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }

    open?.let { item ->
        androidx.compose.ui.window.Dialog(onDismissRequest = { open = null }) {
            Column(Modifier.clip(RoundedCornerShape(18.dp)).background(FridayBg).padding(16.dp)) {
                Text(item.title, fontSize = 17.sp, fontWeight = FontWeight.Medium, color = FridayText, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(item.category, fontSize = 12.sp, color = FridayMuted)
                Spacer(Modifier.height(10.dp))
                Box(Modifier.heightIn(max = 380.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(FridaySurface)) {
                    if (item.kind == "image") {
                        AsyncImage(item.content, item.title, Modifier.fillMaxWidth(), contentScale = ContentScale.Fit)
                    } else {
                        Text(item.content, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = FridayText, modifier = Modifier.verticalScroll(rememberScrollState()).padding(10.dp))
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                    if (item.kind != "image") TextButton(onClick = {
                        clipboard.setText(AnnotatedString(item.content))
                        Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
                    }) { Text("Copy") }
                    TextButton(onClick = { download(ctx, item) }) { Text("Download") }
                    TextButton(onClick = { confirmDelete = item }) { Text("Delete") }
                }
            }
        }
    }

    confirmDelete?.let { item ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete from library?") },
            text = { Text("\"${item.title}\" will be removed on all your devices.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = null
                    scope.launch {
                        if (LibraryApi.delete(item.id)) {
                            items = items?.filterNot { it.id == item.id }
                            open = null
                        } else {
                            Toast.makeText(ctx, "Couldn't delete that item — check your connection.", Toast.LENGTH_LONG).show()
                        }
                    }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}
