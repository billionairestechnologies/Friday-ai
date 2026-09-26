package com.friday.app.ui.chat

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color as AColor
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.friday.app.ui.theme.CodeCorner
import com.friday.app.ui.theme.FridayCodeBg
import com.friday.app.ui.theme.FridayCodeComment
import com.friday.app.ui.theme.FridayCodeTag
import kotlinx.coroutines.delay

private fun escapeForScript(s: String): String =
    s.replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$").replace("</", "<\\/")

private fun mermaidHtml(src: String): String = """
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
#d{padding:8px 12px 12px;display:flex;justify-content:center}
#d svg{max-width:100%;height:auto}</style></head>
<body><div id="d"></div>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
try {
  mermaid.initialize({startOnLoad:false, theme:'dark', securityLevel:'strict'});
  const { svg } = await mermaid.render('g', `${escapeForScript(src)}`);
  document.getElementById('d').innerHTML = svg;
  const h = Math.ceil(document.getElementById('d').getBoundingClientRect().height);
  Android.onRendered(h);
} catch (e) { Android.onError(String(e)); }
</script></body></html>
"""

private class Bridge(val onOk: (Int) -> Unit, val onFail: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    @JavascriptInterface fun onRendered(h: Int) { main.post { onOk(h) } }
    @JavascriptInterface fun onError(msg: String) { main.post { onFail() } }
}

/** Renders a ```mermaid block as a diagram; falls back to the plain code block until/unless it succeeds. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun MermaidBlock(body: String) {
    val ctx = LocalContext.current
    // Debounce: only start rendering once the source has been stable for 350ms.
    var stable by remember { mutableStateOf<String?>(null) }
    var heightDp by remember(stable) { mutableIntStateOf(0) }
    var failed by remember(stable) { mutableStateOf(false) }
    LaunchedEffect(body) { delay(350); stable = body }
    LaunchedEffect(stable) {
        if (stable != null) {
            delay(15_000)
            if (heightDp == 0) failed = true
        }
    }
    val src = stable
    val ready = heightDp > 0 && !failed
    if (!ready) CodeBlock("mermaid", body)
    if (src != null && !failed) {
        val bridge = remember(src) { Bridge({ heightDp = it.coerceAtLeast(40) }, { failed = true }) }
        Column(
            Modifier
                .fillMaxWidth()
                .then(if (ready) Modifier.clip(RoundedCornerShape(CodeCorner)).background(FridayCodeBg) else Modifier.height(1.dp)),
        ) {
            if (ready) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("diagram", color = FridayCodeComment, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    Text(
                        "Copy", color = FridayCodeTag, fontSize = 12.sp, fontWeight = FontWeight.Medium,
                        modifier = Modifier.clickable { copyText(ctx, src) },
                    )
                }
            }
            AndroidView(
                modifier = Modifier.fillMaxWidth().height(if (ready) heightDp.dp else 1.dp),
                factory = { c ->
                    WebView(c).apply {
                        setBackgroundColor(AColor.TRANSPARENT)
                        isVerticalScrollBarEnabled = false
                        isHorizontalScrollBarEnabled = false
                        overScrollMode = android.view.View.OVER_SCROLL_NEVER
                        settings.javaScriptEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        addJavascriptInterface(bridge, "Android")
                        loadDataWithBaseURL("https://cdn.jsdelivr.net/", mermaidHtml(src), "text/html", "utf-8", null)
                    }
                },
                onRelease = { it.removeJavascriptInterface("Android"); it.destroy() },
            )
        }
    }
}

private fun copyText(ctx: Context, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("diagram", text))
    Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
}
