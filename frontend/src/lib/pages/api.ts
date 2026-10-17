import { API_BASE_URL, api, getAccessToken } from "@/lib/api";

/** Client for live pages (backend routes/pages.ts). Shapes mirror services/pages/pageService.ts. */

export type PageKind = "doc" | "sheet" | "slides";
export type SheetSpec = { name: string; columns: string[]; rows: string[][] };
export type SlideLayout = "title" | "section" | "bullets" | "two_column" | "stats" | "quote" | "table" | "chart";
export type SlideSpec = {
  layout?: SlideLayout;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  left_title?: string;
  left?: string[];
  right_title?: string;
  right?: string[];
  stats?: { value: string; label: string }[];
  quote?: string;
  table?: string[][];
  chart?: { type?: "bar" | "line" | "pie" | "doughnut"; labels?: string[]; series?: { name?: string; values?: (number | string)[] }[] };
  notes?: string;
};
export type DocContent = { markdown: string };
export type SheetContent = { sheets: SheetSpec[] };
export type SlidesContent = { slides: SlideSpec[]; theme_color?: string };
export type PageContent = DocContent | SheetContent | SlidesContent;

export type Page = {
  id: string;
  kind: PageKind;
  title: string;
  content: PageContent;
  version: number;
  share_token: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
};
export type PageSummary = Omit<Page, "content">;
export type PageVersion = { version: number; title: string; author: "user" | "friday"; created_at: string };

export const KIND_LABEL: Record<PageKind, string> = { doc: "Document", sheet: "Spreadsheet", slides: "Slides" };
export const EXPORT_FORMATS: Record<PageKind, { format: string; label: string }[]> = {
  doc: [
    { format: "docx", label: "Word (.docx)" },
    { format: "pdf", label: "PDF" },
    { format: "md", label: "Markdown" },
  ],
  sheet: [
    { format: "xlsx", label: "Excel (.xlsx)" },
    { format: "csv", label: "CSV" },
  ],
  slides: [{ format: "pptx", label: "PowerPoint (.pptx)" }],
};

/** GET /pages/:id/diff — what changed between two versions (backend services/pages/pageEdits.ts#diffContent). */
export type PageDiff = {
  from: { version: number; title: string };
  to: { version: number; title: string };
  titleChanged: boolean;
  diff:
    | { kind: "doc"; lines: Array<{ op: "same" | "add" | "del"; text: string }>; added: number; removed: number }
    | { kind: "sheet"; cells: Array<{ sheet: string; cell: string; before: string; after: string }>; sheetsAdded: string[]; sheetsRemoved: string[] }
    | { kind: "slides"; slides: Array<{ index: number; change: "added" | "removed" | "changed"; title: string }> };
};

export const pagesApi = {
  list: () => api.get<{ pages: PageSummary[] }>("/pages").then((r) => r.pages),
  create: (kind: PageKind, title = "Untitled") => api.post<{ page: Page }>("/pages", { kind, title }).then((r) => r.page),
  get: (id: string) => api.get<{ page: Page }>(`/pages/${id}`).then((r) => r.page),
  save: (id: string, input: { title?: string; content?: PageContent; baseVersion: number }) => api.patch<{ page: Page }>(`/pages/${id}`, input).then((r) => r.page),
  remove: (id: string) => api.delete<void>(`/pages/${id}`),
  versions: (id: string) => api.get<{ versions: PageVersion[] }>(`/pages/${id}/versions`).then((r) => r.versions),
  restore: (id: string, version: number) => api.post<{ page: Page }>(`/pages/${id}/versions/${version}/restore`).then((r) => r.page),
  diff: (id: string, from: number, to?: number) => api.get<PageDiff>(`/pages/${id}/diff?from=${from}${to ? `&to=${to}` : ""}`),
  duplicate: (id: string) => api.post<{ page: Page }>(`/pages/${id}/duplicate`).then((r) => r.page),
  share: (id: string, on: boolean) => api.post<{ page: Page }>(`/pages/${id}/share`, { on }).then((r) => r.page),
  shared: (token: string) => api.get<{ page: Pick<Page, "kind" | "title" | "content" | "updated_at"> }>(`/pages/shared/${encodeURIComponent(token)}`).then((r) => r.page),
};

export async function exportPage(id: string, format: string, title: string): Promise<void> {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE_URL}/pages/${id}/export?format=${format}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "page"}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const shareUrl = (token: string) => `${window.location.origin}/p/${token}`;
