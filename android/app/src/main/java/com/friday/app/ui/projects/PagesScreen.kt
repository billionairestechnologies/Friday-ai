package com.friday.app.ui.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.api.PageDetail
import com.friday.app.data.api.PageSummary
import com.friday.app.data.api.PagesApi
import com.friday.app.ui.chat.MarkdownBody
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayChip
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch

/**
 * Pages: live documents, spreadsheets and slide decks made in chat or on the web. The app opens them read-only;
 * editing, sharing and export are on the web.
 */
@Composable
fun PagesScreen(onClose: () -> Unit, initialPageId: String? = null, onConsumed: () -> Unit = {}) {
    var pages by remember { mutableStateOf<List<PageSummary>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf<PageSummary?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        val list = PagesApi.list()
        if (list != null) { pages = list; failed = false } else if (pages == null) failed = true
    }
    LaunchedEffect(Unit) {
        load()
        // A "page" file card in chat: open that page straight away.
        if (initialPageId != null) { open = pages?.firstOrNull { it.id == initialPageId }; onConsumed() }
    }

    val current = open
    if (current != null) {
        PageViewer(current, onBack = { open = null })
        return
    }

    Column(Modifier.fillMaxSize().background(FridayBg).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 16.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Pages", color = FridayText, fontSize = 22.sp, fontWeight = FontWeight.Medium)
                Text("Documents, sheets and decks you and Friday work on", color = FridayMuted, fontSize = 13.sp)
            }
            Box(Modifier.size(40.dp).clickable(onClick = onClose), contentAlignment = Alignment.Center) { Icon(Icons.Default.Close, "Close", tint = FridayText) }
        }
        val list = pages
        when {
            list != null && list.isEmpty() -> Text("No pages yet. Ask Friday to \"write this up as a page\" and it shows up here.", color = FridayMuted, fontSize = 14.sp, modifier = Modifier.padding(20.dp))
            list != null -> Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                list.forEach { p ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(FridaySurface).clickable { open = p }.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(when (p.kind) { "sheet" -> "▦"; "slides" -> "▭"; else -> "☰" }, color = FridayMuted, fontSize = 16.sp)
                        Text(p.title, color = FridayText, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            failed -> TextButton(onClick = { scope.launch { load() } }, modifier = Modifier.padding(12.dp)) { Text("Couldn't load pages — tap to retry", color = FridayMuted) }
            else -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp) }
        }
    }
}

@Composable
private fun PageViewer(page: PageSummary, onBack: () -> Unit) {
    var detail by remember { mutableStateOf<PageDetail?>(null) }
    var failed by remember { mutableStateOf(false) }
    var sheetIndex by remember { mutableStateOf(0) }
    LaunchedEffect(page.id) {
        val d = PagesApi.get(page.id)
        if (d != null) detail = d else failed = true
    }

    Column(Modifier.fillMaxSize().background(FridayBg).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(page.title, color = FridayText, fontSize = 22.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Box(Modifier.size(40.dp).clickable(onClick = onBack), contentAlignment = Alignment.Center) { Icon(Icons.Default.Close, "Back", tint = FridayText) }
        }
        val d = detail
        when {
            d == null && failed -> Text("Couldn't open this page. Check your connection and try again.", color = FridayMuted, fontSize = 14.sp)
            d == null -> CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
            d.kind == "sheet" -> {
                if (d.sheets.size > 1) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        d.sheets.forEachIndexed { i, s ->
                            Text(
                                s.name,
                                color = if (sheetIndex == i) FridayBg else FridayText,
                                fontSize = 13.sp,
                                modifier = Modifier.clip(RoundedCornerShape(50)).background(if (sheetIndex == i) FridayText else FridaySurface).clickable { sheetIndex = i }.padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
                d.sheets.getOrNull(sheetIndex)?.let { s ->
                    Column(Modifier.horizontalScroll(rememberScrollState())) {
                        SheetRow(s.columns, header = true)
                        s.rows.forEach { SheetRow(it, header = false) }
                    }
                }
            }
            d.kind == "slides" -> d.slides.forEachIndexed { i, s ->
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(FridaySurface).padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Slide ${i + 1}", color = FridayMuted, fontSize = 11.sp)
                    if (s.title.isNotBlank()) Text(s.title, color = FridayText, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    if (s.subtitle.isNotBlank()) Text(s.subtitle, color = FridayMuted, fontSize = 14.sp)
                    s.lines.forEach { Text(it, color = FridayText, fontSize = 14.sp) }
                }
            }
            else -> MarkdownBody(d.markdown)
        }
        Text("Read-only here — edit, share or export it on the web.", color = FridayMuted, fontSize = 12.sp)
    }
}

@Composable
private fun SheetRow(cells: List<String>, header: Boolean) {
    Row {
        cells.forEach { c ->
            Text(
                c,
                color = FridayText,
                fontSize = 13.sp,
                fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.width(120.dp).background(if (header) FridayChip else FridayBg).border(0.5.dp, FridayMuted.copy(alpha = 0.25f)).padding(8.dp),
            )
        }
    }
}
