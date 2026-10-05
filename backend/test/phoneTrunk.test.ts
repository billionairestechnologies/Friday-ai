import assert from "node:assert/strict";
import test from "node:test";
import { compressCallContext } from "../src/services/phone/context.js";
import { liveSetup } from "../src/services/phone/live.js";
import { dialPayload, readInbound, renderExotel, renderTwilio, resetTrunks, trunkForNumber } from "../src/services/phone/trunk.js";
import { spokenPassphrase } from "../src/services/air/passphrase.js";
import { allowSensitive, gateRefusal, noteGate, recentGate, resetActionGate } from "../src/services/projectBuild/actionGate.js";

test("a long call keeps the latest turns and compresses the rest", () => {
  const lines = ["one", "two", "three", "four", "five", "six"];
  const packed = compressCallContext(lines, 2);
  assert.match(packed, /compressed/);
  assert.match(packed, /five\nsix/);
  assert.equal(packed.includes("\nthree\n"), false);
});

test("Gemini Live is opened with context compression", () => {
  const setup = liveSetup("gemini-2.5-flash-native-audio-preview-12-2025");
  assert.equal(setup.setup.contextWindowCompression.slidingWindow.targetTokens, 8_000);
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ["AUDIO"]);
});

test("India dials Exotel and other countries dial Telnyx or Twilio", () => {
  assert.equal(trunkForNumber("+919876543210"), "exotel");
  assert.equal(trunkForNumber("9876543210"), "exotel");
  const abroad = trunkForNumber("+14155552671");
  assert.equal(abroad === "telnyx" || abroad === "twilio", true);
});

test("an Exotel greeting is speech XML and a hangup ends the call", () => {
  process.env.PHONE_GATEWAY_SECRET = "test-secret";
  process.env.PUBLIC_API_URL = "https://friday.example";
  const greeting = renderExotel("Friday here.", false);
  assert.match(greeting, /<Say>Friday here.<\/Say>/);
  assert.match(greeting, /\/api\/phone\/exotel\/test-secret/);
  const done = renderExotel("You've used this month's call minutes.", true);
  assert.match(done, /<Hangup\/>/);
  assert.equal(done.includes("<Gather"), false);
  const twilio = renderTwilio("A & B", false);
  assert.match(twilio, /A &amp; B/);
});

test("trunk bodies from Exotel, Twilio, and Telnyx share one reader", () => {
  assert.equal(readInbound({ From: "+9198", SpeechResult: "hello", CallSid: "ex1" }).text, "hello");
  assert.equal(readInbound({ From: "+1415", SpeechResult: "status", CallSid: "tw1" }).sessionId, "tw1");
  const telnyx = readInbound({
    data: { event_type: "call.transcription", payload: { from: "+1415", call_control_id: "cc1", transcription_data: { transcript: "book it" } } },
  });
  assert.equal(telnyx.text, "book it");
  assert.equal(telnyx.event, "call.transcription");
  resetTrunks();
});

test("the dial plan points at the trunk webhook, not the JSON turn", () => {
  process.env.PHONE_GATEWAY_SECRET = "test-secret";
  process.env.PUBLIC_API_URL = "https://friday.example";
  const plan = dialPayload("+919876543210");
  assert.equal(plan.trunk, "exotel");
  assert.match(plan.url, /\/api\/phone\/exotel\/test-secret$/);
});

test("a spoken passcode can be set or changed", () => {
  assert.equal(spokenPassphrase("my passcode is jagga jasoos"), "jagga jasoos");
  assert.equal(spokenPassphrase("change my passcode to naya naya"), "naya naya");
  assert.equal(spokenPassphrase("hello"), null);
});

test("shell, browser, and files share one gate, and leaving the account waits for a yes", () => {
  resetActionGate();
  noteGate("user", "convo", "file", "src/App.jsx");
  noteGate("user", "convo", "browser", "port 5173");
  assert.equal(recentGate("convo").length, 2);
  assert.match(gateRefusal("convo", "shell", "rm -rf /") ?? "", /passphrase/);
  allowSensitive("convo");
  assert.equal(gateRefusal("convo", "shell", "rm -rf /"), null);
  assert.equal(gateRefusal("convo", "file", "src/App.jsx"), null);
  resetActionGate();
});
