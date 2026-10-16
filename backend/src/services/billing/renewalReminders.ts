import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import { brandedEmail, fromAddress, mailConfigured, renderMarkdown, sendEmail } from "../console/mail.js";
import { notifyUser } from "../pushService.js";

function planExpiryGraceMs(): number {
  return 0;
}

/**
 * Tells people before their paid plan ends. Since migration 0054 a plan lapses to Free after
 * plan_renews_at (+ a grace window), and checkout sells one-time orders with no auto-renew, so without
 * this the first sign of an ending plan was losing it.
 *
 *   3d     — three days before the end date
 *   1d     — one day before
 *   ended  — once the end date has passed and the plan is in its grace window
 *
 * A booked lower plan (scheduled_plan) changes the wording: nothing to renew, just "Premium ends on
 * X, Pro starts then". Each reminder is claimed by inserting its plan_reminders row first (primary key
 * = person + end date + kind), so it sends at most once per period across every instance and restart.
 * Transactional mail: sent even to people who opted out of product email.
 */

export type ReminderKind = "3d" | "1d" | "ended";

const HOUR = 60 * 60 * 1000;

/** Which reminder is due right now for a plan ending at `end` (null = none). Pure; tested. */
export function dueReminder(end: Date, now: Date, graceMs: number): ReminderKind | null {
  const left = end.getTime() - now.getTime();
  if (left <= 0) return -left < graceMs ? "ended" : null;
  if (left <= 24 * HOUR) return "1d";
  if (left <= 72 * HOUR) return "3d";
  return null;
}

const PLAN_NAME: Record<string, string> = { pro: "Pro", premium: "Premium" };

export function reminderCopy(input: { kind: ReminderKind; plan: string; end: Date; scheduledPlan: string | null; graceHours: number; appUrl: string }) {
  const name = PLAN_NAME[input.plan] ?? input.plan;
  const when = input.end.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const plansUrl = `${input.appUrl.replace(/\/+$/, "")}/plans`;
  if (input.scheduledPlan) {
    const next = PLAN_NAME[input.scheduledPlan] ?? input.scheduledPlan;
    return {
      subject: `Your ${name} plan ends on ${when} — ${next} starts then`,
      push: `${name} ends ${when}. Your ${next} plan starts right after.`,
      markdown: `Your Friday **${name}** plan ends on **${when}**.\n\nYou already booked **${next}**, so it starts the moment ${name} ends. There is nothing you need to do.\n\nWant to stay on ${name} instead? Buy it again before ${when} and ${next} moves to after it.`,
      cta: { label: "See your plan", url: plansUrl },
    };
  }
  if (input.kind === "ended") {
    return {
      subject: `Your ${name} plan has ended`,
      push: `${name} ended. Renew in the next ${input.graceHours} hours to keep your limits.`,
      markdown: `Your Friday **${name}** plan ended on **${when}**.\n\nYou keep ${name} limits for **${input.graceHours} more hours**. After that your account moves to Free. Your chats, files and projects stay, only the limits change.\n\nRenew now to keep going without a break.`,
      cta: { label: `Renew ${name}`, url: plansUrl },
    };
  }
  const inWords = input.kind === "1d" ? "tomorrow" : "in 3 days";
  return {
    subject: `Your ${name} plan ends ${inWords}`,
    push: `${name} ends ${inWords} (${when}). Renew to keep your limits.`,
    markdown: `Your Friday **${name}** plan ends **${inWords}**, on **${when}**.\n\nFriday plans don't renew on their own. Renew before then to keep your ${name} limits and models. If you renew early, the new month is added to the end, so you don't lose any days.\n\nIf you do nothing, your account moves to Free after it ends. Your chats, files and projects stay.`,
    cta: { label: `Renew ${name}`, url: plansUrl },
  };
}

type Row = { id: string; plan: string; plan_renews_at: string; scheduled_plan?: string | null };

async function emailFor(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.auth.admin.getUserById(userId).catch(() => ({ data: null }));
  return data?.user?.email ?? null;
}

async function sendOne(row: Row, kind: ReminderKind): Promise<boolean> {
  const end = new Date(row.plan_renews_at);
  // An ended plan with a booked successor rolls over (planSchedule) — the 1d note already said so.
  if (kind === "ended" && row.scheduled_plan) return false;
  // Claim first: the insert either wins (we send) or hits the primary key (someone already did).
  const { error: claimError } = await supabaseAdmin
    .from("plan_reminders")
    .insert({ user_id: row.id, period_end: row.plan_renews_at, kind, plan: row.plan });
  if (claimError) {
    if (claimError.code !== "23505") logger.warn("plan_reminder_claim_failed", { userId: row.id, error: claimError.message });
    return false;
  }
  const copy = reminderCopy({
    kind,
    plan: row.plan,
    end,
    scheduledPlan: row.scheduled_plan ?? null,
    graceHours: Math.round(planExpiryGraceMs() / HOUR),
    appUrl: env.publicAppUrl,
  });
  const channels: string[] = [];
  const to = await emailFor(row.id);
  if (to && mailConfigured()) {
    try {
      const from = await fromAddress({ purpose: "general" });
      await sendEmail({
        ...from,
        to,
        subject: copy.subject,
        html: brandedEmail({ heading: copy.subject, preheader: copy.push, bodyHtml: renderMarkdown(copy.markdown), cta: copy.cta }),
      });
      channels.push("email");
    } catch (err) {
      logger.warn("plan_reminder_email_failed", { userId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await notifyUser(row.id, { title: copy.subject, body: copy.push })
    .then(() => channels.push("push"))
    .catch(() => undefined);
  await supabaseAdmin
    .from("plan_reminders")
    .update({ channels })
    .eq("user_id", row.id)
    .eq("period_end", row.plan_renews_at)
    .eq("kind", kind);
  return channels.length > 0;
}

/** One pass: every paid plan ending within 3 days (or just ended, inside the grace window). */
export async function sendDueRenewalReminders(now = new Date()): Promise<number> {
  const grace = planExpiryGraceMs();
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .in("plan", ["pro", "premium"])
    .gt("plan_renews_at", new Date(now.getTime() - grace).toISOString())
    .lte("plan_renews_at", new Date(now.getTime() + 72 * HOUR).toISOString())
    .limit(1000);
  if (error) throw new Error(error.message);
  let sent = 0;
  for (const row of (data ?? []) as Row[]) {
    const kind = dueReminder(new Date(row.plan_renews_at), now, grace);
    if (!kind) continue;
    // A person with an active console grant gets their plan from the grant, not a purchase.
    const { count } = await supabaseAdmin.from("access_grants").select("id", { count: "exact", head: true }).eq("user_id", row.id).eq("status", "active");
    if (count) continue;
    if (await sendOne(row, kind).catch(() => false)) sent++;
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;
/** Hourly. FRIDAY_DISABLE_RENEWAL_REMINDERS=1 turns it off. */
export function startRenewalReminders(intervalMs = 60 * 60_000) {
  if (timer || process.env.FRIDAY_DISABLE_RENEWAL_REMINDERS) return;
  const run = () =>
    void sendDueRenewalReminders()
      .then((n) => n && logger.info("plan_reminders_sent", { count: n }))
      .catch((err) => logger.warn("plan_reminders_failed", { error: err instanceof Error ? err.message : String(err) }));
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 60_000).unref?.();
}
