import { getProviderAdapter } from "../providers/registry.js";

/**
 * Build is a long agentic coding loop — plan, write dozens of files, read errors, fix — and only
 * top-tier coding models do that reliably. A "mini"/"flash" model in Build doesn't fail loudly, it
 * produces half-working projects and burns the user's quota, which is worse. So Build uses an
 * ALLOW-list (the chat side keeps its denylist, where an unfamiliar model is fine).
 *
 * FRIDAY_BUILD_MODELS (a regex, e.g. "claude-(opus|sonnet)|gpt-5") replaces the list without a deploy
 * of code when a new model ships.
 */
const DEFAULT_BUILD_MODELS =
  /(claude-(opus|sonnet)|claude-[3-9][.-]?\d*-(opus|sonnet)|\bgpt-5(?![\w.-]*(mini|nano))|\bgpt-4\.1(?![\w.-]*(mini|nano))|\bo3(?![\w.-]*mini)|\bo4(?![\w.-]*mini)|gemini-(2\.5|3(\.\d)?)-pro|grok-4(?![\w.-]*(mini|fast))|deepseek-(v3|r1|chat|reasoner)|qwen3-coder|kimi-k2|glm-4\.[5-9]|codestral|devstral|mistral-large)/i;

const LIGHTWEIGHT = /\b(mini|nano|lite|flash-8b|flash-lite|haiku|tiny|instant)\b/i;

function allowList(): RegExp {
  const custom = process.env.FRIDAY_BUILD_MODELS?.trim();
  if (custom) {
    try {
      return new RegExp(custom, "i");
    } catch {
      console.error("[build] FRIDAY_BUILD_MODELS is not a valid regex — using the default list");
    }
  }
  return DEFAULT_BUILD_MODELS;
}

function hasNativeTools(slug: string): boolean {
  try {
    return typeof getProviderAdapter(slug).chatStreamWithTools === "function";
  } catch {
    return false;
  }
}

/** Whether a model may drive the Build agent: native tool calling + on the frontier coding list. */
export function isBuildModel(m: { slug: string; modelId: string; displayName?: string }): boolean {
  const label = `${m.modelId} ${m.displayName ?? ""}`;
  return hasNativeTools(m.slug) && allowList().test(label) && !LIGHTWEIGHT.test(m.modelId);
}

/**
 * The candidates Build should run on, best first. Never empty when there is any candidate at all:
 * a deployment with no frontier key still gets a working Build (on the best it has) instead of a
 * dead workspace — the model picker is where the allow-list is enforced for users.
 */
export function buildCandidates<T extends { slug: string; modelId: string; displayName?: string }>(candidates: T[], isFrontier: (c: T) => boolean): T[] {
  const allowed = candidates.filter(isBuildModel);
  if (allowed.length) return allowed;
  const frontier = candidates.filter((c) => hasNativeTools(c.slug) && isFrontier(c));
  return frontier.length ? frontier : candidates;
}
