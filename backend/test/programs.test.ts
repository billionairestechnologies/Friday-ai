import { test } from "node:test";
import assert from "node:assert/strict";
import { DETAILS, decodeEvidence, sniffEvidence } from "../src/services/console/programService.js";

const b64 = (bytes: number[] | Buffer, mime = "application/octet-stream") => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

test("evidence type comes from the bytes, not the name or the browser's MIME", () => {
  assert.equal(sniffEvidence(PDF)?.mime, "application/pdf");
  assert.equal(sniffEvidence(PNG)?.mime, "image/png");
  assert.equal(sniffEvidence(JPG)?.mime, "image/jpeg");
  assert.equal(sniffEvidence(WEBP)?.mime, "image/webp");
  // A Windows executable renamed to id.pdf and sent as application/pdf is still refused.
  assert.throws(() => decodeEvidence({ name: "id.pdf", dataUrl: b64(Buffer.from("MZ\x90\x00 fake exe"), "application/pdf") }), /isn't a PDF/);
  // HTML pretending to be an image (stored-XSS attempt) is refused.
  assert.throws(() => decodeEvidence({ name: "x.png", dataUrl: b64(Buffer.from("<html><script>alert(1)</script>"), "image/png") }), /isn't a PDF/);
});

test("evidence names can't carry paths or control characters; size and emptiness are checked", () => {
  const ok = decodeEvidence({ name: "../../etc/passwd\u0000.pdf", dataUrl: b64(PDF) });
  assert.equal(ok.name, "passwd.pdf");
  assert.equal(ok.mime, "application/pdf");
  assert.equal(decodeEvidence({ name: "C:\\Users\\me\\card.png", dataUrl: b64(PNG) }).name, "card.png");
  assert.throws(() => decodeEvidence({ name: "big.pdf", dataUrl: b64(Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)])) }), /over 5 MB/);
  assert.throws(() => decodeEvidence({ name: "e.pdf", dataUrl: "data:application/pdf;base64," }), /Couldn't read|empty/);
  assert.throws(() => decodeEvidence({ name: "x", dataUrl: "https://evil.example/file.pdf" }), /Couldn't read/);
});

test("each programme validates its own form", () => {
  assert.equal(DETAILS.student.safeParse({ institution: "IIT Bombay", course: "B.Tech CSE", graduationYear: "2027" }).success, true);
  assert.equal(DETAILS.student.safeParse({ institution: "IIT Bombay", course: "B.Tech CSE" }).success, false, "graduation year required");
  const startup = { companyName: "Acme Labs", website: "https://acme.io", description: "We build AI agents for small clinics.", teamSize: 4, stage: "seed", contactRole: "Founder" };
  assert.equal(DETAILS.startup.safeParse(startup).success, true);
  assert.equal(DETAILS.startup.safeParse({ ...startup, website: "javascript:alert(1)" }).success, false);
  assert.equal(DETAILS.startup.safeParse({ ...startup, stage: "unicorn" }).success, false);
  assert.equal(DETAILS.company.safeParse({ companyName: "BigCo", website: "https://big.co", teamSize: 900, seatsNeeded: 120, useCase: "Support team copilots", contactRole: "CTO" }).success, true);
  const extra = DETAILS.student.parse({ institution: "IISc", course: "MSc", graduationYear: 2026, admin: true }) as Record<string, unknown>;
  assert.equal("admin" in extra, false, "unknown keys are dropped");
});
