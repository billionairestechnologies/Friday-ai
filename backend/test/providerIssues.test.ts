import assert from "node:assert/strict";
import test from "node:test";
import { providerFrom, redactSecrets } from "../src/services/status/providerIssues.js";

test("provider is read from the error prefix or any vendor named in it", () => {
  assert.equal(providerFrom("scalemax: ScaleMax chat failed: 402 {}"), "scalemax");
  assert.equal(providerFrom("ScaleMax images /images/generations failed: 402"), "scalemax");
  assert.equal(providerFrom("something odd", "openai"), "openai");
  assert.equal(providerFrom("totally unknown"), "unknown");
});

test("keys, bearer tokens and JWTs are redacted before anything is stored or emailed", () => {
  const out = redactSecrets('sk-or-v1-b7d56d1332cf7ccedf7b1ef3 Bearer abcdefghijklmnop1234 eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNl.xdKM4esMqUgxauygQ7G7AzEiLjvAStYrHrXgLaqCkr4 api_key="abcd1234efgh5678"');
  assert.ok(!/b7d56d|abcdefghijklmnop|xdKM4esM|abcd1234efgh/.test(out), out);
});
