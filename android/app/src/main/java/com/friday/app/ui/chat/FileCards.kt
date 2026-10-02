package com.friday.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.GridOn
import androidx.compose.material.icons.filled.Slideshow
import androidx.compose.material.icons.filled.ArrowOutward
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.GeneratedFile
import com.friday.app.data.api.FilesApi
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch

private data class FormatStyle(val label: String, val color: Color, val icon: ImageVector)

private fun styleFor(format: String): FormatStyle = when (format) {
    "pptx" -> FormatStyle("PowerPoint", Color(0xFFD24726), Icons.Default.Slideshow)
    "xlsx" -> FormatStyle("Excel", Color(0xFF107C41), Icons.Default.GridOn)
    "csv" -> FormatStyle("CSV", Color(0xFF107C41), Icons.Default.GridOn)
    "docx" -> FormatStyle("Word", Color(0xFF185ABD), Icons.Default.Description)
    "pdf" -> FormatStyle("PDF", Color(0xFFD93025), Icons.Default.Description)
    "md" -> FormatStyle("Markdown", Color(0xFF6B7280), Icons.Default.Description)
    "xml" -> FormatStyle("XML", Color(0xFFB45309), Icons.Default.Code)
    "json" -> FormatStyle("JSON", Color(0xFFB45309), Icons.Default.Code)
    "html" -> FormatStyle("HTML", Color(0xFFE34F26), Icons.Default.Code)
    else -> FormatStyle("Text", Color(0xFF6B7280), Icons.AutoMirrored.Filled.InsertDriveFile)
}

private fun formatBytes(n: Long): String = when {
    n >= 1_048_576 -> "%.1f MB".format(n / 1_048_576.0)
    n >= 1024 -> "${n / 1024} KB"
    else -> "$n B"
}

/**
 * Download cards for files Friday generated (create_document) — the same cards as web's file-card.tsx, fading in one by one.
 * A "page" is a live Friday page: it opens in Pages instead of downloading.
 */
@Composable
fun FileCards(files: List<GeneratedFile>, onOpenPage: (String) -> Unit) {
    Column(Modifier.widthIn(max = 440.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        files.forEachIndexed { index, file ->
            var shown by remember(file.id) { mutableStateOf(false) }
            LaunchedEffect(file.id) { kotlinx.coroutines.delay(index * 50L); shown = true }
            AnimatedVisibility(shown, enter = fadeIn(tween(250)) + slideInVertically(tween(250)) { it / 6 }) {
                FileCard(file, onOpenPage)
            }
        }
    }
}

@Composable
private fun FileCard(file: GeneratedFile, onOpenPage: (String) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val isPage = file.format == "page"
    val st = styleFor(file.format)
    val color = if (isPage) when (file.pageKind) { "sheet" -> Color(0xFF107C41); "slides" -> Color(0xFFD24726); else -> Color(0xFF185ABD) } else st.color
    val icon = if (isPage) when (file.pageKind) { "sheet" -> Icons.Default.GridOn; "slides" -> Icons.Default.Slideshow; else -> Icons.Default.Description } else st.icon
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(FridaySurface)
            .clickable(enabled = !busy) {
                if (isPage) onOpenPage(file.id)
                else {
                    busy = true; error = null
                    scope.launch { error = FilesApi.downloadAndShare(ctx, file.id, file.filename); busy = false }
                }
            }
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(color.copy(alpha = 0.12f)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = color, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(file.title.ifBlank { file.filename }, color = FridayText, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                error ?: if (isPage) "Page · view it in Pages" else "${st.label} · ${formatBytes(file.size)}",
                color = if (error == null) FridayMuted else FridayError, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (busy) CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
        else Box(Modifier.size(34.dp).clip(CircleShape).border(1.dp, FridayMuted.copy(alpha = 0.25f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(if (isPage) Icons.Default.ArrowOutward else Icons.Default.Download, null, tint = FridayMuted, modifier = Modifier.size(16.dp))
        }
    }
}
