/** Keep a long call from re-sending every earlier turn. Audio compression is on the live session. */

export function compressCallContext(lines: string[], keep = 4): string {
  const clean = lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (clean.length <= keep) return clean.join("\n");
  const older = clean.slice(0, -keep).map((line) => line.slice(0, 80));
  const summary = older.join(" | ").slice(0, 400);
  return `Earlier on this call, compressed: ${summary}\n${clean.slice(-keep).join("\n")}`;
}
