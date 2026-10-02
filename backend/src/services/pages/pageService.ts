import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { LIMITS, renderDocument, type DocFormat, type SheetSpec, type SlideSpec } from "../documents/render.js";

/**
 * Pages: live documents, spreadsheets and slide decks (migration 0044). The user edits them in
 * place in the app, Friday reads and writes them with tools, every save is a version that can be
 * restored, a page can be shared as a read-only link, and it exports to Word/PDF/Markdown,
 * Excel/CSV or PowerPoint through the same renderer as generated files.
 */

export type PageKind = "doc" | "sheet" | "slides";
export type DocContent = { markdown: string };
export type SheetContent = { sheets: SheetSpec[] };
export type SlidesContent = { slides: SlideSpec[]; theme_color?: string };
export type PageContent = DocContent | SheetContent | SlidesContent;

export type Page = {
  id: string;
  user_id: string;
  conversation_id: string | null;
  kind: PageKind;
  title: string;
  content: PageContent;
  version: number;
  share_token: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_CONTENT_BYTES = 1_500_000;
const MAX_SHEET_ROWS = 5_000;
const MAX_SHEET_COLS = 100;
const KEEP_VERSIONS = 100;
const COLUMNS = "id, user_id, conversation_id, kind, title, content, version, share_token, created_at, updated_at";

const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).slice(0, 5000));

/** Validates and normalises content for a kind; throws a readable 400 on anything malformed. */
export function normalizeContent(kind: PageKind, raw: unknown): PageContent {
  const c = (raw ?? {}) as Record<string, unknown>;
  let out: PageContent;
  if (kind === "doc") {
    const markdown = typeof c.markdown === "string" ? c.markdown : "";
    if (markdown.length > LIMITS.contentChars) throw new HttpError(400, "This document is too long — split it into several pages.");
    out = { markdown };
  } else if (kind === "sheet") {
    const sheets = (Array.isArray(c.sheets) ? c.sheets : []).slice(0, LIMITS.sheets).map((s, i) => {
      const sheet = (s ?? {}) as SheetSpec;
      const columns = (Array.isArray(sheet.columns) ? sheet.columns : []).slice(0, MAX_SHEET_COLS).map(cell);
      const rows = (Array.isArray(sheet.rows) ? sheet.rows : []).slice(0, MAX_SHEET_ROWS).map((r) => (Array.isArray(r) ? r.slice(0, MAX_SHEET_COLS).map(cell) : []));
      return { name: (typeof sheet.name === "string" && sheet.name.trim() ? sheet.name : `Sheet ${i + 1}`).slice(0, 31), columns, rows };
    });
    out = { sheets: sheets.length ? sheets : [{ name: "Sheet 1", columns: ["A", "B", "C"], rows: [["", "", ""]] }] };
  } else {
    const slides = (Array.isArray(c.slides) ? c.slides : []).slice(0, LIMITS.slides) as SlideSpec[];
    out = { slides: slides.length ? slides : [{ layout: "title", title: "Untitled", subtitle: "" }], ...(typeof c.theme_color === "string" ? { theme_color: c.theme_color } : {}) };
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_CONTENT_BYTES) throw new HttpError(413, "This page is too large (over 1.5 MB).");
  return out;
}

export async function listPages(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("pages")
    .select("id, kind, title, version, share_token, conversation_id, updated_at, created_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function getPage(userId: string, id: string): Promise<Page> {
  const { data } = await supabaseAdmin.from("pages").select(COLUMNS).eq("id", id).eq("user_id", userId).is("deleted_at", null).maybeSingle();
  if (!data) throw new HttpError(404, "Page not found");
  return data as Page;
}

async function saveVersion(page: Pick<Page, "id" | "version" | "title" | "content">, author: "user" | "friday") {
  await supabaseAdmin.from("page_versions").insert({ page_id: page.id, version: page.version, title: page.title, content: page.content, author });
  // Bounded history: drop the oldest beyond KEEP_VERSIONS.
  const { data } = await supabaseAdmin.from("page_versions").select("version").eq("page_id", page.id).order("version", { ascending: false }).range(KEEP_VERSIONS, KEEP_VERSIONS + 50);
  if (data?.length) await supabaseAdmin.from("page_versions").delete().eq("page_id", page.id).lte("version", Number(data[0]!.version));
}

export async function createPage(userId: string, input: { kind: PageKind; title: string; content?: unknown; conversationId?: string | null; author?: "user" | "friday" }): Promise<Page> {
  const content = normalizeContent(input.kind, input.content);
  const { data, error } = await supabaseAdmin
    .from("pages")
    .insert({ user_id: userId, conversation_id: input.conversationId ?? null, kind: input.kind, title: input.title.trim().slice(0, 200) || "Untitled", content })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't create the page");
  await saveVersion(data as Page, input.author ?? "user");
  return data as Page;
}

/**
 * Saves a new version. `baseVersion` = the version the editor (or Friday's read) started from: if
 * someone saved in between, the save is refused with 409 and the current page, so neither side
 * silently overwrites the other.
 */
export async function updatePage(userId: string, id: string, input: { title?: string; content?: unknown; baseVersion?: number; author?: "user" | "friday" }): Promise<Page> {
  const page = await getPage(userId, id);
  if (input.baseVersion !== undefined && input.baseVersion !== page.version) {
    throw new HttpError(409, "This page changed since you opened it — reload to see the latest version.");
  }
  const title = input.title !== undefined ? input.title.trim().slice(0, 200) || "Untitled" : page.title;
  const content = input.content !== undefined ? normalizeContent(page.kind, input.content) : page.content;
  const { data, error } = await supabaseAdmin
    .from("pages")
    .update({ title, content, version: page.version + 1, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("version", page.version) // compare-and-swap: a concurrent save loses cleanly
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(409, "This page changed since you opened it — reload to see the latest version.");
  await saveVersion(data as Page, input.author ?? "user");
  return data as Page;
}

export async function deletePage(userId: string, id: string) {
  await getPage(userId, id);
  await supabaseAdmin.from("pages").update({ deleted_at: new Date().toISOString(), share_token: null }).eq("id", id);
}

export async function listVersions(userId: string, id: string) {
  await getPage(userId, id);
  const { data, error } = await supabaseAdmin.from("page_versions").select("version, title, author, created_at").eq("page_id", id).order("version", { ascending: false }).limit(KEEP_VERSIONS);
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function getVersion(userId: string, id: string, version: number) {
  await getPage(userId, id);
  const { data } = await supabaseAdmin.from("page_versions").select("version, title, content, author, created_at").eq("page_id", id).eq("version", version).maybeSingle();
  if (!data) throw new HttpError(404, "Version not found");
  return data;
}

export async function restoreVersion(userId: string, id: string, version: number): Promise<Page> {
  const old = await getVersion(userId, id, version);
  return updatePage(userId, id, { title: old.title as string, content: old.content });
}

export async function setSharing(userId: string, id: string, on: boolean): Promise<Page> {
  const page = await getPage(userId, id);
  const token = on ? (page.share_token ?? randomBytes(18).toString("base64url")) : null;
  const { data, error } = await supabaseAdmin.from("pages").update({ share_token: token }).eq("id", id).select(COLUMNS).single();
  if (error) throw new HttpError(500, error.message);
  return data as Page;
}

/** Read-only public view by share token. */
export async function getSharedPage(token: string) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new HttpError(404, "Page not found");
  const { data } = await supabaseAdmin.from("pages").select("kind, title, content, updated_at").eq("share_token", token).is("deleted_at", null).maybeSingle();
  if (!data) throw new HttpError(404, "This link is off or the page was deleted.");
  return data;
}

export const EXPORT_FORMATS: Record<PageKind, DocFormat[]> = { doc: ["docx", "pdf", "md"], sheet: ["xlsx", "csv"], slides: ["pptx"] };

export async function exportPage(userId: string, id: string, format: DocFormat): Promise<{ bytes: Buffer; filename: string }> {
  const page = await getPage(userId, id);
  if (!EXPORT_FORMATS[page.kind].includes(format)) throw new HttpError(400, `A ${page.kind} exports as ${EXPORT_FORMATS[page.kind].join(", ")}`);
  const c = page.content as DocContent & SheetContent & SlidesContent;
  const bytes = await renderDocument({
    format,
    title: page.title,
    ...(page.kind === "doc" ? { content: c.markdown || " " } : page.kind === "sheet" ? { sheets: c.sheets } : { slides: c.slides, theme_color: c.theme_color }),
  });
  const base = page.title.replace(/[^\w\s.-]/g, "").trim().slice(0, 80) || "page";
  return { bytes, filename: `${base}.${format}` };
}

/** Pages made in this conversation (for the model's context: "the deck from earlier"). */
export async function pagesInConversation(conversationId: string) {
  const { data } = await supabaseAdmin.from("pages").select("id, kind, title, version").eq("conversation_id", conversationId).is("deleted_at", null).order("created_at").limit(30);
  return data ?? [];
}
