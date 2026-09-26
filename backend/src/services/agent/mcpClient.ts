import { safeFetch, type SafeFetchOptions, type SafeResponse } from "./safeFetch.js";

/**
 * Minimal Model Context Protocol client over Streamable HTTP (JSON-RPC 2.0 POSTs; the response is
 * either JSON or an SSE stream carrying the JSON-RPC reply). Enough for tools: initialize,
 * tools/list, tools/call. Every request goes through the SSRF-guarded fetcher — the server URL is
 * user-supplied.
 */

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 30_000;

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type McpServerConfig = { url: string; authorization?: string | null };

type JsonRpcResponse = { jsonrpc: "2.0"; id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** Pulls the JSON-RPC response with `id` out of a JSON or SSE body. */
export function parseRpcBody(body: string, contentType: string, id: number): JsonRpcResponse | null {
  const candidates: string[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) candidates.push(data);
    }
  } else if (body.trim()) {
    candidates.push(body);
  }
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as JsonRpcResponse | JsonRpcResponse[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const match = list.find((m) => m && m.id === id && ("result" in m || "error" in m));
      if (match) return match;
    } catch {
      /* partial or non-JSON event */
    }
  }
  return null;
}

export class McpClient {
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly config: McpServerConfig,
    /** Injectable for tests; production always uses the SSRF-guarded fetcher. */
    private readonly fetcher: (url: string, opts: SafeFetchOptions) => Promise<SafeResponse> = safeFetch,
  ) {}

  private async post(payload: Record<string, unknown>, expectId: number | null, signal?: AbortSignal): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.config.authorization) headers.Authorization = this.config.authorization;
    const res = await this.fetcher(this.config.url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
      headers,
      timeoutMs: TIMEOUT_MS,
      signal,
      stopWhen: expectId === null ? undefined : (soFar) => parseRpcBody(soFar, "text/event-stream", expectId) !== null,
    });
    const session = res.headers["mcp-session-id"];
    if (session) this.sessionId = session;
    if (res.status === 404 && this.sessionId) {
      // Session expired on the server — start over once.
      this.sessionId = null;
      this.initialized = false;
      throw new Error("MCP session expired");
    }
    if (res.status >= 400) throw new Error(`MCP server returned HTTP ${res.status}: ${res.body.toString("utf8").slice(0, 200)}`);
    if (expectId === null) return null;
    const reply = parseRpcBody(res.body.toString("utf8"), res.contentType, expectId);
    if (!reply) throw new Error("MCP server sent no response");
    if (reply.error) throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`);
    return reply;
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.initialized && method !== "initialize") await this.initialize(signal);
    const id = this.nextId++;
    try {
      return (await this.post({ id, method, params }, id, signal))?.result ?? {};
    } catch (err) {
      if (err instanceof Error && err.message === "MCP session expired") {
        await this.initialize(signal);
        const retry = this.nextId++;
        return (await this.post({ id: retry, method, params }, retry, signal))?.result ?? {};
      }
      throw err;
    }
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    const id = this.nextId++;
    await this.post(
      {
        id,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Friday AI", version: "1.0.0" } },
      },
      id,
      signal,
    );
    this.initialized = true;
    await this.post({ method: "notifications/initialized" }, null, signal).catch(() => {});
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, signal);
      tools.push(...((result.tools as McpTool[] | undefined) ?? []));
      cursor = result.nextCursor as string | undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const result = await this.request("tools/call", { name, arguments: args }, signal);
    const content = (result.content as { type: string; text?: string; resource?: { text?: string; uri?: string } }[] | undefined) ?? [];
    const text = content
      .map((c) => (c.type === "text" ? (c.text ?? "") : c.type === "resource" ? (c.resource?.text ?? c.resource?.uri ?? "") : `[${c.type} content]`))
      .filter(Boolean)
      .join("\n");
    const structured = result.structuredContent ? JSON.stringify(result.structuredContent) : "";
    return { text: text || structured || "(no output)", isError: Boolean(result.isError) };
  }
}

const DROP_KEYS = new Set(["$schema", "$id", "$ref", "$defs", "definitions", "additionalProperties", "default", "examples", "format", "pattern", "const", "title", "oneOf", "anyOf", "allOf", "not"]);

/** Reduces an arbitrary JSON Schema to the subset every provider (incl. Gemini) accepts. */
export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue;
      if (k === "type" && Array.isArray(v)) {
        out.type = v.find((t) => t !== "null") ?? "string"; // ["string","null"] → "string"
        continue;
      }
      out[k] = k === "properties" && v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, walk(pv)]))
        : walk(v);
    }
    return out;
  };
  const cleaned = walk(schema ?? {}) as Record<string, unknown>;
  return {
    type: "object",
    properties: (cleaned.properties as Record<string, unknown> | undefined) ?? {},
    ...(Array.isArray(cleaned.required) && cleaned.required.length ? { required: cleaned.required } : {}),
  };
}

/** Provider-safe tool name: [a-zA-Z0-9_-], ≤64 chars. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (t: string) => t.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp_${clean(server).slice(0, 16)}_${clean(tool)}`.slice(0, 64);
}
