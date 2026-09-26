package com.friday.app.ui.canvas

import org.json.JSONObject

/**
 * Live verification (2026-09-21) confirmed the backend has no dedicated artifact/canvas SSE frame —
 * html/code answers arrive as a plain fenced ```lang code block inside the normal "text" token stream.
 * Canvas is therefore driven by detecting that fence client-side, not by a backend event.
 *
 * Priority mirrors the web app's extractArtifact(): html page, then React, then runnable code, then
 * any other code shown as static text ([ArtifactKind.Code]).
 */
enum class ArtifactKind { Html, React, Runnable, Code }

data class DetectedArtifact(
    val kind: ArtifactKind,
    val lang: String,
    val code: String,
    /** False while the closing ``` hasn't arrived yet — still streaming. */
    val complete: Boolean,
    /** Separate ```css fence(s) from the same reply (App.jsx + App.css), applied to the preview. */
    val css: String? = null,
) {
    /** Kinds that have a rendered Preview tab (vs. code-only / run-in-sandbox). */
    val previewable: Boolean get() = kind == ArtifactKind.Html || kind == ArtifactKind.React
}

private val RUNNABLE_LANGS = setOf("python", "py", "javascript", "js", "typescript", "ts", "java", "r", "bash", "sh", "shell")
private val JS_LANGS = setOf("javascript", "js", "typescript", "ts")

private data class Fence(val lang: String, val body: String, val complete: Boolean)

private fun fences(content: String): List<Fence> {
    val out = mutableListOf<Fence>()
    var i = 0
    while (true) {
        val s = content.indexOf("```", i)
        if (s == -1) break
        val lineEnd = content.indexOf('\n', s + 3)
        if (lineEnd == -1) break
        val lang = content.substring(s + 3, lineEnd).trim().substringBefore(' ').lowercase()
        val bodyStart = lineEnd + 1
        val close = content.indexOf("```", bodyStart)
        if (close == -1) {
            out += Fence(lang, content.substring(bodyStart), complete = false)
            break
        }
        out += Fence(lang, content.substring(bodyStart, close), complete = true)
        i = close + 3
    }
    return out
}

private val JSX_PAIR = Regex("<([A-Za-z][\\w.]*)[^>]*>[\\s\\S]*</\\1>")
private val JSX_SELF = Regex("<[A-Za-z][\\w.]*[^>]*/>")
private val REACT_API = Regex("\\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer)\\s*\\(")

/** Models sometimes fence a React component as ```javascript — treat clear JSX / hook usage as React. */
private fun looksLikeReact(body: String) = JSX_PAIR.containsMatchIn(body) || JSX_SELF.containsMatchIn(body) || REACT_API.containsMatchIn(body)

fun detectArtifact(content: String): DetectedArtifact? {
    val blocks = fences(content).filter { it.body.isNotBlank() }
    if (blocks.isEmpty()) return null
    val css = blocks.filter { it.lang == "css" }.joinToString("\n\n") { it.body.trim() }.ifBlank { null }

    blocks.firstOrNull { it.lang == "html" }?.let {
        return DetectedArtifact(ArtifactKind.Html, "html", it.body, it.complete, css)
    }
    blocks.firstOrNull { it.lang in setOf("jsx", "tsx", "react") || (it.lang in JS_LANGS && looksLikeReact(it.body)) }?.let {
        return DetectedArtifact(ArtifactKind.React, it.lang, it.body, it.complete, css)
    }
    blocks.firstOrNull { it.lang in RUNNABLE_LANGS }?.let {
        return DetectedArtifact(ArtifactKind.Runnable, it.lang, it.body, it.complete)
    }
    // Everything else (css, go, sql, php, json, unlabeled…) has nothing to execute — show it as code.
    // Diagrams and copy-paste text stay in the chat bubble (own diagram / copy-box rendering).
    val chatOnly = setOf("mermaid", "text", "plaintext", "txt", "markdown", "md")
    val first = blocks.firstOrNull { it.lang == "css" } ?: blocks.firstOrNull { it.lang !in chatOnly } ?: return null
    if (first.lang != "css" && content.length <= 120) return null
    return DetectedArtifact(ArtifactKind.Code, first.lang.ifBlank { "text" }, first.body, first.complete)
}

private fun jsonLiteral(s: String) = JSONObject.quote(s).replace("<", "\\u003c")

/** Full standalone preview document for a JSX/TSX component (see ReactPreviewShell.kt). */
fun reactPreviewHtml(code: String, css: String?): String =
    REACT_PREVIEW_SHELL.replace("__CSS_JSON__", jsonLiteral(css.orEmpty())).replace("__SOURCE_JSON__", jsonLiteral(code))

/** Adds a separate stylesheet fence to a full HTML page for the preview. */
fun htmlWithCss(html: String, css: String?): String {
    if (css.isNullOrBlank()) return html
    val tag = "<style>$css</style>"
    val idx = html.indexOf("</head>", ignoreCase = true)
    return if (idx >= 0) html.substring(0, idx) + tag + html.substring(idx) else tag + html
}
