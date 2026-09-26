import assert from "node:assert/strict";
import test from "node:test";
import { mcpToolName, parseRpcBody, sanitizeSchema } from "../src/services/agent/mcpClient.js";

test("parseRpcBody reads JSON and SSE responses and picks the matching id", () => {
  assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}', "application/json", 3)?.result, { ok: true });
  const sse =
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[{"name":"x"}]}}\n\n';
  assert.deepEqual(parseRpcBody(sse, "text/event-stream", 7)?.result, { tools: [{ name: "x" }] });
  assert.equal(parseRpcBody(sse, "text/event-stream", 8), null);
  assert.equal(parseRpcBody('data: {"jsonrpc":"2.0","id":1,"res', "text/event-stream", 1), null, "partial stream");
  assert.equal(parseRpcBody('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}', "application/json", 2)?.error?.message, "nope");
});

test("sanitizeSchema keeps a provider-safe subset", () => {
  const schema = sanitizeSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      q: { type: "string", description: "query", format: "uri", default: "x" },
      n: { type: ["integer", "null"] },
      tags: { type: "array", items: { type: "string", pattern: "^a" } },
      nested: { type: "object", additionalProperties: true, properties: { a: { type: "boolean" } } },
    },
    required: ["q"],
  });
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      q: { type: "string", description: "query" },
      n: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { a: { type: "boolean" } } },
    },
    required: ["q"],
  });
  assert.deepEqual(sanitizeSchema(undefined), { type: "object", properties: {} });
});

test("mcpToolName is provider-safe and bounded", () => {
  assert.equal(mcpToolName("My Linear", "create.issue"), "mcp_My_Linear_create_issue");
  assert.ok(mcpToolName("x".repeat(50), "y".repeat(80)).length <= 64);
  assert.match(mcpToolName("a b", "c/d"), /^[a-zA-Z0-9_-]+$/);
});

test("McpClient: initialize → session → tools/list (SSE) → tools/call, and re-initializes on session expiry", async () => {
  const http = await import("node:http");
  const { McpClient } = await import("../src/services/agent/mcpClient.js");
  const seen: string[] = [];
  let sessions = 0;
  let expireNext = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const msg = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: { a: number; b: number } } };
      seen.push(`${msg.method}${req.headers["mcp-session-id"] ? "@" + req.headers["mcp-session-id"] : ""}`);
      if (msg.method === "initialize") {
        sessions++;
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": `s${sessions}` });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }));
      }
      if (!msg.id) return res.writeHead(202).end();
      if (expireNext) {
        expireNext = false;
        return res.writeHead(404).end();
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (msg.method === "tools/list") {
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "add", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }] } })}\n\n`);
        return; // stream deliberately left open — the client must stop once it has its reply
      }
      const { a, b } = msg.params!.arguments!;
      const isError = msg.params!.name !== "add";
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: isError ? "unknown tool" : String(a + b) }], isError } })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  // Plain HTTP fetcher for the test (production uses the SSRF-guarded one, which blocks 127.0.0.1).
  const fetcher = async (url: string, opts: { body?: string; headers?: Record<string, string>; stopWhen?: (s: string) => boolean }) => {
    const controller = new AbortController();
    const res = await fetch(url, { method: "POST", body: opts.body, headers: opts.headers, signal: controller.signal });
    let text = "";
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (opts.stopWhen?.(text)) {
        controller.abort();
        break;
      }
    }
    return {
      url,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: Buffer.from(text),
      truncated: false,
      headers: Object.fromEntries(res.headers.entries()),
    };
  };
  try {
    const client = new McpClient({ url: `http://127.0.0.1:${port}/mcp` }, fetcher as never);
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["add"]);
    assert.deepEqual(await client.callTool("add", { a: 2, b: 3 }), { text: "5", isError: false });
    assert.equal((await client.callTool("nope", { a: 0, b: 0 })).isError, true);
    expireNext = true;
    assert.deepEqual(await client.callTool("add", { a: 1, b: 1 }), { text: "2", isError: false });
    assert.deepEqual(seen.slice(0, 3), ["initialize", "notifications/initialized@s1", "tools/list@s1"]);
    assert.ok(seen.includes("tools/call@s2"), "re-initialized with a fresh session after 404");
  } finally {
    server.close();
  }
});
