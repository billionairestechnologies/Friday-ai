import { test } from "node:test";
import assert from "node:assert/strict";
import { describeClient, ipPrefix, platformOf, sessionIdFromToken } from "../src/services/sessions/sessionService.js";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

test("reads the session id claim, rejects anything that isn't a uuid", () => {
  assert.equal(sessionIdFromToken(jwt({ session_id: "0b5e2c1a-1111-4222-8333-944455556666" })), "0b5e2c1a-1111-4222-8333-944455556666");
  assert.equal(sessionIdFromToken(jwt({ session_id: "x'; drop table" })), null);
  assert.equal(sessionIdFromToken(jwt({})), null);
  assert.equal(sessionIdFromToken("fxt_notajwt"), null);
  assert.equal(sessionIdFromToken("a.%%%.c"), null);
});

test("platform: header wins, then the apps' HTTP clients, then browsers", () => {
  assert.equal(platformOf("okhttp/4.12.0"), "android");
  assert.equal(platformOf("FridayApp/1 CFNetwork/1490 Darwin/23.0.0"), "ios");
  assert.equal(platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Safari/604.1"), "web");
  assert.equal(platformOf("okhttp/4", "ios"), "ios");
  assert.equal(platformOf(undefined), "other");
});

test("client labels are human, never the raw user agent", () => {
  assert.equal(describeClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36", "web"), "Chrome on macOS");
  assert.equal(describeClient("Mozilla/5.0 (Windows NT 10.0) Chrome/129 Safari/537.36 Edg/129", "web"), "Edge on Windows");
  assert.equal(describeClient("Mozilla/5.0 (iPhone) Version/17 Mobile Safari/604.1", "web"), "Safari on iOS");
  assert.equal(describeClient("okhttp/4", "android"), "Friday for Android");
});

test("only a coarse IP prefix is kept", () => {
  assert.equal(ipPrefix("203.0.113.77"), "203.0.113.x");
  assert.equal(ipPrefix("::ffff:198.51.100.4"), "198.51.100.x");
  assert.equal(ipPrefix("2001:db8:abcd:12::1"), "2001:db8:abcd::");
  assert.equal(ipPrefix(undefined), null);
});
