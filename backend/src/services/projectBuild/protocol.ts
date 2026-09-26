/**
 * The build agent talks to the sandbox through tagged actions embedded in its reply (there is no
 * provider-independent native tool-calling across our adapters, so a text protocol is the common
 * denominator). Tags are prefixed `friday-` so they can never collide with ordinary code/markdown.
 *
 *   <friday-write path="src/App.jsx">…file contents…</friday-write>
 *   <friday-run desc="Install dependencies">npm install</friday-run>
 *   <friday-start port="5173" desc="Start the dev server">npm run dev</friday-start>
 *   <friday-read path="package.json"/>
 *   <friday-edit path="src/App.jsx">
<<<<<<< SEARCH
exact existing lines
=======
replacement lines
>>>>>>> REPLACE
</friday-edit>
 *   <friday-grep pattern="useState" path="src"/>
 *   <friday-ls path="src"/>
 *   <friday-pr title="Add dark mode" branch="friday/dark-mode">PR description</friday-pr>
 *   <friday-progress>
- [x] finished item
- [~] item in progress
- [ ] item still to do
</friday-progress>
 *   <friday-done>one-paragraph summary for the user</friday-done>
 */
export type BuildAction =
  | { kind: "write"; path: string; content: string }
  | { kind: "run"; desc: string; cmd: string }
  | { kind: "start"; desc: string; cmd: string; port: number }
  | { kind: "read"; path: string }
  | { kind: "edit"; path: string; edits: SearchReplace[] }
  | { kind: "grep"; pattern: string; path: string }
  | { kind: "ls"; path: string }
  | { kind: "pr"; title: string; branch: string; body: string }
  | { kind: "progress"; body: string }
  | { kind: "done"; summary: string }
  | { kind: "malformed"; reason: string };

export type SearchReplace = { search: string; replace: string };

const OPEN = "<friday-";
const NAMES = new Set(["write", "run", "start", "read", "done", "progress", "edit", "grep", "ls", "pr"]);

/** Parses Aider-style SEARCH/REPLACE blocks. Returns null when the body has none or is malformed. */
export function parseSearchReplace(body: string): SearchReplace[] | null {
  const blocks: SearchReplace[] = [];
  const re = /<{5,9} ?SEARCH[^\n]*\n([\s\S]*?)\n?={5,9}[^\n]*\n([\s\S]*?)\n?>{5,9} ?REPLACE/g;
  for (const m of body.matchAll(re)) blocks.push({ search: m[1]!, replace: m[2]! });
  return blocks.length ? blocks : null;
}

/**
 * Applies SEARCH/REPLACE edits in order. Each SEARCH must match exactly once — first verbatim, then
 * ignoring trailing whitespace per line (models often drop it). Returns the new content or an error
 * the model can act on.
 */
export function applySearchReplace(content: string, edits: SearchReplace[]): { ok: true; content: string } | { ok: false; error: string } {
  let out = content;
  for (const [i, edit] of edits.entries()) {
    const label = `edit ${i + 1}`;
    if (!edit.search) {
      if (out.length > 0) return { ok: false, error: `${label}: empty SEARCH is only allowed for an empty file` };
      out = edit.replace;
      continue;
    }
    const first = out.indexOf(edit.search);
    if (first !== -1) {
      if (out.indexOf(edit.search, first + 1) !== -1) {
        return { ok: false, error: `${label}: SEARCH matches more than once — include more surrounding lines so it is unique` };
      }
      out = out.slice(0, first) + edit.replace + out.slice(first + edit.search.length);
      continue;
    }
    const norm = (t: string) => t.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
    const lines = out.split("\n");
    const want = norm(edit.search).split("\n");
    const hits: number[] = [];
    for (let at = 0; at + want.length <= lines.length; at++) {
      if (want.every((w, k) => lines[at + k]!.replace(/\s+$/, "") === w)) hits.push(at);
    }
    if (hits.length === 1) {
      lines.splice(hits[0]!, want.length, ...edit.replace.split("\n"));
      out = lines.join("\n");
      continue;
    }
    return {
      ok: false,
      error:
        hits.length > 1
          ? `${label}: SEARCH matches more than once — include more surrounding lines so it is unique`
          : `${label}: SEARCH text not found in the file — <friday-read> it and copy the lines exactly`,
    };
  }
  return { ok: true, content: out };
}

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([a-zA-Z_-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!] = m[3] ?? m[4] ?? "";
  return out;
}

/** Models like to wrap file contents in a markdown fence inside the tag — strip exactly that. */
function unfence(body: string): string {
  let text = body.replace(/^\r?\n/, "");
  const fenced = text.match(/^\s*```[\w+-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  if (fenced) text = fenced[1]!;
  return text.replace(/\r?\n$/, "");
}

/** Length of the longest suffix of `text` that is a proper prefix of `<friday-` (must be held back). */
function partialOpenLength(text: string): number {
  for (let len = Math.min(OPEN.length - 1, text.length); len > 0; len--) {
    if (OPEN.startsWith(text.slice(-len))) return len;
  }
  return 0;
}

/**
 * Incremental parser: feed() it streamed model text; prose goes to onText immediately (minus any
 * action tags) and each complete action goes to onAction in order.
 */
export class ActionParser {
  private buf = "";
  private announced = false;

  constructor(
    private readonly onText: (text: string) => void,
    private readonly onAction: (action: BuildAction) => void,
    /** Fires once as soon as a write/run/start tag OPENS (before its body finishes streaming), so the UI can show live activity. */
    private readonly onOpenTag?: (name: string, attrs: Record<string, string>) => void,
  ) {}

  feed(chunk: string) {
    this.buf += chunk;
    this.drain(false);
  }

  end() {
    this.drain(true);
  }

  private drain(final: boolean) {
    for (;;) {
      const idx = this.buf.indexOf(OPEN);
      if (idx === -1) {
        const hold = final ? 0 : partialOpenLength(this.buf);
        const emit = this.buf.slice(0, this.buf.length - hold);
        if (emit) this.onText(emit);
        this.buf = this.buf.slice(this.buf.length - hold);
        return;
      }
      if (idx > 0) {
        this.onText(this.buf.slice(0, idx));
        this.buf = this.buf.slice(idx);
      }
      const gt = this.buf.indexOf(">");
      if (gt === -1) {
        if (final) this.onAction({ kind: "malformed", reason: "an action tag was cut off" });
        if (final) this.buf = "";
        return;
      }
      const head = this.buf.slice(OPEN.length, gt); // e.g. `write path="a.js"` or `read path="x"/`
      const name = head.match(/^[a-z]+/)?.[0] ?? "";
      if (!NAMES.has(name)) {
        // Not one of ours — treat the "<friday-" as plain text and move on.
        this.onText(OPEN);
        this.buf = this.buf.slice(OPEN.length);
        continue;
      }
      const selfClosing = head.endsWith("/");
      const attrSource = head.slice(name.length).replace(/\/$/, "");
      const a = attrs(attrSource);
      if (selfClosing) {
        this.emit(name, a, "");
        this.buf = this.buf.slice(gt + 1);
        continue;
      }
      const closeTag = `</friday-${name}>`;
      const close = this.buf.indexOf(closeTag, gt + 1);
      if (!this.announced && (name === "write" || name === "run" || name === "start" || name === "edit")) {
        this.announced = true;
        this.onOpenTag?.(name, a);
      }
      if (close === -1) {
        if (final) {
          this.onAction({ kind: "malformed", reason: `your <friday-${name}> block was cut off before its closing tag` });
          this.buf = "";
          this.announced = false;
        }
        return;
      }
      const body = this.buf.slice(gt + 1, close);
      this.buf = this.buf.slice(close + closeTag.length);
      this.announced = false;
      this.emit(name, a, body);
    }
  }

  private emit(name: string, a: Record<string, string>, body: string) {
    switch (name) {
      case "write":
        if (!a.path) return this.onAction({ kind: "malformed", reason: "<friday-write> is missing its path" });
        return this.onAction({ kind: "write", path: a.path, content: unfence(body) });
      case "run":
        return this.onAction({ kind: "run", desc: a.desc || "Run command", cmd: body.trim() });
      case "start": {
        const port = Number(a.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return this.onAction({ kind: "malformed", reason: "<friday-start> needs a numeric port" });
        }
        return this.onAction({ kind: "start", desc: a.desc || "Start server", cmd: body.trim(), port });
      }
      case "read":
        if (!a.path) return this.onAction({ kind: "malformed", reason: "<friday-read> is missing its path" });
        return this.onAction({ kind: "read", path: a.path });
      case "progress":
        return this.onAction({ kind: "progress", body });
      case "edit": {
        if (!a.path) return this.onAction({ kind: "malformed", reason: "<friday-edit> is missing its path" });
        const edits = parseSearchReplace(body);
        if (!edits) return this.onAction({ kind: "malformed", reason: "<friday-edit> needs <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks" });
        return this.onAction({ kind: "edit", path: a.path, edits });
      }
      case "grep":
        if (!a.pattern) return this.onAction({ kind: "malformed", reason: "<friday-grep> is missing its pattern" });
        return this.onAction({ kind: "grep", pattern: a.pattern, path: a.path || "." });
      case "ls":
        return this.onAction({ kind: "ls", path: a.path || "." });
      case "pr":
        if (!a.title) return this.onAction({ kind: "malformed", reason: "<friday-pr> is missing its title" });
        return this.onAction({ kind: "pr", title: a.title, branch: a.branch || "", body: body.trim() });
      case "done":
        return this.onAction({ kind: "done", summary: body.trim() });
    }
  }
}

/** Drops already-written file bodies from an older assistant turn so the agent's context stays
 *  small across many iterations — it can <friday-read> anything it needs again. */
export function compactAssistantTurn(text: string): string {
  return text
    .replace(/(<friday-write\s+path="[^"]*"\s*>)[\s\S]*?(<\/friday-write>)/g, "$1(content omitted — already written to the sandbox)$2")
    .replace(/(<friday-edit\s+path="[^"]*"\s*>)[\s\S]*?(<\/friday-edit>)/g, "$1(edit omitted — already applied)$2");
}
