package com.friday.app.data

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/**
 * Offline mock stream. Swap this for [ApiClient] when you point Friday
 * at https://friday.billionairestechnologies.com (or your own backend).
 */
class ChatRepository : ChatServing {

    override fun send(prompt: String, modes: Set<Mode>): Flow<ChatEvent> = flow {
        val think = Mode.Think in modes
        val search = Mode.Search in modes
        val canvas = Mode.Canvas in modes

        if (think || search || canvas) {
            val label = when {
                think -> "Consulting my inner monologue…"
                search -> "Searching the web…"
                else -> "Preparing Canvas…"
            }
            val steps = buildList {
                add("Understanding the question")
                if (search) add("Scanning sources")
                add("Mapping this out…")
                if (canvas) add("Making it pixel-perfect…")
                add("Planning…")
            }
            for (i in 1..steps.size) {
                emit(ChatEvent.Thinking(label, steps.take(i)))
                delay(420)
            }
        } else {
            delay(180)
        }

        if (search) {
            emit(
                ChatEvent.Sources(
                    listOf(
                        Source("Friday notes", "https://friday.billionairestechnologies.com", "Product overview"),
                        Source("Compose docs", "https://developer.android.com/jetpack/compose", "UI toolkit"),
                        Source("Material 3", "https://m3.material.io", "Motion and color"),
                    ),
                ),
            )
            delay(220)
        }

        val body = replyFor(prompt, think, search, canvas)
        val words = body.split(Regex("(?<=\\s)"))
        val buf = StringBuilder()
        for (w in words) {
            buf.append(w)
            emit(ChatEvent.Token(buf.toString()))
            delay(if (think) 28 else 16)
        }

        if (canvas) {
            delay(200)
            emit(ChatEvent.CanvasUpdate(canvasHtml(prompt)))
        }
        emit(ChatEvent.Done)
    }

    private fun replyFor(prompt: String, think: Boolean, search: Boolean, canvas: Boolean): String {
        val lower = prompt.lowercase()
        if (lower.contains("python") || lower.contains("rename") || lower.contains("script")) {
            return """Here's a compact rename script. Preview first on a copy of the folder.

```python
from pathlib import Path
import re

folder = Path("inbox")
pattern = re.compile(r"\s+")

for path in folder.iterdir():
    if not path.is_file():
        continue
    stem = pattern.sub("_", path.stem).strip("_").lower()
    dest = path.with_name(f"{stem}{path.suffix.lower()}")
    if dest != path:
        path.rename(dest)
```

Walk once, normalize whitespace, keep the extension."""
        }
        if (lower.contains("css") || lower.contains("glow")) {
            return """A radial glow behind the composer. Keep it atmospheric, not neon.

```css
.hero-glow {
  background: radial-gradient(
    ellipse 72% 68% at 50% 48%,
    rgb(211 227 253 / 0.95),
    transparent 70%
  );
}
```"""
        }
        val prefix = buildString {
            if (think) append("Thought it through. ")
            if (search) append("Pulled a few sources. ")
            if (canvas) append("Drafted a canvas layout too. ")
        }
        return prefix + "Here's a clear take on “${prompt.trim()}”.\n\n" +
            "Keep the answer short, structured, and useful. Ask a follow-up if you want more depth."
    }

    private fun canvasHtml(prompt: String): String = """
        <article>
          <h1>Canvas</h1>
          <p>${prompt.take(80).replace("<", "<")}</p>
          <section class="card">Outline · layout · next steps</section>
        </article>
    """.trimIndent()
}

/** Ready-to-wire client for the live Friday API. */
interface ApiClient : ChatServing
