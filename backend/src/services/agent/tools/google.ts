import { getGoogleAccessToken, refreshGoogleAccessToken } from "../../connectorService.js";
import { htmlToText } from "../safeFetch.js";
import { clip, num, str, type FridayTool, type ToolContext } from "./types.js";

/** GET a Google API as the user; refreshes the access token once on a 401 (they expire after ~1h). */
async function google(ctx: ToolContext, url: string, asText = false): Promise<unknown> {
  const account = await getGoogleAccessToken(ctx.userId);
  if (!account) throw new Error("Google is not connected — ask the user to connect it from Plugins.");
  const call = (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal });
  let res = await call(account.token);
  if (res.status === 401) {
    const fresh = await refreshGoogleAccessToken(ctx.userId);
    if (!fresh) throw new Error("The Google connection expired — ask the user to reconnect Google from Plugins.");
    res = await call(fresh);
  }
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return asText ? res.text() : res.json();
}

type GmailHeader = { name: string; value: string };
type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: GmailHeader[] };

function header(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Plain text of a Gmail message: text/plain part if there is one, else the HTML part as text. */
export function gmailBodyText(part: GmailPart): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: GmailPart) => {
    if (p.mimeType === "text/plain" && p.body?.data) plain.push(decodeB64Url(p.body.data));
    else if (p.mimeType === "text/html" && p.body?.data) html.push(decodeB64Url(p.body.data));
    p.parts?.forEach(walk);
  };
  walk(part);
  if (plain.length) return plain.join("\n\n");
  return html.map((h) => htmlToText(h).text).join("\n\n");
}

export const gmailSearchTool: FridayTool = {
  spec: {
    name: "gmail_search",
    description:
      "Search the user's Gmail (read-only) with Gmail search syntax, e.g. \"from:bank newer_than:7d\" or \"is:unread\". " +
      "Returns id, date, sender, subject and snippet for each message; use gmail_read for the full text.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query (empty = latest messages)" },
        limit: { type: "integer", description: "1-20, default 10" },
      },
    },
  },
  label: (args) => (str(args, "query") ? `Searched Gmail · "${str(args, "query").slice(0, 60)}"` : "Checked Gmail"),
  async run(args, ctx) {
    const q = str(args, "query");
    const list = (await google(
      ctx,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${num(args, "limit", 10, 1, 20)}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    )) as { messages?: { id: string }[] };
    if (!list.messages?.length) return "No messages found.";
    const rows = await Promise.all(
      list.messages.map(async ({ id }) => {
        const m = (await google(
          ctx,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        )) as { snippet?: string; payload?: GmailPart; labelIds?: string[] };
        const h = m.payload?.headers;
        const unread = m.labelIds?.includes("UNREAD") ? " [unread]" : "";
        return `id=${id}${unread}\n  ${header(h, "Date")} · ${header(h, "From")}\n  Subject: ${header(h, "Subject")}\n  ${m.snippet ?? ""}`;
      }),
    );
    return rows.join("\n");
  },
};

export const gmailReadTool: FridayTool = {
  spec: {
    name: "gmail_read",
    description: "Read the full text of one Gmail message by id (from gmail_search).",
    parameters: { type: "object", properties: { id: { type: "string", description: "Message id" } }, required: ["id"] },
  },
  label: () => "Read an email",
  async run(args, ctx) {
    const id = str(args, "id");
    if (!/^[\w-]+$/.test(id)) throw new Error("invalid message id");
    const m = (await google(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`)) as { payload?: GmailPart };
    const h = m.payload?.headers;
    const body = m.payload ? gmailBodyText(m.payload) : "";
    return clip(
      `From: ${header(h, "From")}\nTo: ${header(h, "To")}\nDate: ${header(h, "Date")}\nSubject: ${header(h, "Subject")}\n\n${body || "(no text body)"}`,
      20_000,
    );
  },
};

export const driveSearchTool: FridayTool = {
  spec: {
    name: "drive_search",
    description: "Search the user's Google Drive files (read-only) by name and content. Returns id, name, type and link.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for" },
        limit: { type: "integer", description: "1-25, default 10" },
      },
      required: ["query"],
    },
  },
  label: (args) => `Searched Drive · "${str(args, "query").slice(0, 60)}"`,
  async run(args, ctx) {
    const words = str(args, "query").replace(/['\\]/g, " ");
    const q = `(name contains '${words}' or fullText contains '${words}') and trashed = false`;
    const data = (await google(
      ctx,
      `https://www.googleapis.com/drive/v3/files?pageSize=${num(args, "limit", 10, 1, 25)}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${encodeURIComponent(q)}`,
    )) as { files?: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[] };
    if (!data.files?.length) return "No files found.";
    return data.files.map((f) => `id=${f.id} · ${f.name} · ${f.mimeType} · modified ${f.modifiedTime.slice(0, 10)}${f.webViewLink ? ` · ${f.webViewLink}` : ""}`).join("\n");
  },
};

const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export const driveReadTool: FridayTool = {
  spec: {
    name: "drive_read",
    description: "Read the text of a Google Drive file by id (Docs, Sheets as CSV, Slides, and plain-text files).",
    parameters: { type: "object", properties: { id: { type: "string", description: "File id from drive_search" } }, required: ["id"] },
  },
  label: () => "Read a Drive file",
  async run(args, ctx) {
    const id = str(args, "id");
    if (!/^[\w-]+$/.test(id)) throw new Error("invalid file id");
    const meta = (await google(ctx, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size,webViewLink`)) as {
      name: string;
      mimeType: string;
      size?: string;
      webViewLink?: string;
    };
    if (meta.webViewLink) ctx.onCite?.(meta.webViewLink, meta.name);
    const exportAs = EXPORTS[meta.mimeType];
    let text: string;
    if (exportAs) {
      text = (await google(ctx, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`, true)) as string;
    } else if (/^text\/|json|xml|csv|markdown/.test(meta.mimeType)) {
      text = (await google(ctx, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`, true)) as string;
    } else {
      return `${meta.name} is a ${meta.mimeType} file${meta.size ? ` (${meta.size} bytes)` : ""}; its content can't be read as text here.`;
    }
    return clip(`${meta.name}\n\n${text}`, 30_000);
  },
};

export const calendarEventsTool: FridayTool = {
  spec: {
    name: "calendar_events",
    description:
      "List events from the user's primary Google Calendar (read-only). Defaults to the next 7 days. Times are ISO 8601.",
    parameters: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "Start of range, ISO 8601 (default now)" },
        time_max: { type: "string", description: "End of range, ISO 8601 (default now + 7 days)" },
        query: { type: "string", description: "Optional text to match in events" },
      },
    },
  },
  label: () => "Checked Calendar",
  async run(args, ctx) {
    const parse = (v: string, fallback: Date) => {
      const d = v ? new Date(v) : fallback;
      return Number.isNaN(d.getTime()) ? fallback : d;
    };
    const now = new Date();
    const min = parse(str(args, "time_min"), now);
    const max = parse(str(args, "time_max"), new Date(min.getTime() + 7 * 86_400_000));
    const q = str(args, "query");
    const data = (await google(
      ctx,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50` +
        `&timeMin=${encodeURIComponent(min.toISOString())}&timeMax=${encodeURIComponent(max.toISOString())}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    )) as {
      timeZone?: string;
      items?: { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string; attendees?: { email: string }[] }[];
    };
    if (!data.items?.length) return `No events between ${min.toISOString()} and ${max.toISOString()}.`;
    return (
      `Calendar time zone: ${data.timeZone ?? "unknown"}\n` +
      data.items
        .map((e) => {
          const start = e.start?.dateTime ?? e.start?.date ?? "?";
          const end = e.end?.dateTime ?? e.end?.date ?? "";
          const who = e.attendees?.length ? ` · with ${e.attendees.map((a) => a.email).slice(0, 5).join(", ")}` : "";
          return `${start} → ${end} · ${e.summary ?? "(no title)"}${e.location ? ` · ${e.location}` : ""}${who}`;
        })
        .join("\n")
    );
  },
};

/** Tools gated by the OAuth scopes the user actually granted. */
export function googleToolsForScopes(scopes: string[]): FridayTool[] {
  const has = (s: string) => scopes.length === 0 || scopes.some((granted) => granted.includes(s));
  return [
    ...(has("gmail") ? [gmailSearchTool, gmailReadTool] : []),
    ...(has("drive") ? [driveSearchTool, driveReadTool] : []),
    ...(has("calendar") ? [calendarEventsTool] : []),
  ];
}
