package com.friday.app.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.ui.theme.CodeCorner
import com.friday.app.ui.theme.FridayCodeAttr
import com.friday.app.ui.theme.FridayCodeBg
import com.friday.app.ui.theme.FridayCodeComment
import com.friday.app.ui.theme.FridayCodeFg
import com.friday.app.ui.theme.FridayCodeString
import com.friday.app.ui.theme.FridayCodeTag

@Composable
fun CodeBlock(lang: String, body: String) {
    val ctx = LocalContext.current
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(CodeCorner))
            .background(FridayCodeBg),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(lang.ifBlank { "code" }, color = FridayCodeComment, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            Text(
                "Copy",
                color = FridayCodeTag,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.clickable { copy(ctx, body) },
            )
        }
        Text(
            highlight(body, lang),
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            lineHeight = 20.sp,
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(start = 14.dp, end = 14.dp, bottom = 14.dp),
        )
    }
}

private fun copy(ctx: Context, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("code", text))
    Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
}

private fun highlight(src: String, lang: String) = buildAnnotatedString {
    val comment = when (lang.lowercase()) {
        "css" -> Regex("/\\*[\\s\\S]*?\\*/")
        "python", "py" -> Regex("#[^\\n]*")
        else -> Regex("//[^\\n]*")
    }
    val string = Regex("\"([^\"\\\\]|\\\\.)*\"|'([^'\\\\]|\\\\.)*'")
    val tag = Regex("\\b(fun|val|var|class|from|import|def|for|if|else|return|const|let|function)\\b")
    val attr = Regex("\\b([a-zA-Z_-][\\w-]*)\\s*(?=[:\\(=])")

    val marks = mutableListOf<Triple<IntRange, androidx.compose.ui.graphics.Color, Boolean>>()
    fun add(r: Regex, c: androidx.compose.ui.graphics.Color) {
        r.findAll(src).forEach { marks += Triple(it.range, c, false) }
    }
    add(comment, FridayCodeComment)
    add(string, FridayCodeString)
    add(tag, FridayCodeTag)
    add(attr, FridayCodeAttr)
    val occupied = BooleanArray(src.length)
    marks.sortedBy { it.first.first }.forEach { (range, color, _) ->
        if (range.first in occupied.indices && !occupied[range.first]) {
            for (i in range) if (i in occupied.indices) occupied[i] = true
            marks[marks.indexOfFirst { it.first == range }] = Triple(range, color, true)
        }
    }
    var i = 0
    val used = marks.filter { it.third }.sortedBy { it.first.first }
    var u = 0
    while (i < src.length) {
        val hit = used.getOrNull(u)
        if (hit != null && i == hit.first.first) {
            withStyle(SpanStyle(color = hit.second)) { append(src.substring(hit.first)) }
            i = hit.first.last + 1
            u++
        } else {
            withStyle(SpanStyle(color = FridayCodeFg)) { append(src[i]) }
            i++
        }
    }
}
