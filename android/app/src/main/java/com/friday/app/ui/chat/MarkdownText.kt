package com.friday.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.ui.theme.FridayChip
import com.friday.app.ui.theme.FridayHairline
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText

/**
 * Chat markdown renderer (non-code, non-image parts of a reply): headings, nested bullet/numbered
 * lists, blockquotes, rules, GFM tables (aligned columns, inline formatting in cells) and inline
 * **bold** / *italic* / ~~strike~~ / `code` / [links](url).
 */
@Composable
internal fun MarkdownText(text: String) {
    val blocks = remember(text) { parseMarkdown(text) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Heading -> Text(
                    inline(block.text),
                    color = FridayText,
                    fontWeight = FontWeight.Bold,
                    fontSize = when (block.level) { 1 -> 22.sp; 2 -> 19.sp; 3 -> 17.sp; else -> 15.5.sp },
                    lineHeight = when (block.level) { 1 -> 30.sp; 2 -> 26.sp; 3 -> 24.sp; else -> 22.sp },
                    modifier = Modifier.padding(top = if (block.level <= 2) 6.dp else 2.dp),
                )
                is MdBlock.Para -> Text(inline(block.text), color = FridayText, fontSize = 15.5.sp, lineHeight = 24.sp)
                is MdBlock.Item -> Row(
                    Modifier.padding(start = (block.depth * 18).dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        block.ordinal?.let { "$it." } ?: when (block.depth) { 0 -> "•"; 1 -> "◦"; else -> "▪" },
                        color = FridayText, fontSize = 15.5.sp, lineHeight = 24.sp,
                    )
                    Text(inline(block.text), color = FridayText, fontSize = 15.5.sp, lineHeight = 24.sp, modifier = Modifier.weight(1f))
                }
                is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(FridayHairline.copy(alpha = 0.3f)))
                    Text(
                        inline(block.text), color = FridayMuted, fontSize = 15.sp, lineHeight = 23.sp,
                        modifier = Modifier.padding(start = 12.dp),
                    )
                }
                MdBlock.Rule -> HorizontalDivider(color = FridayHairline, modifier = Modifier.padding(vertical = 4.dp))
                is MdBlock.Table -> MarkdownTable(block)
            }
        }
    }
}

@Composable
private fun MarkdownTable(table: MdBlock.Table) {
    val cols = table.headers.size
    // One width per column (from the longest cell), so every row lines up — rows sized independently
    // is what made tables look ragged.
    val widths: List<Dp> = remember(table) {
        (0 until cols).map { c ->
            val longest = (listOf(table.headers[c]) + table.rows.map { it.getOrElse(c) { "" } })
                .maxOf { plain(it).length }
            (longest * 7.5f + 28f).coerceIn(84f, 260f).dp
        }
    }
    fun align(c: Int) = when (table.aligns.getOrNull(c)) { 'c' -> TextAlign.Center; 'r' -> TextAlign.End; else -> TextAlign.Start }
    val line = FridayHairline

    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, line, RoundedCornerShape(12.dp))) {
        Column(Modifier.horizontalScroll(rememberScrollState())) {
            Row(Modifier.height(IntrinsicSize.Min).background(FridaySurface)) {
                table.headers.forEachIndexed { c, cell ->
                    Box(Modifier.width(widths[c]).fillMaxHeight().gridLines(line, right = c != cols - 1, bottom = true).padding(horizontal = 12.dp, vertical = 9.dp)) {
                        Text(inline(cell), color = FridayText, fontSize = 13.sp, fontWeight = FontWeight.Bold, textAlign = align(c), modifier = Modifier.fillMaxWidth())
                    }
                }
            }
            table.rows.forEachIndexed { r, row ->
                Row(Modifier.height(IntrinsicSize.Min).background(if (r % 2 == 1) FridaySurface.copy(alpha = 0.5f) else Color.Transparent)) {
                    for (c in 0 until cols) {
                        Box(Modifier.width(widths[c]).fillMaxHeight().gridLines(line, right = c != cols - 1, bottom = r != table.rows.lastIndex).padding(horizontal = 12.dp, vertical = 9.dp)) {
                            Text(inline(row.getOrElse(c) { "" }), color = FridayText, fontSize = 13.sp, lineHeight = 19.sp, textAlign = align(c), modifier = Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
    }
}

private fun Modifier.gridLines(color: Color, right: Boolean, bottom: Boolean): Modifier = drawBehind {
    if (right) drawLine(color, Offset(size.width, 0f), Offset(size.width, size.height), 1f)
    if (bottom) drawLine(color, Offset(0f, size.height), Offset(size.width, size.height), 1f)
}

// ---- parsing ----

internal sealed class MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock()
    data class Para(val text: String) : MdBlock()
    data class Item(val text: String, val depth: Int, val ordinal: String?) : MdBlock()
    data class Quote(val text: String) : MdBlock()
    data object Rule : MdBlock()
    data class Table(val headers: List<String>, val rows: List<List<String>>, val aligns: List<Char>) : MdBlock()
}

private val headingRe = Regex("^(#{1,6})\\s+(.*?)\\s*#*$")
private val bulletRe = Regex("^(\\s*)[-*+•]\\s+(.*)$")
private val numberedRe = Regex("^(\\s*)(\\d+)[.)]\\s+(.*)$")
private val ruleRe = Regex("^\\s*([-*_])(\\s*\\1){2,}\\s*$")
private val quoteRe = Regex("^\\s*>\\s?(.*)$")
private val separatorCellRe = Regex("^:?-{2,}:?$")

private fun splitCells(line: String): List<String> =
    line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

private fun isSeparator(line: String): Boolean {
    if (!line.contains('-')) return false
    val cells = splitCells(line)
    return cells.isNotEmpty() && cells.all { separatorCellRe.matches(it) }
}

internal fun parseMarkdown(text: String): List<MdBlock> {
    val out = mutableListOf<MdBlock>()
    val para = StringBuilder()
    fun flush() {
        if (para.isNotBlank()) out += MdBlock.Para(para.toString().trim())
        para.clear()
    }
    val lines = text.replace("\r", "").split("\n")
    var i = 0
    while (i < lines.size) {
        val raw = lines[i]
        val line = raw.trim()
        // Table: a row with a pipe, followed by a |---|---| separator (outer pipes optional).
        if (line.contains('|') && i + 1 < lines.size && isSeparator(lines[i + 1].trim())) {
            flush()
            val headers = splitCells(line)
            val aligns = splitCells(lines[i + 1].trim()).map { c ->
                when {
                    c.startsWith(":") && c.endsWith(":") -> 'c'
                    c.endsWith(":") -> 'r'
                    else -> 'l'
                }
            }
            val rows = mutableListOf<List<String>>()
            i += 2
            while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
                rows += splitCells(lines[i].trim())
                i++
            }
            out += MdBlock.Table(headers, rows, aligns)
            continue
        }
        val heading = headingRe.find(line)
        val bullet = bulletRe.find(raw)
        val numbered = numberedRe.find(raw)
        val quote = quoteRe.find(line)
        when {
            line.isEmpty() -> flush()
            ruleRe.matches(line) -> { flush(); out += MdBlock.Rule }
            heading != null -> { flush(); out += MdBlock.Heading(heading.groupValues[1].length, heading.groupValues[2]) }
            quote != null -> {
                flush()
                val q = StringBuilder(quote.groupValues[1])
                while (i + 1 < lines.size && quoteRe.matches(lines[i + 1].trim())) {
                    i++
                    q.append(' ').append(quoteRe.find(lines[i].trim())!!.groupValues[1])
                }
                out += MdBlock.Quote(q.toString().trim())
            }
            bullet != null -> { flush(); out += MdBlock.Item(bullet.groupValues[2], bullet.groupValues[1].length / 2, null) }
            numbered != null -> { flush(); out += MdBlock.Item(numbered.groupValues[3], numbered.groupValues[1].length / 2, numbered.groupValues[2]) }
            else -> {
                if (para.isNotEmpty()) para.append(if (raw.endsWith("  ")) "\n" else " ")
                para.append(line)
            }
        }
        i++
    }
    flush()
    return out.ifEmpty { listOf(MdBlock.Para(text)) }
}

// ---- inline ----

private val inlineRe = Regex(
    "(`[^`\\n]+`)|(\\*\\*.+?\\*\\*)|((?<!\\w)__.+?__(?!\\w))|(~~.+?~~)|(\\[[^\\]]+]\\([^)\\s]+\\))|(\\*[^*\\s][^*]*?\\*)|((?<!\\w)_[^_\\s][^_]*?_(?!\\w))",
)

/** Text with the inline markers stripped — used to size table columns. */
private fun plain(s: String): String = inlineRe.replace(s) { m ->
    val t = m.value
    when {
        t.startsWith("`") -> t.drop(1).dropLast(1)
        t.startsWith("**") || t.startsWith("__") || t.startsWith("~~") -> t.drop(2).dropLast(2)
        t.startsWith("[") -> t.substringAfter("[").substringBefore("]")
        else -> t.drop(1).dropLast(1)
    }
}

private fun inline(text: String): AnnotatedString = buildAnnotatedString { appendInline(text) }

private fun AnnotatedString.Builder.appendInline(text: String) {
    var last = 0
    for (m in inlineRe.findAll(text)) {
        if (m.range.first > last) append(text.substring(last, m.range.first))
        val t = m.value
        when {
            t.startsWith("`") -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = FridayChip, fontSize = 13.5.sp)) { append(t.drop(1).dropLast(1)) }
            t.startsWith("**") || t.startsWith("__") -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { appendInline(t.drop(2).dropLast(2)) }
            t.startsWith("~~") -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendInline(t.drop(2).dropLast(2)) }
            t.startsWith("[") -> {
                val label = t.substringAfter("[").substringBefore("](")
                val url = t.substringAfter("](").removeSuffix(")")
                withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = FridaySearch, textDecoration = TextDecoration.Underline)))) { append(label) }
            }
            else -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendInline(t.drop(1).dropLast(1)) }
        }
        last = m.range.last + 1
    }
    if (last < text.length) append(text.substring(last))
}
