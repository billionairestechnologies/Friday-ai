import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import type { AskQuestion } from "../chat/types.js";

/** Stored as the assistant message's text — also how later turns know a question round already happened. */
export const ASK_MARKER = "Before I start building, I have a few quick questions so the result is what you need.";
/** The client sends the user's picks back as a normal message that starts with this. */
export const ANSWERS_PREFIX = "My answers to your questions:";

const CLARIFY_TIMEOUT_MS = 9000;

const CLARIFY_PROMPT = `You are the requirements analyst of a coding agent about to build the user's request as a real project. Decide whether important details are MISSING and would change what gets built (e.g. what kind of site/app, which features, authentication method, database, visual style, pages, target audience, deployment). If the request is already specific enough to build something satisfying, ask nothing.
Reply with ONLY JSON, no prose, in this shape:
{"questions":[{"question":"…?","options":[{"label":"short option","description":"one line why/what","recommended":true},{"label":"…"}]}]}
Rules: 0-4 questions (fewer is better; only what truly matters). Each question has 2-4 concrete options; the FIRST option is your recommendation and is the only one with "recommended":true; put the reason it is best in its description. Do NOT include an "Other" option (the UI adds it). Never ask about things you can decide yourself (folder structure, library versions). If nothing important is missing reply {"questions":[]}.`;

export function alreadyAsked(history: ChatMessage[]): boolean {
  return history.some((m) => (m.role === "assistant" && m.content.includes(ASK_MARKER)) || (m.role === "user" && m.content.startsWith(ANSWERS_PREFIX)));
}

/** Returns questions to ask before building, or [] to just build. Never throws; slow/failed = build. */
export async function clarifyRequest(history: ChatMessage[], candidates: ChatCandidate[]): Promise<AskQuestion[]> {
  const candidate = candidates[0];
  const request = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!candidate || request.trim().length < 3) return [];
  try {
    const adapter = getProviderAdapter(candidate.slug);
    const apiKey = await getWorkingKeyForProvider(candidate.slug);
    const messages: ChatMessage[] = [
      { role: "system", content: CLARIFY_PROMPT },
      ...history.filter((m) => m.role !== "system").slice(-4),
    ];
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("clarify timed out")), CLARIFY_TIMEOUT_MS));
    const raw = await Promise.race([adapter.chat(apiKey, candidate.modelId, messages), timeout]);
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return [];
    const parsed = JSON.parse(json) as { questions?: { question?: string; options?: { label?: string; description?: string; recommended?: boolean }[] }[] };
    const out: AskQuestion[] = [];
    for (const q of (parsed.questions ?? []).slice(0, 4)) {
      const options = (q.options ?? [])
        .filter((o) => o.label && String(o.label).trim())
        .slice(0, 4)
        .map((o, i) => ({ label: String(o.label).trim().slice(0, 80), description: o.description ? String(o.description).slice(0, 160) : undefined, recommended: i === 0 }));
      if (q.question && options.length >= 2) out.push({ id: `q${out.length + 1}`, question: String(q.question).trim().slice(0, 200), options });
    }
    return out;
  } catch {
    return [];
  }
}
