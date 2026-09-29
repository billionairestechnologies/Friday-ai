import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";

/**
 * The Privacy Policy / Terms of Service currently in force, dated by the day they last
 * materially changed. Bump this (to today's date) whenever the policy text in
 * frontend/src/lib/site/legal.ts changes in a way users should re-agree to — every account
 * whose `policy_version` doesn't match this gets the blocking "I agree" gate again on next
 * open, on web, Android and iOS alike. Trivial wording/typo fixes don't need a bump.
 */
export const POLICY_VERSION = "2026-09-29";

export type Platform = "web" | "android" | "ios";

/** Whether `accountVersion` (a user's `profiles.policy_version`, possibly null) satisfies the
 *  currently-in-force policy. Never accepted, or accepted an older version, both mean "no". */
export function policyIsCurrent(accountVersion: string | null | undefined): boolean {
  return accountVersion === POLICY_VERSION;
}

/** Records acceptance for the signed-in user: appends to the audit trail and updates the fast
 *  "current status" columns on profiles. Called from the signup form's own checkbox (immediately,
 *  for a brand-new account) and from the blocking gate every client shows an existing account
 *  that agreed to an older (or no) version. */
export async function acceptPolicy(userId: string, platform: Platform): Promise<{ policyVersion: string; policyAcceptedAt: string }> {
  const acceptedAt = new Date().toISOString();

  const { error: historyError } = await supabaseAdmin
    .from("policy_acceptances")
    .insert({ user_id: userId, policy_version: POLICY_VERSION, platform, accepted_at: acceptedAt });
  if (historyError) throw new HttpError(500, historyError.message);

  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .update({ policy_version: POLICY_VERSION, policy_accepted_at: acceptedAt })
    .eq("id", userId);
  if (profileError) throw new HttpError(500, profileError.message);

  return { policyVersion: POLICY_VERSION, policyAcceptedAt: acceptedAt };
}
