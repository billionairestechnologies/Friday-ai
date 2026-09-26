import { searchWeb } from "../../webSearch.js";
import { htmlToText, safeFetch } from "../safeFetch.js";
import { clip, num, str, type FridayTool } from "./types.js";

const MAX_PAGE_CHARS = 20_000;

export const webSearchTool: FridayTool = {
  spec: {
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs and snippets. Use it for news, prices, recent events, " +
      "facts you are unsure of, or anything after your training cutoff. Follow up with fetch_url to read a result in full.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "integer", description: "Number of results (1-10, default 6)" },
      },
      required: ["query"],
    },
  },
  label: (args) => `Searched the web · "${str(args, "query").slice(0, 80)}"`,
  async run(args, ctx) {
    const query = str(args, "query");
    if (!query) throw new Error("query is required");
    const results = await searchWeb(query, num(args, "limit", 6, 1, 10));
    if (results.length === 0) return "No results found.";
    for (const r of results) ctx.onCite?.(r.url, r.title);
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
  },
};

export const fetchUrlTool: FridayTool = {
  spec: {
    name: "fetch_url",
    description:
      "Fetch a public web page (or JSON/text URL) and return its readable text. Use it to read an article, documentation page " +
      "or search result in full, or a link the user pasted.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL" } },
      required: ["url"],
    },
  },
  label: (args) => {
    const raw = str(args, "url");
    try {
      return `Read ${new URL(raw).hostname}`;
    } catch {
      return "Read a web page";
    }
  },
  async run(args, ctx) {
    const res = await safeFetch(str(args, "url"), { signal: ctx.signal });
    if (res.status >= 400) return `The page returned HTTP ${res.status}.`;
    const type = res.contentType.toLowerCase();
    const raw = res.body.toString("utf8");
    if (type.includes("html") || (!type && /<html|<body/i.test(raw))) {
      const { title, text } = htmlToText(raw);
      ctx.onCite?.(res.url, title || undefined);
      return clip(`URL: ${res.url}\nTitle: ${title || "(none)"}\n\n${text || "(no readable text)"}`, MAX_PAGE_CHARS);
    }
    if (type.includes("json") || type.startsWith("text/") || type.includes("xml") || !type) {
      ctx.onCite?.(res.url);
      return clip(`URL: ${res.url}\n\n${raw}`, MAX_PAGE_CHARS);
    }
    return `URL: ${res.url}\nThis is a ${type} file (${res.body.length} bytes), which can't be read as text.`;
  },
};
