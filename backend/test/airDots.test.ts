import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { nextStep } from "../src/services/air/jobs.js";
import { isLeaving } from "../src/services/air/gate.js";
import { describeAction, gateKindFor, rememberElements } from "../src/services/air/tools.js";
import { minutesToCharge } from "../src/services/air/awake.js";
import { toDaemonCommand } from "../src/services/air/screen.js";
import { readTelegramUpdate, readWhatsAppWebhook, telegramLinkCode, userFromTelegramCode, verifyWhatsAppSubscription } from "../src/services/air/channels.js";
import { summarizeTranscript } from "../src/services/phone/calls.js";
import { DEFAULT_PHONE_CONFIG, DEFAULT_USER_PHONE_SETTINGS, decideTurn } from "../src/services/phone/policy.js";

const round = { turnFailed: false, turnAborted: false, stopRequested: false, quotaStopped: false, round: 1, maxRounds: 12, replyText: "ok" };

test("the loop continues only when the model says it is still working", () => {
  assert.deepEqual(nextStep({ ...round, reported: "working" }), { continue: true, status: "running" });
  assert.deepEqual(nextStep({ ...round, reported: "done" }), { continue: false, status: "done" });
  assert.deepEqual(nextStep({ ...round, reported: "needs_login" }), { continue: false, status: "needs_login" });
  assert.deepEqual(nextStep({ ...round, reported: "needs_approval" }), { continue: false, status: "needs_approval" });
  // No report: a plain one-turn answer is a finished job, never an endless loop.
  assert.deepEqual(nextStep({ ...round, reported: null, replyText: "It is 31°C in Vadodara." }), { continue: false, status: "done" });
  // "I'm not done yet" used to stop the old regex loop; now only the report counts.
  assert.deepEqual(nextStep({ ...round, reported: "working", replyText: "I'm not done yet" }), { continue: true, status: "running" });
});

test("stop, the meter and the round cap end the loop", () => {
  assert.equal(nextStep({ ...round, reported: "working", stopRequested: true }).status, "stopped");
  assert.equal(nextStep({ ...round, reported: "working", turnAborted: true }).status, "stopped");
  assert.equal(nextStep({ ...round, reported: "working", turnFailed: true, quotaStopped: true }).status, "out_of_meter");
  assert.equal(nextStep({ ...round, reported: "working", turnFailed: true }).status, "failed");
  assert.equal(nextStep({ ...round, reported: "working", round: 12 }).status, "blocked");
});

test("the gate stops leaving actions and lets ordinary ones through", () => {
  assert.equal(isLeaving("browser", "browser", 'click button "Place order"'), true);
  assert.equal(isLeaving("browser", "browser", 'click button "Pay ₹349"'), true);
  assert.equal(isLeaving("browser", "browser", 'click a "Facebook"'), false);
  assert.equal(isLeaving("browser", "browser", 'click button "Add to cart"'), false);
  assert.equal(isLeaving("browser", "browser", "open https://www.zomato.com"), false);
  assert.equal(isLeaving("connector", "gmail_send", "{}"), true);
  assert.equal(isLeaving("connector", "github_create_issue", "{}"), true);
  assert.equal(isLeaving("connector", "gmail_search", "{}"), false);
  assert.equal(isLeaving("shell", "run_code", "rm -rf node_modules"), false);
  assert.equal(isLeaving("shell", "run_code", "rm -rf ~/"), true);
  assert.equal(isLeaving("file", "create_document", "delete everything"), false);
});

test("browser clicks are judged by the button's words from the last snapshot", () => {
  rememberElements("c1", 'URL: https://x\n[3] button "Place order"\n[4] a "Menu"');
  assert.equal(describeAction("browser", { action: "click", ref: 3 }, "c1"), 'click button "Place order"');
  assert.equal(describeAction("browser", { action: "click", ref: "4" }, "c1"), 'click a "Menu"');
  assert.equal(gateKindFor("browser"), "browser");
  assert.equal(gateKindFor("run_code"), "shell");
  assert.equal(gateKindFor("web_search"), "tool");
  assert.equal(gateKindFor("notion_create_page"), "connector");
});

test("awake minutes are charged only for time a keep-alive actually adds", () => {
  const now = 1_000_000;
  assert.equal(minutesToCharge(0, now + 8 * 60_000, now), 8);
  assert.equal(minutesToCharge(now + 7 * 60_000, now + 8 * 60_000, now), 1);
  assert.equal(minutesToCharge(now + 8 * 60_000, now + 8 * 60_000, now), 0);
  assert.equal(minutesToCharge(now - 60_000, now + 8 * 60_000, now), 8);
});

test("the person's cursor and keys are clamped and whitelisted", () => {
  assert.deepEqual(toDaemonCommand({ type: "click", x: 5000, y: -3 }), { action: "click_at", x: 1280, y: 0 });
  assert.deepEqual(toDaemonCommand({ type: "key", key: "Enter" }), { action: "press", key: "Enter" });
  assert.throws(() => toDaemonCommand({ type: "key", key: "Meta+Q" }));
  assert.throws(() => toDaemonCommand({ type: "open", url: "http://169.254.169.254/latest" }));
});

test("WhatsApp webhooks must be signed with the app secret", () => {
  process.env.WHATSAPP_APP_SECRET = "s3cret";
  const body = { entry: [{ changes: [{ value: { messages: [{ from: "919876543210", type: "text", text: { body: "rukho" } }] } }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = `sha256=${createHmac("sha256", "s3cret").update(raw).digest("hex")}`;
  assert.deepEqual(readWhatsAppWebhook(body, sig, raw), [{ from: "919876543210", text: "rukho" }]);
  assert.deepEqual(readWhatsAppWebhook(body, "sha256=bad", raw), []);
  process.env.WHATSAPP_VERIFY_TOKEN = "vt";
  assert.equal(verifyWhatsAppSubscription({ "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "42" }), "42");
  assert.equal(verifyWhatsAppSubscription({ "hub.mode": "subscribe", "hub.verify_token": "no", "hub.challenge": "42" }), null);
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_VERIFY_TOKEN;
});

test("Telegram links a chat with a signed /start code", () => {
  const user = "2f1c3a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
  const code = telegramLinkCode(user);
  assert.ok(code.length <= 64 && /^[A-Za-z0-9_-]+$/.test(code));
  assert.equal(userFromTelegramCode(code), user);
  assert.equal(userFromTelegramCode(`${user}_AAAAAAAAAA`), null);
  assert.deepEqual(readTelegramUpdate({ message: { chat: { id: 77 }, text: " hi " } }), { chatId: "77", text: "hi" });
  assert.equal(readTelegramUpdate({ edited_message: {} }), null);
});

test("call minutes come from the plan: Pro 15, Premium 60, Free none", () => {
  const base = { knownUser: true, plan: "pro", text: "what's on my calendar today", config: DEFAULT_PHONE_CONFIG, settings: DEFAULT_USER_PHONE_SETTINGS, machineOnline: false };
  assert.equal(decideTurn({ ...base, usedSeconds: 10 * 60, allowed: true, limitMinutes: 15 }).action, "hold");
  assert.equal(decideTurn({ ...base, usedSeconds: 15 * 60, allowed: true, limitMinutes: 15 }).action, "hangup");
  assert.equal(decideTurn({ ...base, usedSeconds: 0, allowed: false, limitMinutes: 0 }).action, "hangup");
  assert.equal(decideTurn({ ...base, knownUser: false, usedSeconds: 0, allowed: true, limitMinutes: 60 }).action, "hangup");
  assert.equal(decideTurn({ ...base, text: "build me a landing page for my bakery", usedSeconds: 0, allowed: true, limitMinutes: 60 }).action, "release");
});

test("a call's summary keeps the ask and the answer, not the audio", () => {
  const s = summarizeTranscript({
    transcript: [
      { role: "them", text: "book a table at 8", at: "" },
      { role: "friday", text: "Booked at Mandap for 8 pm.", at: "" },
    ],
  });
  assert.equal(s, "Asked: book a table at 8 — Friday: Booked at Mandap for 8 pm.");
  assert.equal(summarizeTranscript({ transcript: [] }), null);
});
