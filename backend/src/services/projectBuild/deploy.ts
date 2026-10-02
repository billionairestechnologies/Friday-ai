import { HttpError } from "../../middleware/errorHandler.js";
import { isTurnRunning } from "../jobs/turns.js";
import { insertAssistantMessage } from "../chat/conversations.js";
import { loadTokenCredentials } from "../connectorService.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { BuildSandbox, getProject, tail } from "./sandbox.js";
import { loadSecrets, redactSecrets } from "./secrets.js";

/**
 * One-click deploy to Vercel with the user's connected Vercel account (Plugins → Vercel). Runs the
 * Vercel CLI inside the project's sandbox as a trusted server-built script: the token and the
 * project's secrets travel as environment variables only (never in the command line, never shown to
 * the model) and are scrubbed from the output. The Deploy button is the user's explicit approval.
 */
const DEPLOY_SCRIPT = [
  "set -e",
  'cd "$FRIDAY_DIR"',
  // Project secrets become Vercel production env vars so the deployed app has them too.
  'for name in $FRIDAY_SECRET_NAMES; do printf "%s" "${!name}" | npx -y vercel@latest env add "$name" production --token "$VERCEL_TOKEN" --yes >/dev/null 2>&1 || true; done',
  'npx -y vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN" --name "$FRIDAY_NAME" 2>&1',
].join("\n");

export async function deployToVercel(userId: string, conversationId: string): Promise<{ url: string }> {
  if (await isTurnRunning(conversationId)) throw new HttpError(409, "Wait for the build to finish (or stop it) before deploying.");
  const project = await getProject(conversationId);
  if (!project || Object.keys(project.files ?? {}).length === 0) throw new HttpError(400, "Nothing to deploy yet — build the project first.");
  let token: string;
  try {
    token = (await loadTokenCredentials(userId, "vercel")).token;
  } catch {
    throw new HttpError(400, "Connect your Vercel account first (Plugins → Vercel), then deploy.");
  }

  const { data: conv } = await supabaseAdmin.from("conversations").select("title").eq("id", conversationId).maybeSingle();
  const name = ((conv?.title as string | undefined) ?? "friday-app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "friday-app";

  const secrets = await loadSecrets(conversationId);
  const box = await BuildSandbox.open(userId, conversationId);
  box.useEnv(secrets);
  const out = await box.runScript(DEPLOY_SCRIPT, 10 * 60_000, {
    ...secrets,
    VERCEL_TOKEN: token,
    FRIDAY_DIR: "/home/user/app",
    FRIDAY_NAME: name,
    FRIDAY_SECRET_NAMES: Object.keys(secrets).join(" "),
  });
  const output = redactSecrets(out.output, { ...secrets, VERCEL_TOKEN: token });
  const url = [...output.matchAll(/https:\/\/[a-z0-9.-]+\.vercel\.app\b/gi)].map((m) => m[0]).pop();
  if (!out.ok || !url) throw new HttpError(502, `The deploy didn't finish:\n${tail(output, 1500)}`);

  await insertAssistantMessage(conversationId, `🚀 Deployed to Vercel: ${url}`, "Build", { usedCanvas: false, usedSearch: false, usedThink: false });
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  return { url };
}
