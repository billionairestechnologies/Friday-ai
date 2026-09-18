import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, listChatCandidates } from "../providerService.js";
import { rankCandidatesForMessage } from "../modelRouting.js";
import type { RunLanguage } from "../e2bService.js";

const FIX_SYSTEM_PROMPT =
  "You are fixing a script that just failed to run in a real sandbox. You will be given the " +
  "original code, its language, and the exact error/traceback it produced. Reply with ONLY the " +
  "corrected, complete, self-contained code in a single fenced code block tagged with that same " +
  "language — no explanation before or after, no partial diffs, the whole fixed file.";

const FENCE = /```(?:\w+)?\n([\s\S]*?)```/;

/** Asks a model to fix a script given the error it produced, returning just the corrected code
 *  (or null if no model could produce one — the caller should keep the original code and stop
 *  retrying rather than looping forever). */
export async function fixCode(
  language: RunLanguage,
  code: string,
  error: string,
): Promise<string | null> {
  try {
    const candidates = rankCandidatesForMessage(await listChatCandidates(), code);
    const candidate = candidates[0];
    if (!candidate) return null;

    const adapter = getProviderAdapter(candidate.slug);
    const apiKey = await getWorkingKeyForProvider(candidate.slug);
    const messages: ChatMessage[] = [
      { role: "system", content: FIX_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Language: ${language}\n\nCode:\n\`\`\`${language}\n${code}\n\`\`\`\n\nError when run:\n${error}`,
      },
    ];
    const raw = await adapter.chat(apiKey, candidate.modelId, messages);
    const fenced = FENCE.exec(raw);
    const fixed = (fenced ? fenced[1] : raw).trim();
    return fixed || null;
  } catch {
    return null;
  }
}
