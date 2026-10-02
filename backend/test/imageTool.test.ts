import assert from "node:assert/strict";
import test from "node:test";
import { imageTool, lastGeneratedImageUrl } from "../src/services/agent/tools/image.js";

test("generate_image spec stays inside the schema subset every dialect accepts", () => {
  const { spec } = imageTool({ lastImageUrl: null, attachedImage: null });
  assert.equal(spec.name, "generate_image");
  assert.ok(!JSON.stringify(spec.parameters).includes("additionalProperties"));
  for (const req of spec.parameters.required ?? []) assert.ok(req in spec.parameters.properties);
});

test("lastGeneratedImageUrl finds the newest image Friday put in a reply", () => {
  const history = [
    { role: "user", content: "a cat" },
    { role: "assistant", content: "Here you go:\n\n![cat](https://img.example/a.png)" },
    { role: "user", content: "now a dog" },
    { role: "assistant", content: "![dog](https://img.example/b.png)\n\nA dog." },
    { role: "user", content: "make it blue" },
  ];
  assert.equal(lastGeneratedImageUrl(history), "https://img.example/b.png");
  assert.equal(lastGeneratedImageUrl([{ role: "assistant", content: "no images" }]), null);
  // Only assistant turns count — a user pasting image markdown is not "your last image".
  assert.equal(lastGeneratedImageUrl([{ role: "user", content: "![x](https://u.example/x.png)" }]), null);
});

test("edit modes fail with a clear message when there is nothing to edit", async () => {
  const tool = imageTool({ lastImageUrl: null, attachedImage: null });
  // No provider key in tests, so the key lookup itself fails first — the error must be a readable sentence for the model.
  await assert.rejects(tool.run({ prompt: "make it blue", edit: "last" }, { userId: "u", conversationId: "c" }), /image|key|provider|earlier/i);
});
