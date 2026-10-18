import assert from "node:assert/strict";
import test from "node:test";
import { detectImageIntent } from "../src/services/chat/imageIntent.js";

// Production incident (2026-10-02): a long landing-page brief ("UI Designer", "logo", "icons") and a
// pasted web page both started "Creating your image" instead of reaching the model / Build agent.
test("short, explicit image requests still generate", () => {
  for (const m of ["draw a logo for my cafe", "create an image of a macbook on a table", "generate a picture of a cat", "make me a poster"]) {
    assert.equal(detectImageIntent(m, false)?.kind, "generate", m);
  }
});

test("a long brief that merely mentions a logo or icons is not an image request", () => {
  const brief =
    "ROLE You are a Principal Frontend Engineer and UI Designer.\nTASK Build the complete landing page.\n- Lucide React for icons\n1. Sticky Navbar: logo, live ticker badge.\n" +
    "Section details. ".repeat(60);
  assert.equal(detectImageIntent(brief, false), null);
});

test("a short build request that names a logo in passing is not an image request", () => {
  assert.equal(detectImageIntent("Build a landing page with a navbar, a logo and icons", false), null);
});

test("pasted page text with make/create far from image words is not an image request", () => {
  const pasted = "can you make a excel for me\n" + "Advanced Excel Training\nData Analysis Excel for Beginners\n".repeat(30) + "Terms of Content Use";
  assert.equal(detectImageIntent(pasted, false), null);
});

test("only a short message about the picture counts as an image correction", async () => {
  const { looksLikeImageCorrection } = await import("../src/services/chat/imageIntent.js");
  for (const yes of ["change colour of car to red", "make it blue", "no, I told you macbook on table", "darker background", "remove the man"]) {
    assert.equal(looksLikeImageCorrection(yes), true, yes);
  }
  // Production 2026-10-18: these followed a generated image and were sent to the image editor.
  for (const no of ["type big story", "make it a pdf", "write a poem about it", "what is this car?", "make slides from this", "thanks", "hi"]) {
    assert.equal(looksLikeImageCorrection(no), false, no);
  }
  assert.equal(looksLikeImageCorrection("make it red ".repeat(10)), false, "long messages are never corrections");
});
