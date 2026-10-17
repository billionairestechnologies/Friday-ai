import type { SheetSpec, SlideSpec } from "../documents/render.js";
import type { DocContent, PageContent, PageKind, SheetContent, SlidesContent } from "./pageService.js";

/**
 * Targeted edits to a page (brief §16: "change only slide two", "update the price in this table")
 * and version diffs. Pure: given content + edits → new content, or a reason nothing changed. Every
 * edit touches only what it names; everything else is carried over untouched. An edit whose target
 * is ambiguous or missing changes NOTHING and says why, so the model asks or re-reads instead of
 * guessing.
 */

export type DocEdit = { find: string; replace?: string; occurrence?: number };
export type SectionEdit = { heading: string; markdown: string };
export type CellEdit = { sheet?: string; cell: string; value?: string };
export type SlideEdit = { index: number; slide?: SlideSpec; delete?: boolean; insert_after?: SlideSpec; move_to?: number };

export type EditArgs = {
  markdown?: string;
  edits?: DocEdit[];
  sections?: SectionEdit[];
  sheets?: SheetSpec[];
  cells?: CellEdit[];
  slides?: SlideSpec[];
  slide_edits?: SlideEdit[];
};

export type EditResult = { ok: true; content: PageContent; changed: string[] } | { ok: false; error: string };

const fail = (error: string): EditResult => ({ ok: false, error });

function countOccurrences(text: string, find: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) at.push(i);
  return at;
}

/** A1 → zero-based {row, col}; row -1 = the header row (row 1). */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})(\d{1,6})$/i.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (row < 1) return null;
  return { row: row - 2, col: col - 1 };
}

/** The markdown section under a heading: from the heading line to the next heading of the same or higher level. */
function findSection(markdown: string, heading: string): { start: number; end: number } | "missing" | "ambiguous" {
  const lines = markdown.split("\n");
  const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  const hits: Array<{ line: number; level: number }> = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m && m[2]!.trim().toLowerCase() === want) hits.push({ line: i, level: m[1]!.length });
  });
  if (hits.length === 0) return "missing";
  if (hits.length > 1) return "ambiguous";
  const { line, level } = hits[0]!;
  let end = lines.length;
  inFence = false;
  for (let i = line + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s/.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return { start: line, end };
}

export function applyEdits(kind: PageKind, current: PageContent, args: EditArgs): EditResult {
  const changed: string[] = [];
  if (kind === "doc") {
    let markdown = typeof args.markdown === "string" ? args.markdown : (current as DocContent).markdown;
    if (typeof args.markdown === "string") changed.push("whole document");
    for (const e of args.edits ?? []) {
      if (!e.find) continue;
      const at = countOccurrences(markdown, e.find);
      if (at.length === 0) return fail(`Text not found: "${e.find.slice(0, 80)}". Nothing was changed — read_page and quote the text exactly.`);
      let pick: number;
      if (e.occurrence != null) {
        if (!Number.isInteger(e.occurrence) || e.occurrence < 1 || e.occurrence > at.length) return fail(`"${e.find.slice(0, 60)}" appears ${at.length} time(s); occurrence ${e.occurrence} doesn't exist. Nothing was changed.`);
        pick = at[e.occurrence - 1]!;
      } else if (at.length > 1) {
        return fail(`"${e.find.slice(0, 60)}" appears ${at.length} times — quote more surrounding text, pass \`occurrence\`, or ask the user which one. Nothing was changed.`);
      } else pick = at[0]!;
      markdown = markdown.slice(0, pick) + (e.replace ?? "") + markdown.slice(pick + e.find.length);
      changed.push(`text "${e.find.slice(0, 40)}"`);
    }
    for (const s of args.sections ?? []) {
      const where = findSection(markdown, s.heading);
      if (where === "missing") return fail(`No heading "${s.heading}" in the document. Nothing was changed.`);
      if (where === "ambiguous") return fail(`More than one heading is called "${s.heading}" — ask the user which section. Nothing was changed.`);
      const lines = markdown.split("\n");
      const body = s.markdown.replace(/\n+$/, "").split("\n");
      lines.splice(where.start, where.end - where.start, ...body, ...(where.end < lines.length ? [""] : []));
      markdown = lines.join("\n");
      changed.push(`section "${s.heading}"`);
    }
    return { ok: true, content: { markdown }, changed };
  }

  if (kind === "sheet") {
    const sheets: SheetSpec[] = Array.isArray(args.sheets) ? args.sheets : structuredClone((current as SheetContent).sheets);
    if (Array.isArray(args.sheets)) changed.push("all sheets");
    for (const c of args.cells ?? []) {
      const sheet = c.sheet ? sheets.find((s) => s.name === c.sheet) : sheets.length === 1 ? sheets[0] : undefined;
      if (!sheet) return fail(c.sheet ? `No sheet named "${c.sheet}". Nothing was changed.` : `This workbook has ${sheets.length} sheets — say which one. Nothing was changed.`);
      const ref = parseCellRef(c.cell ?? "");
      if (!ref) return fail(`Bad cell reference "${c.cell}". Use A1-style like C4. Nothing was changed.`);
      if (ref.row === -1) {
        sheet.columns = sheet.columns ?? [];
        while (sheet.columns.length <= ref.col) sheet.columns.push("");
        sheet.columns[ref.col] = c.value ?? "";
      } else {
        sheet.rows = sheet.rows ?? [];
        while (sheet.rows.length <= ref.row) sheet.rows.push([]);
        const row = sheet.rows[ref.row]!;
        while (row.length <= ref.col) row.push("");
        row[ref.col] = c.value ?? "";
      }
      changed.push(`${sheet.name}!${c.cell!.toUpperCase()}`);
    }
    return { ok: true, content: { sheets }, changed };
  }

  const base = current as SlidesContent;
  let slides: SlideSpec[] = Array.isArray(args.slides) ? args.slides : structuredClone(base.slides);
  if (Array.isArray(args.slides)) changed.push("all slides");
  const edits = args.slide_edits ?? [];
  const n = slides.length;
  for (const e of edits) {
    if (!Number.isInteger(e.index) || e.index < 1 || e.index > n) return fail(`There is no slide ${e.index} (the deck has ${n}). Nothing was changed.`);
  }
  // Every edit names slides by the numbering the model SAW; track each original slide by reference
  // so deletes / inserts / moves never shift what a later edit points at.
  const ref = [...slides];
  for (const e of edits) {
    if (e.slide && !e.delete) {
      const at = slides.indexOf(ref[e.index - 1]!);
      slides[at] = e.slide;
      ref[e.index - 1] = e.slide;
      changed.push(`slide ${e.index}`);
    }
  }
  for (const e of edits) {
    if (e.insert_after && !e.delete) {
      slides.splice(slides.indexOf(ref[e.index - 1]!) + 1, 0, e.insert_after);
      changed.push(`new slide after ${e.index}`);
    }
  }
  for (const e of edits) {
    if (e.delete) {
      slides.splice(slides.indexOf(ref[e.index - 1]!), 1);
      changed.push(`deleted slide ${e.index}`);
    }
  }
  for (const e of edits) {
    if (e.move_to == null || e.delete) continue;
    if (!Number.isInteger(e.move_to) || e.move_to < 1 || e.move_to > slides.length) return fail(`Can't move slide ${e.index} to position ${e.move_to} (the deck has ${slides.length}). Nothing was changed.`);
    const [moved] = slides.splice(slides.indexOf(ref[e.index - 1]!), 1);
    slides.splice(e.move_to - 1, 0, moved!);
    changed.push(`moved slide ${e.index} → ${e.move_to}`);
  }
  if (slides.length === 0) slides = [{ layout: "title", title: "Untitled", subtitle: "" } as SlideSpec];
  return { ok: true, content: { slides, ...(base.theme_color ? { theme_color: base.theme_color } : {}) }, changed };
}

// ── Diffs ────────────────────────────────────────────────────────────────────

export type LineDiff = { op: "same" | "add" | "del"; text: string };

/** Line diff (LCS). Long documents fall back to a prefix/suffix trim so it stays fast. */
export function diffLines(a: string, b: string): LineDiff[] {
  const A = a.split("\n");
  const B = b.split("\n");
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const mid: LineDiff[] = [];
  if (a2.length * b2.length > 4_000_000) {
    for (const t of a2) mid.push({ op: "del", text: t });
    for (const t of b2) mid.push({ op: "add", text: t });
  } else {
    const dp: number[][] = Array.from({ length: a2.length + 1 }, () => new Array<number>(b2.length + 1).fill(0));
    for (let i = a2.length - 1; i >= 0; i--) for (let j = b2.length - 1; j >= 0; j--) dp[i]![j] = a2[i] === b2[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < a2.length || j < b2.length) {
      if (i < a2.length && j < b2.length && a2[i] === b2[j]) {
        mid.push({ op: "same", text: a2[i]! });
        i++;
        j++;
      } else if (j < b2.length && (i >= a2.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) mid.push({ op: "add", text: b2[j++]! });
      else mid.push({ op: "del", text: a2[i++]! });
    }
  }
  return [...A.slice(0, pre).map((t) => ({ op: "same" as const, text: t })), ...mid, ...A.slice(A.length - suf).map((t) => ({ op: "same" as const, text: t }))];
}

export type ContentDiff =
  | { kind: "doc"; lines: LineDiff[]; added: number; removed: number }
  | { kind: "sheet"; cells: Array<{ sheet: string; cell: string; before: string; after: string }>; sheetsAdded: string[]; sheetsRemoved: string[] }
  | { kind: "slides"; slides: Array<{ index: number; change: "added" | "removed" | "changed"; title: string }> };

const colName = (c: number) => {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function diffContent(kind: PageKind, before: PageContent, after: PageContent): ContentDiff {
  if (kind === "doc") {
    const lines = diffLines((before as DocContent).markdown ?? "", (after as DocContent).markdown ?? "");
    return { kind, lines, added: lines.filter((l) => l.op === "add").length, removed: lines.filter((l) => l.op === "del").length };
  }
  if (kind === "sheet") {
    const a = (before as SheetContent).sheets ?? [];
    const b = (after as SheetContent).sheets ?? [];
    const cells: Array<{ sheet: string; cell: string; before: string; after: string }> = [];
    for (const sb of b) {
      const sa = a.find((s) => s.name === sb.name);
      if (!sa) continue;
      const grid = (s: SheetSpec) => [s.columns ?? [], ...(s.rows ?? [])];
      const ga = grid(sa);
      const gb = grid(sb);
      for (let r = 0; r < Math.max(ga.length, gb.length); r++) {
        const ra = ga[r] ?? [];
        const rb = gb[r] ?? [];
        for (let c = 0; c < Math.max(ra.length, rb.length); c++) {
          const x = String(ra[c] ?? "");
          const y = String(rb[c] ?? "");
          if (x !== y && cells.length < 500) cells.push({ sheet: sb.name ?? "", cell: `${colName(c)}${r + 1}`, before: x, after: y });
        }
      }
    }
    return { kind, cells, sheetsAdded: b.filter((s) => !a.some((x) => x.name === s.name)).map((s) => s.name ?? ""), sheetsRemoved: a.filter((s) => !b.some((x) => x.name === s.name)).map((s) => s.name ?? "") };
  }
  const a = (before as SlidesContent).slides ?? [];
  const b = (after as SlidesContent).slides ?? [];
  const title = (s: SlideSpec | undefined) => String((s as { title?: unknown } | undefined)?.title ?? "Untitled");
  const out: Array<{ index: number; change: "added" | "removed" | "changed"; title: string }> = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) out.push({ index: i + 1, change: "added", title: title(b[i]) });
    else if (i >= b.length) out.push({ index: i + 1, change: "removed", title: title(a[i]) });
    else if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) out.push({ index: i + 1, change: "changed", title: title(b[i]) });
  }
  return { kind, slides: out };
}
