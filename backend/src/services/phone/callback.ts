import { supabaseAdmin } from "../../config/supabase.js";
import { getUserPhoneSettings, hydrateUserPhone } from "./store.js";
import { dialAccount, queueCallback } from "./trunk.js";

/** When they asked to be called back, dial the account number and say the result on pickup. */
export async function callbackIfWanted(userId: string, summary: string) {
  await hydrateUserPhone(userId);
  if (!getUserPhoneSettings(userId).callback) return { placed: false as const };
  const profile = await supabaseAdmin.from("profiles").select("phone").eq("id", userId).maybeSingle();
  const phone = ((profile.data as { phone?: string | null } | null)?.phone ?? "").trim();
  if (!phone) return { placed: false as const, reason: "no-phone" as const };
  queueCallback(phone, summary);
  const dial = await dialAccount(phone);
  return { placed: dial.mode === "phone", trunk: dial.trunk };
}
