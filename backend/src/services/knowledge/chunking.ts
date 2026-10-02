/**
 * Splits extracted text into overlapping chunks for search: ~1,200 characters each, cut at a
 * paragraph, line or sentence boundary when one is near, with ~200 characters of overlap so a fact
 * that straddles a boundary is still found whole. Section/page/slide/sheet headers ("== Slide 3 ==",
 * "--- Page 4 ---") are carried into the following chunks as context.
 */
const TARGET = 1200;
const OVERLAP = 200;
const HEADER = /^(==+ .+ ==+|--- Page \d+ ---)$/gm;

export function chunkText(text: string, target = TARGET, overlap = OVERLAP): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= target) return [clean];
  // Header positions, once (linear) — each chunk then takes the latest header before its end.
  const headers = [...clean.matchAll(HEADER)].map((m) => ({ at: m.index ?? 0, text: m[0] }));
  let h = -1;
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + target);
    if (end < clean.length) {
      const from = start + Math.floor(target * 0.6);
      const window = clean.slice(from, end);
      const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
      if (cut > 0) end = from + cut + 1;
    }
    while (h + 1 < headers.length && headers[h + 1]!.at < end) h++;
    const header = h >= 0 ? headers[h]!.text : "";
    const body = clean.slice(start, end).trim();
    if (body) chunks.push(header && !body.includes(header) ? `${header}\n${body}` : body);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
