import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import type { AskQuestion } from "./types.js";

const CLARIFY_TIMEOUT_MS = 14000;

/**
 * Cheap, deliberately broad pre-filter for whether a plain-chat (non-Build) message is even worth
 * a model round trip to check for missing specifics. Most chat — questions, explanations, casual
 * conversation, search-style lookups — never needs this, and a probe on every message is exactly
 * the kind of unbounded per-message latency that caused "every model feels slow" before (see
 * projectBuild/intent.ts's own comment on the same trade-off). Only messages that plausibly ask
 * Friday to produce or send something on the user's behalf, where a wrong guess at a missing detail
 * (who, when, what it says, real personal info) would matter, reach the actual probe.
 */
const ACTION_TARGET =
  /\b(email|e-?mail|message|text|dm|sms|letter|invite|invitation|rsvp|post|tweet|caption|announcement|newsletter|speech|toast|eulogy|card|greeting|reminder|calendar (?:event|invite)|meeting|appointment|reservation|booking|itinerary|trip|resume|résumé|cover letter|cv|proposal|contract|gift|present)\b/i;
const ACTION_VERB = /\b(write|draft|compose|send|schedule|book|reserve|plan|organi[sz]e|set up|create|make|remind|invite|automate)\b/i;

export function mightNeedClarification(content: string): boolean {
  const text = content.trim();
  if (text.length < 8 || text.length > 1200) return false;
  if (!ACTION_VERB.test(text)) return false;
  return ACTION_TARGET.test(text);
}

const CLARIFY_PROMPT = `You are a careful assistant about to act on the user's request — like a competent human assistant who checks before doing something on someone's behalf instead of guessing at details that matter. Most requests are fine to just do; only flag one that would come out wrong, embarrassing, or unusable without a detail only the user has (a real recipient/name, an actual date or occasion, specific content/tone, a real quantity or budget) — and where a wrong guess is costly enough that asking first genuinely beats a good default. Do NOT ask about things a reasonable assistant would just pick sensibly (word count, formatting, which app/format, code specifics) — for those, just note your assumption isn't needed at all, since you're not building anything here.
Reply with ONLY JSON, no prose, in this shape:
{"questions":[{"question":"…?","options":[{"label":"short option","description":"one line why/what","recommended":true},{"label":"…"}]}]}
Rules: 0-2 questions — most requests get zero; only ask what's truly load-bearing. Each question has 2-4 options; the FIRST is your recommendation ("recommended":true) with the reason in its description. Every option's label MUST be an actual answer the user could pick as-is — a real suggested value, a real concrete choice — never a restatement of the question or a fill-in-the-blank description like "Recipient's name" or "Your details here"; those are form placeholders, not answers. Do NOT include an "Other" option (the UI adds it) — phrase the recommended option so picking "Other" to type the real detail (a real name, date, email) is the obvious move when the user has one. Reply {"questions":[]} for anything you can reasonably just do.`;

export async function clarifyGeneralRequest(history: ChatMessage[], candidates: ChatCandidate[]): Promise<AskQuestion[]> {
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
    for (const q of (parsed.questions ?? []).slice(0, 2)) {
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
