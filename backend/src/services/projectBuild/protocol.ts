/**
 * The build agent talks to the sandbox through tagged actions embedded in its reply (there is no
 * provider-independent native tool-calling across our adapters, so a text protocol is the common
 * denominator). Tags are prefixed `friday-` so they can never collide with ordinary code/markdown.
 *
 *   <friday-write path="src/App.jsx">…file contents…</friday-write>
 *   <friday-run desc="Install dependencies">npm install</friday-run>
 *   <friday-start port="5173" desc="Start the dev server">npm run dev</friday-start>
 *   <friday-read path="package.json"/>
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
  | { kind: "progress"; body: string }
  | { kind: "done"; summary: string }
  | { kind: "malformed"; reason: string };

const OPEN = "<friday-";
const NAMES = new Set(["write", "run", "start", "read", "done", "progress"]);

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
      if (!this.announced && (name === "write" || name === "run" || name === "start")) {
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
      case "done":
        return this.onAction({ kind: "done", summary: body.trim() });
    }
  }
}

/** Drops already-written file bodies from an older assistant turn so the agent's context stays
 *  small across many iterations — it can <friday-read> anything it needs again. */
export function compactAssistantTurn(text: string): string {
  return text.replace(
    /(<friday-write\s+path="[^"]*"\s*>)[\s\S]*?(<\/friday-write>)/g,
    "$1(content omitted — already written to the sandbox)$2",
  );
}
