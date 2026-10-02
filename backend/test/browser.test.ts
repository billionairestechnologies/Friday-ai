import assert from "node:assert/strict";
import test from "node:test";
import { browserTool, formatSnapshot } from "../src/services/agent/tools/browser.js";
import { DAEMON_SOURCE } from "../src/services/browser/daemon.js";

test("browser spec + snapshot format the model acts on", () => {
  assert.equal(browserTool.spec.name, "browser");
  assert.ok(!JSON.stringify(browserTool.spec.parameters).includes("additionalProperties"));
  const out = formatSnapshot({ ok: true, url: "https://x.com/", title: "X", elements: ['[1] button "Search"', '[2] input(text) "Query"'], text: "Hello", more: true });
  assert.match(out, /\[1\] button "Search"/);
  assert.match(out, /more below/);
  assert.match(formatSnapshot({ ok: false, error: "Timeout", url: "https://x.com" }), /Browser error: Timeout \(on https:\/\/x.com\)/);
});

test("browser refuses internal URLs and guessed selectors before touching a sandbox", async () => {
  const ctx = { userId: "u", conversationId: "c" };
  await assert.rejects(browserTool.run({ action: "open", url: "http://localhost:3000" }, ctx), /Internal hosts/);
  await assert.rejects(browserTool.run({ action: "open", url: "http://169.254.169.254/latest" }, ctx), /Private or reserved/);
  await assert.rejects(browserTool.run({ action: "open", url: "file:///etc/passwd" }, ctx), /http/);
  await assert.rejects(browserTool.run({ action: "click", ref: "#login" }, ctx), /element number/);
  await assert.rejects(browserTool.run({ action: "fly" }, ctx), /action must be/);
});

test("the in-sandbox daemon is valid JavaScript", async () => {
  const { parse } = await import("node:vm").then(() => ({ parse: (src: string) => new Function(`return async () => {${src.replace(/^import .*$/gm, "")}}`) }));
  assert.doesNotThrow(() => parse(DAEMON_SOURCE));
});
