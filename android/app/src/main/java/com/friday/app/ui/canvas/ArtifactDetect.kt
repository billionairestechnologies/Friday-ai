package com.friday.app.ui.canvas

/**
 * Live verification (2026-09-21) confirmed the backend has no dedicated artifact/canvas SSE frame —
 * html/code answers arrive as a plain fenced ```lang code block inside the normal "text" token stream.
 * Canvas is therefore driven by detecting that fence client-side, not by a backend event.
 */
enum class ArtifactKind { Html, React, Runnable }

data class DetectedArtifact(
    val kind: ArtifactKind,
    val lang: String,
    val code: String,
    /** False while the closing ``` hasn't arrived yet — still streaming. */
    val complete: Boolean,
)

private val REACT_LANGS = setOf("jsx", "tsx", "react")
private val RUNNABLE_LANGS = setOf("python", "py", "javascript", "js", "typescript", "ts", "java", "r", "bash", "sh", "shell")

/** Finds the first html/react/runnable fenced block in [content], if any. Plain/unlabeled fences are ignored. */
fun detectArtifact(content: String): DetectedArtifact? {
    val start = content.indexOf("```")
    if (start == -1) return null
    val afterFence = start + 3
    val lineEnd = content.indexOf('\n', afterFence)
    if (lineEnd == -1) return null
    val lang = content.substring(afterFence, lineEnd).trim().lowercase()
    if (lang.isBlank()) return null
    val kind = when {
        lang == "html" -> ArtifactKind.Html
        lang in REACT_LANGS -> ArtifactKind.React
        lang in RUNNABLE_LANGS -> ArtifactKind.Runnable
        else -> return null
    }
    val bodyStart = lineEnd + 1
    val closeIdx = content.indexOf("```", bodyStart)
    val complete = closeIdx != -1
    val body = if (complete) content.substring(bodyStart, closeIdx) else content.substring(bodyStart)
    return DetectedArtifact(kind, lang, body, complete)
}
