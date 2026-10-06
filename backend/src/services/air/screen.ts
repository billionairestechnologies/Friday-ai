import { HttpError } from "../../middleware/errorHandler.js";
import { getOwnedConversation } from "../chat/conversations.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { browserAction } from "../browser/session.js";
import { assertFetchableUrl } from "../agent/safeFetch.js";
import { ensurePreview, touchSandbox, writeSandboxFile } from "../projectBuild/sandbox.js";
import { recordAction } from "./gate.js";

/**
 * The screen: the same browser the Air Dot drives, shown on the web and in the phone app, and usable
 * by the person — mouse or a finger as the cursor, a keyboard, a URL bar. Logins happen here, never in
 * chat or on the call. Looking at it keeps the machine awake (charged to the daily awake minutes);
 * when they leave and the job is idle, the machine pauses on its own.
 */

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;

async function requireAirChat(userId: string, conversationId: string) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  await getOwnedConversation(userId, conversationId);
}

export async function getScreen(userId: string, conversationId: string) {
  await requireAirChat(userId, conversationId);
  const shot = await browserAction(conversationId, { action: "screenshot" }, { create: false }).catch((err: unknown) => {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  });
  // No browser yet: show the app being built in this chat, if any (the Build preview).
  if (!shot || !shot.image) {
    await touchSandbox(conversationId, userId).catch(() => undefined);
    const preview = await ensurePreview(userId, conversationId).catch(() => ({ url: null, port: null }));
    return { mode: preview.url ? ("preview" as const) : ("idle" as const), preview: preview.url, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
  }
  return { mode: "browser" as const, image: shot.image, url: shot.url ?? null, title: shot.title ?? null, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
}

export type ScreenInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "open"; url: string }
  | { type: "back" };

const KEYS = new Set(["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", "Delete"]);

/** Pure; tested. Clamp and whitelist what the person's cursor and keys can send to the daemon. */
export function toDaemonCommand(input: ScreenInput): Record<string, unknown> {
  switch (input.type) {
    case "click":
      return { action: "click_at", x: Math.round(Math.max(0, Math.min(SCREEN_WIDTH, input.x))), y: Math.round(Math.max(0, Math.min(SCREEN_HEIGHT, input.y))) };
    case "type":
      return { action: "type_text", text: input.text.slice(0, 2000) };
    case "key":
      if (!KEYS.has(input.key)) throw new HttpError(400, "That key isn't supported.");
      return { action: "press", key: input.key };
    case "scroll":
      return { action: "scroll", direction: input.direction === "up" ? "up" : "down" };
    case "open":
      return { action: "open", url: assertFetchableUrl(input.url).toString() };
    case "back":
      return { action: "back" };
  }
}

export async function screenInput(userId: string, conversationId: string, input: ScreenInput) {
  await requireAirChat(userId, conversationId);
  const command = toDaemonCommand(input);
  // The person's own clicks are recorded too (never the text they type — it may be a password).
  void recordAction({
    userId,
    conversationId,
    kind: "browser",
    name: "person",
    detail: input.type === "type" ? `typed ${input.text.length} characters` : JSON.stringify(command),
    decision: "allowed",
  });
  const after = await browserAction(conversationId, command, { create: input.type === "open" });
  if (!after.ok) throw new HttpError(502, after.error ?? "The screen didn't respond.");
  return getScreen(userId, conversationId);
}

/** A file dropped onto the screen goes into the person's Air Dots machine. */
export async function dropOnScreen(userId: string, conversationId: string, name: string, content: string) {
  await requireAirChat(userId, conversationId);
  const safe = name.replace(/[^\w.-]+/g, "-").slice(0, 80) || "drop.txt";
  await writeSandboxFile(userId, conversationId, `inbox/${safe}`, content);
  void recordAction({ userId, conversationId, kind: "file", name: "person", detail: `dropped inbox/${safe}`, decision: "allowed" });
  return { name: `inbox/${safe}` };
}
