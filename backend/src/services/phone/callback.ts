import { supabaseAdmin } from "../../config/supabase.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { openCallRecord } from "./calls.js";
import { quietNow } from "./policy.js";
import { getUserPhoneSettings, usedCallSeconds } from "./store.js";
import { dialAccount } from "./trunk.js";

/**
 * Friday rings the person: Call now on the website, a callback when an Air Dot finishes, or an urgent
 * login/approval nobody answered. Every one checks the plan's call minutes and the person's quiet
 * hours (an urgent ask may break quiet hours, never the minutes). The greeting waits on the
 * air_calls row (status 'dialing') until the trunk says the phone was picked up.
 */
export async function placeCall(
  userId: string,
  opts: { direction: "outbound" | "callback"; greeting: string; conversationId?: string | null; urgent?: boolean },
): Promise<{ placed: boolean; mode: "phone" | "browser" | "none"; reason?: string; callId?: string; trunk?: string }> {
  const ents = await entitlementsFor(userId);
  if (!ents.airDots || ents.airCallMinutes <= 0) return { placed: false, mode: "none", reason: "plan" };
  const used = await usedCallSeconds(userId);
  if (used >= ents.airCallMinutes * 60) return { placed: false, mode: "none", reason: "minutes" };
  const settings = await getUserPhoneSettings(userId);
  if (opts.direction === "callback" && !opts.urgent && quietNow(settings, new Date())) return { placed: false, mode: "none", reason: "quiet" };
  const profile = await supabaseAdmin.from("profiles").select("phone").eq("id", userId).maybeSingle();
  const phone = ((profile.data as { phone?: string | null } | null)?.phone ?? "").trim();
  if (!phone) return { placed: false, mode: "browser", reason: "no-phone" };
  const call = await openCallRecord({
    userId,
    direction: opts.direction,
    from: phone,
    conversationId: opts.conversationId ?? null,
    greeting: opts.greeting.slice(0, 600),
    status: "dialing",
  });
  const dial = await dialAccount(phone);
  if (dial.mode !== "phone") {
    // No trunk configured: the web On Air screen is the call. Close the dangling dial.
    await supabaseAdmin.from("air_calls").update({ status: "ended", direction: "browser", ended_at: new Date().toISOString() }).eq("id", call.id);
    return { placed: false, mode: "browser", reason: "no-trunk", callId: call.id };
  }
  await supabaseAdmin.from("air_calls").update({ trunk: dial.trunk }).eq("id", call.id);
  return { placed: true, mode: "phone", callId: call.id, trunk: dial.trunk };
}

/** When they asked to be called back, ring and say the result on pickup. */
export async function callbackIfWanted(userId: string, summary: string, opts: { urgent?: boolean; conversationId?: string | null } = {}) {
  const settings = await getUserPhoneSettings(userId);
  if (!settings.callback && !opts.urgent) return { placed: false as const, mode: "none" as const, reason: "off" };
  const greeting = `Friday here. ${summary.replace(/\s+/g, " ").slice(0, 480)}`;
  return placeCall(userId, { direction: "callback", greeting, conversationId: opts.conversationId, urgent: opts.urgent });
}
