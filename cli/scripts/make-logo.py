#!/usr/bin/env python3
"""Renders the Friday wordmark (from frontend/public/icon-512.png) into the braille-dot art the welcome screen shows.

  python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow && /tmp/v/bin/python cli/scripts/make-logo.py

Writes crates/codegen/xai-grok-pager/assets/logo/logo07.txt (full) and logo05.txt (compact).
"""
import os
from PIL import Image

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
icon = Image.open(os.path.join(root, "frontend", "public", "icon-512.png")).convert("L")
# the white wordmark sits in the middle of the rounded black square
word = icon.crop((60, 180, 450, 335))
bbox = word.point(lambda v: 255 if v > 128 else 0).getbbox()
word = word.crop(bbox)

def braille(img, rows):
    h = rows * 4
    w = round(img.width * h / img.height)
    w += w % 2
    small = img.resize((w, h), Image.LANCZOS).point(lambda v: 255 if v > 110 else 0)
    px = small.load()
    out = []
    for r in range(rows):
        line = ""
        for c in range(w // 2):
            bits = 0
            for dx, dy, bit in ((0, 0, 0), (0, 1, 1), (0, 2, 2), (1, 0, 3), (1, 1, 4), (1, 2, 5), (0, 3, 6), (1, 3, 7)):
                if px[c * 2 + dx, r * 4 + dy]:
                    bits |= 1 << bit
            line += chr(0x2800 + bits)
        out.append(line.rstrip("⠀") or "⠀")
    width = max(len(l) for l in out)
    return "\n".join(l.ljust(width, "⠀") for l in out) + "\n"

dest = os.path.join(root, "cli", "crates", "codegen", "xai-grok-pager", "assets", "logo")
for name, rows in (("logo07.txt", 8), ("logo05.txt", 5)):
    art = braille(word, rows)
    open(os.path.join(dest, name), "w", encoding="utf-8").write(art)
    print(name, rows, "rows x", len(art.split("\n")[0]), "cols")
    print(art)
