package com.friday.app.data

object Seed {
    const val SHOWCASE_ID = "seed-glow"

    private const val CSS = """/* Soft ambient glow — Friday home */
.hero-glow {
  position: relative;
  isolation: isolate;
}
.hero-glow::before {
  content: "";
  position: absolute;
  inset: -20% -10% auto;
  height: 280px;
  background: radial-gradient(
    ellipse 70% 60% at 50% 40%,
    #d3e3fd 0%,
    rgba(211, 227, 253, 0) 72%
  );
  pointer-events: none;
}"""

    private const val PYTHON = """from pathlib import Path
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
"""

    fun showcase(): ChatThread = ChatThread(
        id = SHOWCASE_ID,
        title = "CSS glow animation from scratch",
        updatedAt = System.currentTimeMillis() - 12 * 60_000,
        messages = listOf(
            ChatMessage(
                id = "u1",
                role = Role.User,
                content = "Show me a CSS glow animation from scratch, plus a Python rename script.",
            ),
            ChatMessage(
                id = "a1",
                role = Role.Assistant,
                thinkingLabel = "Consulting my inner monologue…",
                thinkingSteps = listOf(
                    "Understanding the question",
                    "Mapping this out…",
                    "Planning…",
                ),
                content = "Walk the folder, normalize whitespace, and rename in place. Preview first if the directory is large.\n\n```css\n$CSS\n```\n\n```python\n$PYTHON\n```",
            ),
        ),
    )

    fun recents(): List<ChatThread> = listOf(
        showcase(),
        ChatThread("seed-lisbon", "Plan a 3-day trip to Lisbon", updatedAt = System.currentTimeMillis() - 40 * 60_000),
        ChatThread("seed-transformers", "Explain how transformers work, simply", updatedAt = System.currentTimeMillis() - 3 * 3600_000),
        ChatThread("seed-news", "Catch me up on the biggest stories today", updatedAt = System.currentTimeMillis() - 8 * 3600_000),
        ChatThread("seed-rename", "Write a Python script that renames files in bulk", updatedAt = System.currentTimeMillis() - 26 * 3600_000),
    )
}
