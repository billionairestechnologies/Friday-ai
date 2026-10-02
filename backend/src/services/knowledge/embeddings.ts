import { getWorkingKeyForProvider } from "../providerService.js";

/**
 * Text embeddings for project knowledge. Uses whichever provider this deployment has a key for —
 * OpenAI text-embedding-3-small (1536 dims) first, then Gemini gemini-embedding-001 asked for 1536
 * dims — and returns null when neither is available: search then runs on full-text alone, which
 * still works (just less well on paraphrased questions). Vectors are L2-normalised so cosine
 * distance means the same thing for both models.
 */
export const EMBED_DIMS = 1536;
export type Embedder = { model: string; embed: (texts: string[], kind: "document" | "query") => Promise<number[][]> };

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

async function openAiEmbedder(): Promise<Embedder | null> {
  const key = await getWorkingKeyForProvider("openai").catch(() => null);
  if (!key) return null;
  return {
    model: "openai/text-embedding-3-small",
    async embed(texts) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
    },
  };
}

async function geminiEmbedder(): Promise<Embedder | null> {
  const key = await getWorkingKeyForProvider("gemini").catch(() => null);
  if (!key) return null;
  return {
    model: "gemini/gemini-embedding-001@1536",
    async embed(texts, kind) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: "models/gemini-embedding-001",
            content: { parts: [{ text }] },
            outputDimensionality: EMBED_DIMS,
            taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          })),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Gemini embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { embeddings: { values: number[] }[] };
      return json.embeddings.map((e) => normalize(e.values));
    },
  };
}

/** The embedder for new chunks, or a specific model (so a query is embedded like its chunks were). */
export async function getEmbedder(model?: string | null): Promise<Embedder | null> {
  if (process.env.FRIDAY_DISABLE_EMBEDDINGS === "1") return null;
  if (model?.startsWith("gemini/")) return geminiEmbedder();
  if (model?.startsWith("openai/")) return openAiEmbedder();
  return (await openAiEmbedder()) ?? (await geminiEmbedder());
}

/** pgvector's text format. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(7) : "0")).join(",")}]`;
}
