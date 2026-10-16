import { getProviderAdapter } from "../providers/registry.js";
import { meteredChat } from "../quota/meterContext.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, listChatCandidates } from "../providerService.js";
import { rankCandidatesForMessage } from "../modelRouting.js";
import { findGitHubRepoUrl } from "./github.js";

/**
 * Decides whether a message should start the Build agent (real sandbox: write files, install, run,
 * preview) instead of an ordinary chat reply. The decision itself is a model's judgment — a keyword
 * list can't tell "build me a CRM dashboard" from "explain how a dashboard works" — but a probe
 * costs latency on every message, so a cheap, deliberately BROAD gate first drops the obviously
 * conversational ones (the same reason liveSearchIntent bounds its probe: an unbounded probe was the
 * cause of "every model feels slow" before).
 */
const PROBE_TIMEOUT_MS = 3000;

const ACTION_WORDS =
  /\b(build|create|make|develop|code|write|generate|set ?up|scaffold|implement|design|clone|launch|run|start|deploy|install|fix|add|change|update|modify|improve|redesign|continue)\b/i;
const PROJECT_WORDS =
  /\b(app|apps|website|web ?site|web ?app|webpage|landing|page|project|api|server|backend|back-end|frontend|front-end|full[- ]?stack|dashboard|react|next\.?js|vite|vue|svelte|angular|node|express|flask|django|fastapi|python|script|bot|cli|game|calculator|todo|component|portfolio|clone|tool|saas|crm|store|shop|blog|platform|mvp)\b/i;
/** With a project already in this chat these short follow-ups always mean "do it in the project". */
const PROJECT_FOLLOWUP = /^\s*(run|start|launch|open|restart|deploy|preview)( it| the (app|project|site|server))?[.!?\s]*$/i;

const PROBE_PROMPT =
  "Answer with exactly one word, YES or NO — nothing else. An autonomous coding agent has a real Linux sandbox " +
  "(it can write many files, install packages, run servers and show a live preview). Should it be used for the " +
  "user's message? YES when the user wants something built or changed as a real working project — an app, website, " +
  "landing page, API/backend, game, dashboard, tool, bot, script or multi-file codebase (React, Next, Vite, Node, " +
  "Python, etc.) — or wants an existing project run, launched, fixed or extended. NO for explanations, concept " +
  "questions, a single small snippet/function/algorithm, debugging code the user pasted, or general conversation.";

/** "Build me a … app/site/dashboard" is unambiguous — no probe (saves a model round trip, and a
 *  probe that times out must not turn a clear build request into a plain chat reply). */
const CLEAR_BUILD =
  /\b(build|create|make|develop|generate|scaffold|code|design|set ?up)\b[^.?!\n]{0,60}\b(app|apps|website|web ?site|web ?app|webpage|landing page|dashboard|full[- ]?stack|saas|backend|back-end|rest api|api server|crm|portfolio|platform|mvp|clone|game|admin panel|e-?commerce|storefront)\b/i;

export async function detectBuildIntent(content: string, hasProject: boolean): Promise<boolean> {
  const text = content.trim();
  if (!text) return false;
  if (hasProject && PROJECT_FOLLOWUP.test(text)) return true;
  // "Fix the login bug in github.com/acme/app", "add tests to https://github.com/x/y" — work on a real repo.
  if (findGitHubRepoUrl(text) && ACTION_WORDS.test(text) && !/\b(explain|what is|what does|summari[sz]e|review)\b/i.test(text)) return true;
  // "Open a PR with these changes" on an existing (imported) project.
  if (hasProject && /\b(open|create|raise|make|send)\b[^.?!\n]{0,20}\b(pr|pull request)\b/i.test(text)) return true;
  if (CLEAR_BUILD.test(text) && !/\b(explain|what is|how (do|does|to)|difference between|why)\b/i.test(text)) return true;
  const gated = ACTION_WORDS.test(text) && (PROJECT_WORDS.test(text) || (hasProject && text.length < 300));
  if (!gated) return false;

  try {
    const candidate = rankCandidatesForMessage(await listChatCandidates(), text)[0];
    if (!candidate) return false;
    const adapter = getProviderAdapter(candidate.slug);
    const apiKey = await getWorkingKeyForProvider(candidate.slug);
    const probe: ChatMessage[] = [
      { role: "system", content: PROBE_PROMPT + (hasProject ? " A project already exists in this chat, so edits/fixes/additions to it are YES." : "") },
      { role: "user", content: text.slice(0, 1500) },
    ];
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS));
    const raw = await Promise.race([meteredChat(candidate, probe, () => adapter.chat(apiKey, candidate.modelId, probe), { chargeable: false }), timeout]);
    return /^\s*yes/i.test(raw);
  } catch {
    return false;
  }
}
