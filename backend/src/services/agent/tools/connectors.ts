import { loadTokenCredentials } from "../../connectorService.js";
import type { TokenConnectorId } from "../../tokenConnectors.js";
import { safeFetch } from "../safeFetch.js";
import { clip, num, str, type FridayTool, type ToolContext } from "./types.js";

/** Read-only tools for the token-based connectors (Notion, Vercel, Railway, Supabase, Razorpay). */

async function creds(ctx: ToolContext, provider: TokenConnectorId) {
  try {
    return await loadTokenCredentials(ctx.userId, provider);
  } catch {
    throw new Error(`${provider} is not connected — ask the user to connect it from Plugins.`);
  }
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${what} API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// ---- Notion ------------------------------------------------------------------------------------

type NotionRichText = { plain_text?: string }[];
type NotionPage = { id: string; url?: string; object?: string; properties?: Record<string, { type?: string; title?: NotionRichText }>; title?: NotionRichText };

function notionTitle(page: NotionPage): string {
  if (page.title?.length) return page.title.map((t) => t.plain_text ?? "").join("");
  const prop = Object.values(page.properties ?? {}).find((p) => p.type === "title");
  return prop?.title?.map((t) => t.plain_text ?? "").join("") || "(untitled)";
}

const NOTION_HEADERS = (token: string) => ({ Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" });

export const notionSearchTool: FridayTool = {
  spec: {
    name: "notion_search",
    description: "Search the user's Notion pages and databases shared with the integration. Returns ids, titles and links.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Words to search for" } }, required: ["query"] },
  },
  label: (args) => `Searched Notion · "${str(args, "query").slice(0, 60)}"`,
  async run(args, ctx) {
    const { token } = await creds(ctx, "notion");
    const body = await json(
      await fetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: NOTION_HEADERS(token),
        body: JSON.stringify({ query: str(args, "query"), page_size: 15 }),
        signal: ctx.signal,
      }),
      "Notion",
    );
    const results = (body.results as NotionPage[] | undefined) ?? [];
    if (!results.length) return "No matching pages.";
    return results.map((p) => `${p.object ?? "page"} id=${p.id} · ${notionTitle(p)}${p.url ? ` · ${p.url}` : ""}`).join("\n");
  },
};

type NotionBlock = { type: string; has_children?: boolean } & Record<string, { rich_text?: NotionRichText; checked?: boolean } | unknown>;

function blockText(block: NotionBlock): string {
  const data = block[block.type] as { rich_text?: NotionRichText; checked?: boolean } | undefined;
  const text = data?.rich_text?.map((t) => t.plain_text ?? "").join("") ?? "";
  switch (block.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${data?.checked ? "x" : " "}] ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    case "quote":
      return `> ${text}`;
    default:
      return text;
  }
}

export const notionReadPageTool: FridayTool = {
  spec: {
    name: "notion_read_page",
    description: "Read the text content of a Notion page by id (from notion_search).",
    parameters: { type: "object", properties: { page_id: { type: "string", description: "Notion page id" } }, required: ["page_id"] },
  },
  label: () => "Read a Notion page",
  async run(args, ctx) {
    const id = str(args, "page_id").replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/i.test(id)) throw new Error("page_id must be a Notion page id");
    const { token } = await creds(ctx, "notion");
    const lines: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const body = await json(
        await fetch(`https://api.notion.com/v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`, {
          headers: NOTION_HEADERS(token),
          signal: ctx.signal,
        }),
        "Notion",
      );
      for (const block of (body.results as NotionBlock[] | undefined) ?? []) lines.push(blockText(block));
      if (!body.has_more) break;
      cursor = body.next_cursor as string;
    }
    return clip(lines.filter((l) => l.trim()).join("\n") || "(empty page)", 25_000);
  },
};

// ---- Vercel ------------------------------------------------------------------------------------

export const vercelDeploymentsTool: FridayTool = {
  spec: {
    name: "vercel_deployments",
    description: "List the user's recent Vercel deployments (state, project, URL, commit message), optionally for one project.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Optional project name or id" },
        limit: { type: "integer", description: "1-20, default 10" },
      },
    },
  },
  label: () => "Checked Vercel deployments",
  async run(args, ctx) {
    const { token } = await creds(ctx, "vercel");
    const project = str(args, "project");
    const body = await json(
      await fetch(`https://api.vercel.com/v6/deployments?limit=${num(args, "limit", 10, 1, 20)}${project ? `&projectId=${encodeURIComponent(project)}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctx.signal,
      }),
      "Vercel",
    );
    const deployments = (body.deployments as { name: string; url?: string; state?: string; readyState?: string; created: number; target?: string; meta?: { githubCommitMessage?: string } }[] | undefined) ?? [];
    if (!deployments.length) return "No deployments.";
    return deployments
      .map((d) => `${new Date(d.created).toISOString()} · ${d.name} · ${d.state ?? d.readyState ?? "?"}${d.target ? ` (${d.target})` : ""}${d.url ? ` · https://${d.url}` : ""}${d.meta?.githubCommitMessage ? ` · "${d.meta.githubCommitMessage.slice(0, 80)}"` : ""}`)
      .join("\n");
  },
};

// ---- Railway -----------------------------------------------------------------------------------

export const railwayProjectsTool: FridayTool = {
  spec: {
    name: "railway_projects",
    description: "List the user's Railway projects with their services and environments.",
    parameters: { type: "object", properties: {} },
  },
  label: () => "Checked Railway projects",
  async run(_args, ctx) {
    const { token } = await creds(ctx, "railway");
    const body = await json(
      await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query:
            "query { me { projects { edges { node { id name updatedAt services { edges { node { name } } } environments { edges { node { name } } } } } } } }",
        }),
        signal: ctx.signal,
      }),
      "Railway",
    );
    type Edge<T> = { edges?: { node?: T }[] };
    const projects =
      (body.data as { me?: { projects?: Edge<{ id: string; name: string; updatedAt?: string; services?: Edge<{ name: string }>; environments?: Edge<{ name: string }> }> } } | undefined)?.me
        ?.projects?.edges ?? [];
    if (!projects.length) return "No projects.";
    return projects
      .map(({ node: p }) => {
        if (!p) return "";
        const services = p.services?.edges?.map((e) => e.node?.name).filter(Boolean).join(", ") || "none";
        const envs = p.environments?.edges?.map((e) => e.node?.name).filter(Boolean).join(", ") || "none";
        return `${p.name} (id ${p.id}) · services: ${services} · environments: ${envs}${p.updatedAt ? ` · updated ${p.updatedAt.slice(0, 10)}` : ""}`;
      })
      .filter(Boolean)
      .join("\n");
  },
};

// ---- Supabase ----------------------------------------------------------------------------------

export const supabaseQueryTool: FridayTool = {
  spec: {
    name: "supabase_query",
    description:
      "Read rows from a table in the user's connected Supabase project (PostgREST, read-only). Call with no table to list tables. " +
      'Filters use PostgREST query syntax joined with &, e.g. "status=eq.active&created_at=gte.2026-01-01".',
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (omit to list tables)" },
        select: { type: "string", description: "Columns, default *" },
        filters: { type: "string", description: "PostgREST filters, e.g. status=eq.active&age=gt.18" },
        order: { type: "string", description: "e.g. created_at.desc" },
        limit: { type: "integer", description: "1-100, default 20" },
      },
    },
  },
  label: (args) => (str(args, "table") ? `Queried Supabase · ${str(args, "table")}` : "Listed Supabase tables"),
  async run(args, ctx) {
    const { token, url } = await creds(ctx, "supabase");
    if (!url) throw new Error("The Supabase connector has no project URL — reconnect it.");
    const headers = { apikey: token, Authorization: `Bearer ${token}` };
    const table = str(args, "table");
    if (!table) {
      const res = await safeFetch(`${url}/rest/v1/`, { headers: { ...headers, Accept: "application/openapi+json" }, signal: ctx.signal });
      const spec = JSON.parse(res.body.toString("utf8") || "{}") as { paths?: Record<string, unknown> };
      const tables = Object.keys(spec.paths ?? {}).filter((p) => p !== "/" && !p.startsWith("/rpc/")).map((p) => p.slice(1));
      return tables.length ? `Tables: ${tables.join(", ")}` : "No tables are exposed to this key.";
    }
    if (!/^[\w.]+$/.test(table)) throw new Error("invalid table name");
    const params = new URLSearchParams({ select: str(args, "select") || "*", limit: String(num(args, "limit", 20, 1, 100)) });
    const order = str(args, "order");
    if (order) params.set("order", order);
    for (const [col, filter] of new URLSearchParams(str(args, "filters"))) {
      if (/^[\w.]+$/.test(col) && !["select", "limit", "order", "offset"].includes(col)) params.append(col, filter);
    }
    const res = await safeFetch(`${url}/rest/v1/${table}?${params.toString()}`, { headers, signal: ctx.signal });
    const text = res.body.toString("utf8");
    if (res.status >= 400) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
    return clip(text, 20_000);
  },
};

// ---- Razorpay ----------------------------------------------------------------------------------

export const razorpayPaymentsTool: FridayTool = {
  spec: {
    name: "razorpay_payments",
    description: "List recent payments from the user's own Razorpay account (amount, status, method, email, time).",
    parameters: {
      type: "object",
      properties: {
        count: { type: "integer", description: "1-50, default 20" },
        from: { type: "string", description: "Optional start date, ISO 8601" },
      },
    },
  },
  label: () => "Checked Razorpay payments",
  async run(args, ctx) {
    const { token: keyId, secret } = await creds(ctx, "razorpay");
    const from = str(args, "from") ? Math.floor(new Date(str(args, "from")).getTime() / 1000) : NaN;
    const body = await json(
      await fetch(`https://api.razorpay.com/v1/payments?count=${num(args, "count", 20, 1, 50)}${Number.isFinite(from) ? `&from=${from}` : ""}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${secret ?? ""}`).toString("base64")}` },
        signal: ctx.signal,
      }),
      "Razorpay",
    );
    const items = (body.items as { id: string; amount: number; currency: string; status: string; method?: string; email?: string; created_at: number }[] | undefined) ?? [];
    if (!items.length) return "No payments.";
    return items
      .map((p) => `${new Date(p.created_at * 1000).toISOString()} · ${p.id} · ${(p.amount / 100).toFixed(2)} ${p.currency} · ${p.status}${p.method ? ` · ${p.method}` : ""}${p.email ? ` · ${p.email}` : ""}`)
      .join("\n");
  },
};

export const TOKEN_CONNECTOR_TOOLS: Partial<Record<TokenConnectorId, FridayTool[]>> = {
  notion: [notionSearchTool, notionReadPageTool],
  vercel: [vercelDeploymentsTool],
  railway: [railwayProjectsTool],
  supabase: [supabaseQueryTool],
  razorpay: [razorpayPaymentsTool],
};
