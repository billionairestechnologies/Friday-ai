import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import type { AskQuestion } from "../chat/types.js";

/** Stored as the assistant message's text — also how later turns know a question round already
 *  happened. Shared verbatim with clarifyGeneral.ts's non-Build ask round (see alreadyAsked below),
 *  so it's worded generically rather than "before I start building". */
export const ASK_MARKER = "A few quick questions before I go ahead, so the result is what you need.";
/** The client sends the user's picks back as a normal message that starts with this. */
export const ANSWERS_PREFIX = "My answers to your questions:";

const CLARIFY_TIMEOUT_MS = 14000;

const CLARIFY_PROMPT = `You are the requirements analyst of a coding agent about to build the user's request as a real project — like a senior engineer would before starting real work, not a code generator that guesses. Err toward asking: a request that names a domain but not the specifics (what kind of "trading terminal"? which market/exchange? real money or demo? what's it even called?) is NOT specific enough, even if it sounds concrete on the surface. Only skip questions for requests that are genuinely simple and unambiguous (e.g. "a one-page portfolio site with my photo and links").
Always consider asking about, when the answer isn't already given or obvious from context:
- What the project/site should be called (a short name — used for the title, README, package name).
- The specific scope/domain details that change the actual build (e.g. for a trading terminal: which market or exchange's data, real order execution vs. a demo/paper-trading UI, which asset classes; for any app with accounts: auth method and whether data needs to persist).
- Visual style/reference if the request is vague about how it should look.
- For anything that will show real-world business details (a landing page, portfolio, storefront, etc.): whether the user has actual contact info (email/phone/social links/address) to put in, or wants realistic placeholders they'll swap in later.
Reply with ONLY JSON, no prose, in this shape:
{"questions":[{"question":"…?","options":[{"label":"short option","description":"one line why/what","recommended":true},{"label":"…"}]}]}
Rules: 1-4 questions for anything beyond a trivial single-purpose page (fewer is better; only what truly matters, but do not return zero questions just because you could technically guess reasonable defaults for a non-trivial build). Each question has 2-4 concrete options; the FIRST option is your recommendation and is the only one with "recommended":true; put the reason it is best in its description.
Every option's label MUST be an actual answer the user could pick as-is — a real suggested name, a real concrete choice — never a restatement of the question or a fill-in-the-blank description of what the answer should contain. "My business/brand name", "Your name here", "Enter contact details" etc. are form placeholders, not answers, and must never appear as an option; a user tapping an option is committing to that exact text or effect, not filling in a blank. For a naming question, offer a few actual plausible names you invented for this project plus a distinct "Surprise me / you choose" option. For contact/real-detail questions, the options are ways to proceed (e.g. "Use realistic placeholders for now" recommended, vs. "I'll give you the real details" which should make the question's description say to type them under Other) — never an option whose label is the placeholder text itself. Do NOT include an "Other" option in the JSON (the UI adds it) — but a question about something genuinely personal (a real name, email, phone, address) should always work if the user picks Other and types it themselves, so phrase the question and recommended option so choosing Other is the obvious move when they have real info to give. Never ask about things that don't change the outcome (folder structure, library versions, code style). Only reply {"questions":[]} for something genuinely small and already fully specified.`;

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
