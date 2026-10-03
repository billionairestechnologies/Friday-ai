import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DEFAULT_ENTITLEMENTS, ENTITLEMENT_DEFS, mergeEntitlements, sanitizeEntitlements } from "../src/services/quota/planCatalog.js";
import { generateCliToken, generateUserCode, hashSecret, looksLikeCliToken, normalizeUserCode } from "../src/services/cli/deviceAuth.js";
import {
  completionBody,
  decodeCallId,
  encodeCallId,
  modelRef,
  parseModelRef,
  promptChars,
  toAgentMessages,
  toToolSpecs,
  toolCallsChunk,
} from "../src/services/cli/openaiCompat.js";
import { cliSettings, contextWindowFor } from "../src/services/cli/gateway.js";
import { installCmd, installPowerShell, installShell, isPlatform, isVersion } from "../src/services/cli/installScripts.js";

test("Friday X is an admin-editable entitlement, on by default for every plan", () => {
  assert.ok(ENTITLEMENT_DEFS.some((d) => d.key === "fridayX" && d.type === "boolean"));
  for (const plan of ["free", "pro", "premium", "enterprise"] as const) assert.equal(DEFAULT_ENTITLEMENTS[plan].fridayX, true);
  // An admin turning it off for Free, and a personal grant turning it back on for one user, layer as for any entitlement.
  const free = mergeEntitlements(DEFAULT_ENTITLEMENTS.free, { fridayX: false });
  assert.equal(free.fridayX, false);
  assert.equal(mergeEntitlements(free, null, { fridayX: true }).fridayX, true);
  assert.deepEqual(sanitizeEntitlements({ fridayX: "yes" }), {});
});

test("user codes are unambiguous, 8 chars, and typed codes normalise", () => {
  for (let i = 0; i < 200; i++) assert.match(generateUserCode(), /^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
  assert.equal(normalizeUserCode(" abcd efgh "), "ABCD-EFGH");
  assert.equal(normalizeUserCode("abcd-efg"), null);
  assert.equal(normalizeUserCode("ABCD-EFGH-J"), null);
});

test("CLI tokens are prefixed, high-entropy and only their hash is stored", () => {
  const a = generateCliToken();
  const b = generateCliToken();
  assert.ok(looksLikeCliToken(a));
  assert.notEqual(a, b);
  assert.ok(!looksLikeCliToken("eyJhbGciOi.supabase.jwt"));
  assert.equal(hashSecret(a).length, 64);
  assert.notEqual(hashSecret(a), a);
});

test("tool call ids carry Gemini's thought signature through the client and back", () => {
  const id = encodeCallId({ id: "call_1", signature: "sig/+=value" });
  assert.deepEqual(decodeCallId(id), { id: "call_1", signature: "sig/+=value" });
  assert.deepEqual(decodeCallId("call_plain"), { id: "call_plain" });
  // A dot that isn't followed by a signature must not eat part of a real id.
  assert.equal(decodeCallId("toolu_01.").id, "toolu_01.");
  assert.equal(encodeCallId({ id: "call_2" }), "call_2");
});

test("OpenAI messages translate to agent messages, tools and images included", () => {
  const messages = toAgentMessages([
    { role: "system", content: "be brief" },
    { role: "developer", content: "repo rules" },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    { role: "assistant", content: "", tool_calls: [{ id: encodeCallId({ id: "c1", signature: "S" }), type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
    { role: "tool", tool_call_id: encodeCallId({ id: "c1", signature: "S" }), content: "file body" },
  ]);
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[0], { role: "system", content: "be brief" });
  const user = messages[2] as { content: string; images: Array<{ mime: string }> };
  assert.equal(user.content, "look");
  assert.equal(user.images[0]!.mime, "image/png");
  const assistant = messages[3] as { toolCalls: Array<{ id: string; name: string; args: unknown; signature?: string }> };
  assert.deepEqual(assistant.toolCalls[0], { id: "c1", name: "read_file", args: { path: "a.ts" }, signature: "S" });
  assert.deepEqual(messages[4], { role: "tool", toolCallId: "c1", name: "read_file", content: "file body" });
});

test("malformed tool arguments degrade to {} instead of failing the turn", () => {
  const [m] = toAgentMessages([{ role: "assistant", content: "", tool_calls: [{ id: "c", function: { name: "t", arguments: "{not json" } }] }]);
  assert.deepEqual((m as { toolCalls: Array<{ args: unknown }> }).toolCalls[0]!.args, {});
});

test("tool specs keep the portable JSON-Schema subset and drop nameless tools", () => {
  const specs = toToolSpecs([
    { type: "function", function: { name: "grep", description: "search", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false } } },
    { type: "function", function: { description: "no name" } },
    { type: "function", function: { name: "ping" } },
  ]);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs[0]!.parameters, { type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  assert.deepEqual(specs[1]!.parameters, { type: "object", properties: {} });
});

test("responses and stream chunks use the OpenAI shapes", () => {
  const calls = [{ id: "c1", name: "run", args: { cmd: "ls" } }];
  const body = completionBody("id1", "openai/gpt", "", calls, { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 4 });
  assert.equal(body.choices[0]!.finish_reason, "tool_calls");
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 4);
  const chunk = toolCallsChunk("id1", "openai/gpt", calls, true) as { choices: Array<{ delta: { role: string; tool_calls: Array<{ index: number; function: { arguments: string } }> } }> };
  assert.equal(chunk.choices[0]!.delta.role, "assistant");
  assert.equal(chunk.choices[0]!.delta.tool_calls[0]!.function.arguments, '{"cmd":"ls"}');
});

test("model refs split on the first slash only", () => {
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude-x"), { slug: "openrouter", modelId: "anthropic/claude-x" });
  assert.equal(parseModelRef("nope"), null);
  assert.equal(modelRef("openai", "gpt-5"), "openai/gpt-5");
});

test("the prompt estimate counts messages, tool calls, attachments and tool specs", () => {
  const n = promptChars([{ role: "user", content: "hello" }, { role: "assistant", content: "", toolCalls: [{ id: "1", name: "x", args: { a: 1 } }] }], toToolSpecs([{ type: "function", function: { name: "t" } }]));
  assert.ok(n > 5 + 10);
});

test("installers point at the Friday server, verify checksums and are syntactically valid", () => {
  const sh = installShell("https://friday.example.com/");
  assert.ok(sh.includes('BASE="https://friday.example.com"'));
  assert.ok(sh.includes("/x/sha256/"));
  assert.ok(!sh.includes("__API__") && !sh.includes("__BASE__") && !sh.includes("\\${"));
  const check = spawnSync("bash", ["-n"], { input: sh });
  assert.equal(check.status, 0, check.stderr.toString());

  const ps = installPowerShell("https://friday.example.com");
  assert.ok(ps.includes("Get-FileHash") && ps.includes("$Base = 'https://friday.example.com'"));
  assert.ok(!ps.includes("__API__"));

  const cmd = installCmd("https://friday.example.com");
  assert.ok(cmd.includes("irm https://friday.example.com/x/install.ps1 | iex"));
  assert.ok(cmd.includes("\r\n"));
});

test("platform and version inputs are validated before they reach a URL", () => {
  assert.ok(isPlatform("darwin-arm64") && isPlatform("linux-x64-musl") && isPlatform("windows-arm64"));
  assert.ok(!isPlatform("../../etc/passwd") && !isPlatform("freebsd-x64"));
  assert.ok(isVersion("1.2.3") && isVersion("0.1.0-beta.1"));
  assert.ok(!isVersion("1.2") && !isVersion("1.2.3/../x") && !isVersion("latest"));
});

test("the server decides each model's context window, vendor prefixes stripped", () => {
  assert.equal(contextWindowFor("claude-sonnet-5-5"), 200_000);
  assert.equal(contextWindowFor("anthropic/claude-opus-5-5"), 200_000);
  assert.equal(contextWindowFor("gemini-3-pro"), 1_000_000);
  assert.equal(contextWindowFor("gpt-5.1"), 400_000);
  assert.equal(contextWindowFor("some-unknown-model"), 128_000);
});

test("server-driven client settings are a plain object or nothing", () => {
  const prev = process.env.FRIDAY_X_SETTINGS_JSON;
  try {
    delete process.env.FRIDAY_X_SETTINGS_JSON;
    assert.deepEqual(cliSettings(), {});
    process.env.FRIDAY_X_SETTINGS_JSON = '{"release_channel":"stable"}';
    assert.deepEqual(cliSettings(), { release_channel: "stable" });
    for (const bad of ["not json", "[1,2]", '"str"', "null"]) {
      process.env.FRIDAY_X_SETTINGS_JSON = bad;
      assert.deepEqual(cliSettings(), {}, bad);
    }
  } finally {
    if (prev === undefined) delete process.env.FRIDAY_X_SETTINGS_JSON;
    else process.env.FRIDAY_X_SETTINGS_JSON = prev;
  }
});
