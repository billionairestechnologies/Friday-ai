#!/usr/bin/env python3
"""Friday X egress audit (static half).

Friday X talks to the Friday backend and to nothing else the vendor it was forked from operated. This scans
the production Rust source (test files, and everything from a file's first `#[cfg(test)]` down, are skipped)
for hosts that must not appear, and exits non-zero if it finds one. The runtime half is
scripts/audit-egress-runtime.md: run the binary behind a refusing proxy and read what it tried to reach.

  python3 scripts/audit-egress.py            # report + exit 1 on any hit
  python3 scripts/audit-egress.py --list     # report only
"""
import os, re, sys

FORBIDDEN = re.compile(
    r"(?i)(?:https?|wss?)://[^\s\"'`)>]*?(?:\bx\.ai\b|grok\.com|api\.x\.ai|xai-org|xai-official|mixpanel\.com|"
    r"googleapis\.com/grok|storage\.googleapis\.com/grok|sentry\.io|datadoghq|segment\.io|amplitude\.com)"
)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "crates")
SKIP_DIRS = {"target", "third_party", "node_modules", "tests", "testkit", "benches", "xai-grok-pager-pty-harness", "xai-grok-test-support"}


def production_lines(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        for n, line in enumerate(fh, 1):
            if line.strip().startswith("#[cfg(test)]"):
                return
            yield n, line


def main():
    hits = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in fn:
            if not f.endswith(".rs") or f.endswith(("_tests.rs", "tests.rs", "_test.rs", "test_support.rs")) or f.startswith("test_"):
                continue
            p = os.path.join(dp, f)
            for n, line in production_lines(p):
                s = line.strip()
                if s.startswith(("//", "///", "//!")):
                    continue
                m = FORBIDDEN.search(line)
                if m:
                    hits.append((os.path.relpath(p, ROOT), n, m.group(0)))
    for p, n, h in sorted(hits):
        print(f"{p}:{n}: {h}")
    print(f"\n{len(hits)} forbidden host reference(s) in production code")
    return 1 if hits and "--list" not in sys.argv else 0


sys.exit(main())
