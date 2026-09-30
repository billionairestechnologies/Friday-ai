import { supabaseAdmin } from "../../config/supabase.js";
import { notifyUser } from "../pushService.js";

/**
 * Push notifications for Build sessions (the spec's "notify when the task finishes"): builds run for
 * minutes and keep going with the app closed, so tell the user when one is done or is waiting on
 * them. Uses the shared push service (web push + FCM); a no-op for users with no push subscription.
 */
async function titleOf(conversationId: string): Promise<string> {
  const { data } = await supabaseAdmin.from("conversations").select("title").eq("id", conversationId).maybeSingle();
  return (data?.title as string | undefined) || "Your build";
}

export async function notifyBuildFinished(userId: string, conversationId: string, outcome: "done" | "error"): Promise<void> {
  try {
    const title = await titleOf(conversationId);
    await notifyUser(userId, {
      title: outcome === "done" ? `✅ ${title}` : `⚠️ ${title}`,
      body: outcome === "done" ? "Your build is finished — open it to see the preview." : "Your build stopped with an error — open it to see what happened.",
      conversationId,
    });
  } catch {
    /* notifications are best-effort */
  }
}

export async function notifyBuildNeedsInput(userId: string, conversationId: string, what: string): Promise<void> {
  try {
    const title = await titleOf(conversationId);
    await notifyUser(userId, { title: `✋ ${title}`, body: `Friday needs your OK: ${what}`.slice(0, 140), conversationId });
  } catch {
    /* notifications are best-effort */
  }
}
