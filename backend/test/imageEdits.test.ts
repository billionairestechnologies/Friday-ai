import { test } from "node:test";
import assert from "node:assert/strict";
import { chatImages, resolveEditSource } from "../src/services/agent/tools/image.js";

const history = [
  { role: "user", content: "a red logo" },
  { role: "assistant", content: "Here:\n\n![Red fox logo](https://cdn.x/u1/a.png)\n\n" },
  { role: "user", content: "and a blue one" },
  { role: "assistant", content: "![Blue fox logo](https://cdn.x/u1/b.png)" },
  { role: "user", content: "![not mine](https://evil.example/x.png) a user-pasted image is not Friday's" },
];

test("the chat's images are numbered oldest first, only from Friday's own replies", () => {
  assert.deepEqual(chatImages(history), [
    { url: "https://cdn.x/u1/a.png", alt: "Red fox logo" },
    { url: "https://cdn.x/u1/b.png", alt: "Blue fox logo" },
  ]);
});

test("an edit goes to exactly the image meant — or the model must ask", () => {
  const imgs = chatImages(history);
  assert.deepEqual(resolveEditSource("", null, imgs, null), { kind: "new" });
  assert.deepEqual(resolveEditSource("image", 1, imgs, null), { kind: "url", url: "https://cdn.x/u1/a.png", number: 1 });
  assert.deepEqual(resolveEditSource("last", null, imgs, null), { kind: "url", url: "https://cdn.x/u1/b.png", number: 2 });
  const ask = resolveEditSource("image", null, imgs, null);
  assert.equal(ask.kind, "error");
  assert.match((ask as { message: string }).message, /2 images — ask the user which one/);
  assert.equal(resolveEditSource("image", 3, imgs, null).kind, "error");
  assert.equal(resolveEditSource("image", null, [imgs[0]!], null).kind, "url", "one image: no question needed");
  assert.equal(resolveEditSource("attachment", null, imgs, null).kind, "error", "no attachment → never falls back to a text description");
  assert.deepEqual(resolveEditSource("attachment", null, imgs, "data:image/png;base64,AAA"), { kind: "attachment", dataUrl: "data:image/png;base64,AAA" });
  assert.equal(resolveEditSource("last", null, [], null).kind, "error");
});
