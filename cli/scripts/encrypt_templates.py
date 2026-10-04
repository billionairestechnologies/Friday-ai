#!/usr/bin/env python3
"""Regenerates crates/codegen/xai-grok-agent/src/prompt/prompt_encrypted.rs from the plaintext templates.

The prompt templates are stored XOR-obfuscated in the binary (obfuscation, not security) so they don't show up as
plain text in `strings`. Edit crates/codegen/xai-grok-agent/templates/*.md, then run this script; the unit test
`test_encrypted_templates_not_stale` fails if the two drift apart.
"""
import os, re, sys

here = os.path.dirname(os.path.abspath(__file__))
agent = os.path.join(here, "..", "crates", "codegen", "xai-grok-agent")
enc_path = os.path.join(agent, "src", "prompt", "prompt_encrypted.rs")
src = open(enc_path, encoding="utf-8").read()
seeds = [int(x, 16) for x in re.search(r"PROMPT_SEEDS: \[u8; 3\] = \[([^\]]*)\]", src).group(1).replace("0x", "").split(",")]

targets = [
    ("BASE_PROMPT_ENC", "prompt.md", seeds[0]),
    ("CODEX_PROMPT_ENC", "apply_patch_prompt.md", seeds[1]),
    ("SUBAGENT_PROMPT_ENC", "subagent_prompt.md", seeds[2]),
]
for name, template, seed in targets:
    raw = open(os.path.join(agent, "templates", template), "rb").read()
    enc = bytes((b ^ ((seed + i) & 0xFF)) for i, b in enumerate(raw))
    body = ", ".join(str(b) for b in enc)
    pattern = re.compile(r"(pub\(crate\) const " + name + r": &\[u8\] = &\[)[^\]]*(\];)")
    if not pattern.search(src):
        sys.exit(f"{name} not found in prompt_encrypted.rs")
    src = pattern.sub(lambda m: m.group(1) + body + m.group(2), src, count=1)
open(enc_path, "w", encoding="utf-8").write(src)
print("regenerated", enc_path)
