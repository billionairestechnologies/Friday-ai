import assert from "node:assert/strict";
import test from "node:test";
import { addDomain, clientSettings, generatePassword, validLocalPart } from "../src/services/mail/hosting.js";
import { assertMailHost } from "../src/services/mail/webmail.js";

test("mailbox names: letters, digits, dots, dashes; no leading/trailing dot or double dots", () => {
  for (const ok of ["parth", "parth.rathod", "sales-team", "a", "dev_ops2"]) assert.ok(validLocalPart(ok), ok);
  for (const bad of ["", ".parth", "parth.", "par..th", "Parth Rathod", "a@b", "x".repeat(65)]) assert.ok(!validLocalPart(bad), bad);
});

test("generated passwords are long and contain every character class", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const p = generatePassword();
    assert.equal(p.length, 18);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[a-z]/);
    assert.match(p, /\d/);
    assert.match(p, /[^A-Za-z0-9]/);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
});

test("client settings point Gmail/Outlook/phones at our server over TLS", () => {
  process.env.MAILCOW_URL = "https://mail.example.com";
  const s = clientSettings("parth@example.com");
  assert.equal(s.incoming.host, "mail.example.com");
  assert.equal(s.incoming.port, 993);
  assert.equal(s.outgoing.port, 465);
  assert.equal(s.username, "parth@example.com");
});

test("external accounts can't point the server at private addresses or non-mail ports", async () => {
  await assert.rejects(assertMailHost("127.0.0.1", 993), /allowed|find/);
  await assert.rejects(assertMailHost("localhost", 993), /allowed|find/);
  await assert.rejects(assertMailHost("imap.gmail.com", 22), /mail port/);
  await assert.rejects(assertMailHost("bad host!", 993), /Invalid/);
});

test("mailcow refusals (HTTP 200 with type: danger) surface as errors, not silent success", async () => {
  process.env.MAILCOW_URL = "https://mail.example.com";
  process.env.MAILCOW_API_KEY = "k";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{ type: "danger", msg: ["domain_exists", "example.com"] }]), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    await assert.rejects(addDomain("example.com", "", "u"), /Mail server refused: domain_exists/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.MAILCOW_API_KEY;
  }
  await assert.rejects(addDomain("example.com", "", "u"), /isn't connected/);
});
