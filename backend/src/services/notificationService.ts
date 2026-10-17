import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { logger } from "../utils/logger.js";
import { notifyUser } from "./pushService.js";
import { brandedEmail, fromAddress, mailConfigured, renderMarkdown, sendEmail, unsubscribeUrl } from "./console/mail.js";
import { env } from "../config/env.js";

/**
 * One person's notifications (supabase 0060 user_notifications + 0062 popups): the inbox, the
 * one-time benefit popups, push, and email. Every user-facing notice goes through notify() so the
 * rules live in one place:
 *
 *   * written only AFTER the thing it announces has committed (callers' job; documented there)
 *   * deduped by `dedupe` (a retried grant never notifies twice)
 *   * email category: 'account' (benefits granted to this person, programme decisions) is always
 *     sent; 'marketing' (promotional/campaign grants) respects profiles.marketing_opt_out and
 *     carries the one-click unsubscribe link. Mail failures never fail the caller.
 */

export type NotifyInput = {
  kind: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  dedupe: string;
  /** Show once as a popup in the app (benefits), not just in the inbox. */
  popup?: boolean;
  email?: { category: "account" | "marketing"; cta?: { label: string; path: string } } | null;
};

export async function notify(userId: string, n: NotifyInput): Promise<{ created: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("user_notifications")
    .upsert({ user_id: userId, kind: n.kind, title: n.title, body: n.body, data: n.data ?? {}, dedupe_key: n.dedupe, popup: Boolean(n.popup) }, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select("id");
  if (error) {
    logger.error("notification_write_failed", { kind: n.kind, dedupe: n.dedupe, error: error.message });
    return { created: false };
  }
  const created = (data ?? []).length > 0;
  if (!created) return { created: false }; // already notified (retry / duplicate)
  await notifyUser(userId, { title: n.title, body: n.body }).catch(() => undefined);
  if (n.email) await emailUser(userId, n).catch((err) => logger.error("notification_email_failed", { kind: n.kind, error: err instanceof Error ? err.message : String(err) }));
  return { created: true };
}

async function emailUser(userId: string, n: NotifyInput) {
  if (!mailConfigured() || !n.email) return;
  const [{ data: auth }, { data: profile }] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(userId),
    supabaseAdmin.from("profiles").select("marketing_opt_out, full_name").eq("id", userId).maybeSingle(),
  ]);
  const to = auth?.user?.email;
  if (!to) return;
  const marketing = n.email.category === "marketing";
  if (marketing && profile?.marketing_opt_out) return;
  const sender = await fromAddress({ purpose: marketing ? "marketing" : "support" });
  const base = env.publicAppUrl.replace(/\/$/, "");
  const html = brandedEmail({
    heading: n.title,
    bodyHtml: renderMarkdown(n.body),
    cta: n.email.cta ? { label: n.email.cta.label, url: `${base}${n.email.cta.path}` } : null,
    unsubscribeUrl: marketing ? unsubscribeUrl(userId) : null,
  });
  await sendEmail({ ...sender, to, subject: n.title, html, ...(marketing ? { headers: { "List-Unsubscribe": `<${unsubscribeUrl(userId)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}) });
}

export type InboxItem = { id: string; kind: string; title: string; body: string; data: Record<string, unknown>; createdAt: string; read: boolean };

export async function inbox(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_notifications")
    .select("id, kind, title, body, data, created_at, seen_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return { items: [], unread: 0 };
    throw new HttpError(500, error.message);
  }
  const items: InboxItem[] = (data ?? []).map((r) => ({ id: r.id as string, kind: r.kind as string, title: r.title as string, body: r.body as string, data: (r.data as Record<string, unknown>) ?? {}, createdAt: r.created_at as string, read: Boolean(r.seen_at) }));
  return { items, unread: items.filter((i) => !i.read).length };
}

export async function markRead(userId: string, ids: string[] | "all") {
  let q = supabaseAdmin.from("user_notifications").update({ seen_at: new Date().toISOString() }).eq("user_id", userId).is("seen_at", null);
  if (ids !== "all") q = q.in("id", ids);
  const { error } = await q;
  if (error) throw new HttpError(500, error.message);
}

/** Benefit popups not shown yet (newest first, at most 3, from the last 30 days). */
export async function pendingPopups(userId: string) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("user_notifications")
    .select("id, kind, title, body, data, created_at")
    .eq("user_id", userId)
    .eq("popup", true)
    .is("displayed_at", null)
    .is("acknowledged_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) {
    if (/does not exist|schema cache|column/i.test(error.message)) return [];
    throw new HttpError(500, error.message);
  }
  return (data ?? []).map((r) => ({ id: r.id as string, kind: r.kind as string, title: r.title as string, body: r.body as string, data: (r.data as Record<string, unknown>) ?? {}, createdAt: r.created_at as string }));
}

/** true = this tab/device shows it now; false = it was already shown somewhere. */
export async function claimPopup(userId: string, id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("notification_claim", { p_notification: id, p_user: userId });
  if (error) throw new HttpError(500, error.message);
  return data === true;
}

export async function acknowledge(userId: string, id: string) {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("user_notifications").update({ acknowledged_at: now }).eq("id", id).eq("user_id", userId).is("acknowledged_at", null);
  if (error) throw new HttpError(500, error.message);
}
