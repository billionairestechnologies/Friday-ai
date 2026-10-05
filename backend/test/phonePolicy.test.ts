import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PHONE_CONFIG,
  DEFAULT_USER_PHONE_SETTINGS,
  decideTurn,
  inrForSeconds,
  minutesLeft,
  planAllowsPhone,
  spokenDelivery,
} from "../src/services/phone/policy.js";

const base = {
  knownUser: true,
  plan: "premium",
  usedSeconds: 0,
  config: DEFAULT_PHONE_CONFIG,
  settings: DEFAULT_USER_PHONE_SETTINGS,
  machineOnline: false,
  now: new Date("2026-10-05T12:00:00"),
};

test("unknown numbers get one sentence and the call ends", () => {
  const decision = decideTurn({ ...base, knownUser: false, text: "hello" });
  assert.equal(decision.action, "hangup");
  assert.match(decision.speak, /isn't on a Friday account/);
});

test("free and pro do not get the phone; premium does", () => {
  assert.equal(planAllowsPhone("free", DEFAULT_PHONE_CONFIG), false);
  assert.equal(planAllowsPhone("pro", DEFAULT_PHONE_CONFIG), false);
  assert.equal(planAllowsPhone("premium", DEFAULT_PHONE_CONFIG), true);
  assert.equal(decideTurn({ ...base, plan: "pro", text: "what's the status" }).action, "hangup");
});

test("a short question stays on the line", () => {
  const decision = decideTurn({ ...base, text: "what's the status of the invoice" });
  assert.equal(decision.action, "hold");
  assert.equal(decision.hold, true);
});

test("research and builds leave the line unless they say stay", () => {
  const released = decideTurn({ ...base, text: "research the competitors and build me a website" });
  assert.equal(released.action, "release");
  assert.equal(released.research, true);
  assert.equal(released.build, true);
  const stayed = decideTurn({ ...base, text: "research this and stay with me" });
  assert.equal(stayed.action, "hold");
});

test("spoken delivery overrides the default and still keeps the app", () => {
  const channels = spokenDelivery("send it on telegram and email", DEFAULT_USER_PHONE_SETTINGS, DEFAULT_PHONE_CONFIG);
  assert.ok(channels.includes("app"));
  assert.ok(channels.includes("telegram"));
  assert.ok(channels.includes("email"));
  assert.equal(channels.includes("whatsapp"), false);
});

test("whatsapp stays off until admin turns the channel on", () => {
  const closed = spokenDelivery("whatsapp it", DEFAULT_USER_PHONE_SETTINGS, DEFAULT_PHONE_CONFIG);
  assert.equal(closed.includes("whatsapp"), false);
  const open = spokenDelivery("whatsapp it", DEFAULT_USER_PHONE_SETTINGS, {
    ...DEFAULT_PHONE_CONFIG,
    channels: { ...DEFAULT_PHONE_CONFIG.channels, whatsapp: true },
  });
  assert.ok(open.includes("whatsapp"));
});

test("pay without a yes waits, and the minute cap hangs up", () => {
  assert.equal(decideTurn({ ...base, text: "pay the invoice" }).speak, "Say yes, then your passphrase, and I'll do that.");
  assert.equal(minutesLeft(60 * 60, DEFAULT_PHONE_CONFIG), 0);
  assert.equal(decideTurn({ ...base, usedSeconds: 60 * 60, text: "hello" }).action, "hangup");
  assert.equal(inrForSeconds(90 * 60, DEFAULT_PHONE_CONFIG), 120);
});

test("a missing computer is said out loud", () => {
  const decision = decideTurn({ ...base, text: "do it on my machine" });
  assert.match(decision.speak, /isn't connected/);
  const online = decideTurn({ ...base, machineOnline: true, text: "do it on my machine" });
  assert.equal(online.action, "hold");
});
