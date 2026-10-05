import { entitlementsFor } from "../quota/entitlements.js";
import { runTurn } from "../jobs/runTurn.js";
import { PHONE_BEHAVIOR } from "../phone/policy.js";
import { deliverResult } from "../phone/delivery.js";
import { getPhoneConfig } from "../phone/store.js";
import type { DeliveryChannel } from "../phone/policy.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { callbackIfWanted } from "../phone/callback.js";

const halted = new Set<string>();
const running = new Set<string>();

export function haltAirJob(conversationId: string) {
  halted.add(conversationId);
}

function needsLogin(text: string) {
  return /\b(sign in|log in|login|password|passcode|captcha|verification code)\b/i.test(text);
}

function finished(text: string) {
  return /\b(done|finished|blocked|stopping|can't continue|cannot continue)\b/i.test(text.slice(-600));
}

/**
 * An Air Dot keeps going in the same conversation until the work is done, the person says rukho,
 * or the usage meter stops the turn. It is not a scheduled automation.
 */
export async function runAirJob(userId: string, conversationId: string, task: string) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  if (running.has(conversationId)) return { started: false, reason: "already-running" as const };
  running.add(conversationId);
  halted.delete(conversationId);
  const rounds = Math.min(12, (await entitlementsFor(userId)).buildMaxRounds || 12);
  let last = "";
  let login = false;
  try {
    for (let step = 0; step < rounds; step += 1) {
      if (halted.has(conversationId)) break;
      const content = step === 0 ? task : "Continue until this is done. If you are blocked or need a login, say so and stop.";
      const result = await runTurn({
        userId,
        conversationId,
        kind: "chat",
        request: {
          content,
          inputMode: "text",
          think: false,
          behavior: PHONE_BEHAVIOR,
          webSearch: false,
          canvas: false,
          options: {},
          hadAttachments: false,
        },
        attachments: [],
      });
      last = result.text.trim();
      if (result.failed || result.aborted || halted.has(conversationId)) break;
      if (needsLogin(last)) {
        login = true;
        break;
      }
      if (finished(last) || !last) break;
    }
  } finally {
    running.delete(conversationId);
  }
  if (last) {
    const config = getPhoneConfig();
    const channels: DeliveryChannel[] = ["app"];
    if (config.channels.telegram) channels.push("telegram");
    if (config.channels.whatsapp) channels.push("whatsapp");
    if (config.channels.email) channels.push("email");
    await deliverResult(userId, null, login ? `Friday needs you on the screen. ${last}` : last, channels, config);
    if (!login) await callbackIfWanted(userId, last);
  }
  return { started: true, login, text: last };
}
