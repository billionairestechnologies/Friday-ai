import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { decryptSecret, encryptSecret } from "../../utils/crypto.js";
import { BlockedUrlError, assertFetchableUrl } from "./safeFetch.js";
import { McpClient, mcpToolName, sanitizeSchema, type McpTool } from "./mcpClient.js";
import { clip, type FridayTool } from "./tools/types.js";

export const MAX_MCP_SERVERS = 10;
const MAX_MCP_TOOLS_PER_TURN = 40;
const LIST_TIMEOUT_MS = 6_000;
const CLIENT_TTL_MS = 10 * 60_000;

export const mcpServerInputSchema = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[\w .-]+$/, "Use letters, numbers, spaces, dots, dashes"),
  url: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "The server URL must start with https://"),
  authorization: z.string().trim().max(2000).optional(),
});

type Row = { id: string; user_id: string; name: string; url: string; auth_header_encrypted: string | null; enabled: boolean; created_at: string };

export type McpServerPublic = { id: string; name: string; url: string; hasAuth: boolean; enabled: boolean; createdAt: string };

function toPublic(row: Row): McpServerPublic {
  return { id: row.id, name: row.name, url: row.url, hasAuth: Boolean(row.auth_header_encrypted), enabled: row.enabled, createdAt: row.created_at };
}

/** "Bearer x" stays as-is; a bare token becomes "Bearer <token>". */
function authorizationHeader(raw?: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return /^(bearer|basic|token)\s/i.test(value) ? value : `Bearer ${value}`;
}

// One live client (with its MCP session) per server, reused across turns for a few minutes.
const clients = new Map<string, { client: McpClient; tools: McpTool[] | null; at: number }>();

function clientFor(row: Row) {
  const cached = clients.get(row.id);
  if (cached && Date.now() - cached.at < CLIENT_TTL_MS) return cached;
  const entry = {
    client: new McpClient({ url: row.url, authorization: row.auth_header_encrypted ? decryptSecret(row.auth_header_encrypted) : null }),
    tools: null as McpTool[] | null,
    at: Date.now(),
  };
  clients.set(row.id, entry);
  return entry;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error("MCP server timed out")), ms)))]).finally(() => clearTimeout(t));
}

export async function listMcpServers(userId: string): Promise<McpServerPublic[]> {
  const { data, error } = await supabaseAdmin.from("mcp_servers").select("*").eq("user_id", userId).order("created_at");
  if (error) throw new HttpError(500, error.message);
  return ((data ?? []) as Row[]).map(toPublic);
}

async function getOwned(userId: string, id: string): Promise<Row> {
  const { data } = await supabaseAdmin.from("mcp_servers").select("*").eq("user_id", userId).eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "MCP server not found");
  return data as Row;
}

/** Adds a server after checking it actually answers tools/list (so a typo fails now, not mid-chat). */
export async function addMcpServer(userId: string, input: z.infer<typeof mcpServerInputSchema>): Promise<{ server: McpServerPublic; tools: string[] }> {
  try {
    assertFetchableUrl(input.url);
  } catch (err) {
    throw new HttpError(400, err instanceof BlockedUrlError ? err.message : "Invalid URL");
  }
  const { count } = await supabaseAdmin.from("mcp_servers").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if ((count ?? 0) >= MAX_MCP_SERVERS) throw new HttpError(400, `You can add up to ${MAX_MCP_SERVERS} MCP servers`);
  const authorization = authorizationHeader(input.authorization);
  let tools: McpTool[];
  try {
    tools = await withTimeout(new McpClient({ url: input.url, authorization }).listTools(), 15_000);
  } catch (err) {
    throw new HttpError(400, `Couldn't reach that MCP server: ${err instanceof Error ? err.message : "failed"}`);
  }
  const { data, error } = await supabaseAdmin
    .from("mcp_servers")
    .insert({ user_id: userId, name: input.name, url: input.url, auth_header_encrypted: authorization ? encryptSecret(authorization) : null })
    .select("*")
    .single();
  if (error || !data) throw new HttpError(error?.code === "23505" ? 409 : 500, error?.code === "23505" ? "You already have a server with that name" : (error?.message ?? "Failed to save"));
  return { server: toPublic(data as Row), tools: tools.map((t) => t.name) };
}

export async function setMcpServerEnabled(userId: string, id: string, enabled: boolean): Promise<McpServerPublic> {
  await getOwned(userId, id);
  const { data, error } = await supabaseAdmin.from("mcp_servers").update({ enabled }).eq("id", id).eq("user_id", userId).select("*").single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to update");
  clients.delete(id);
  return toPublic(data as Row);
}

export async function deleteMcpServer(userId: string, id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("mcp_servers").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
  clients.delete(id);
}

export async function listServerTools(userId: string, id: string): Promise<McpTool[]> {
  const row = await getOwned(userId, id);
  const entry = clientFor(row);
  entry.tools = await withTimeout(entry.client.listTools(), 15_000);
  return entry.tools;
}

/** The user's enabled MCP servers' tools as Friday tools. A slow or broken server is skipped, never fatal. */
export async function loadMcpTools(userId: string): Promise<FridayTool[]> {
  const { data } = await supabaseAdmin.from("mcp_servers").select("*").eq("user_id", userId).eq("enabled", true);
  const rows = (data ?? []) as Row[];
  const perServer = await Promise.all(
    rows.map(async (row) => {
      const entry = clientFor(row);
      try {
        if (!entry.tools) entry.tools = await withTimeout(entry.client.listTools(), LIST_TIMEOUT_MS);
      } catch (err) {
        clients.delete(row.id);
        console.warn(`[mcp] ${row.name}: ${err instanceof Error ? err.message : err}`);
        return [];
      }
      return entry.tools.map(
        (tool): FridayTool => ({
          spec: {
            name: mcpToolName(row.name, tool.name),
            description: `[${row.name} via MCP] ${(tool.description ?? tool.name).slice(0, 900)}`,
            parameters: sanitizeSchema(tool.inputSchema) as FridayTool["spec"]["parameters"],
          },
          label: () => `${row.name} · ${tool.name}`,
          async run(args, ctx) {
            const result = await clientFor(row).client.callTool(tool.name, args, ctx.signal);
            if (result.isError) throw new Error(clip(result.text, 1000));
            return result.text;
          },
        }),
      );
    }),
  );
  return perServer.flat().slice(0, MAX_MCP_TOOLS_PER_TURN);
}
