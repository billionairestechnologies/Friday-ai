import assert from "node:assert/strict";
import test from "node:test";
import "./setup.js";
import { handleMcpRequest } from "../src/services/cli/mcpServer.js";

test("FridayX MCP: initialize advertises tools and notifications get no reply", async () => {
  const init = await handleMcpRequest("u1", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal((init?.result as { serverInfo: { name: string } }).serverInfo.name, "Friday");
  assert.equal(await handleMcpRequest("u1", { jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("FridayX MCP: a tool that is not connected is refused, unknown methods are protocol errors", async () => {
  const call = await handleMcpRequest("u1", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gmail_search", arguments: {} } });
  assert.equal(call?.error?.code, -32602);
  const nope = await handleMcpRequest("u1", { jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.equal(nope?.error?.code, -32601);
});
