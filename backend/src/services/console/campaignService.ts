import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { newUserSince } from "./directory.js";
import { RESEND_BATCH_MAX, brandedEmail, fromAddress, mailConfigured, renderMarkdown, sendEmail, sendEmailBatch, unsubscribeUrl } from "./mail.js";

/**
 * Marketing email campaigns. Sending is a background job, not a request: the audience is walked in
 * keyset pages, every recipient gets a row in email_campaign_sends BEFORE the mail goes out, and only
 * 'pending' rows are sent — so a crash, a redeploy or a second instance picking the same campaign
 * never emails anyone twice, and a stopped send resumes where it left off. Opted-out users are never
 * in the audience (console_campaign_audience filters them).
 */

type Audience = "all" | "free" | "paid" | "pro" | "premium" | "new_users";

export type CampaignInput = {
  name: string;
  subject: string;
  preheader?: string;
  bodyMarkdown: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  audience: Audience;
  fromIdentityId?: string | null;
  announcementId?: string | null;
};

function toRow(input: Partial<CampaignInput>) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) row.name = input.name;
  if (input.subject !== undefined) row.subject = input.subject;
  if (input.preheader !== undefined) row.preheader = input.preheader;
  if (input.bodyMarkdown !== undefined) row.body_markdown = input.bodyMarkdown;
  if (input.ctaLabel !== undefined) row.cta_label = input.ctaLabel || null;
  if (input.ctaUrl !== undefined) row.cta_url = input.ctaUrl || null;
  if (input.audience !== undefined) row.audience = input.audience;
  if (input.fromIdentityId !== undefined) row.from_identity_id = input.fromIdentityId || null;
  if (input.announcementId !== undefined) row.announcement_id = input.announcementId || null;
  return row;
}

export async function listCampaigns() {
  const { data, error } = await supabaseAdmin.from("email_campaigns").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function getCampaign(id: string) {
  const { data, error } = await supabaseAdmin.from("email_campaigns").select("*").eq("id", id).maybeSingle();
  if (error || !data) throw new HttpError(404, "Campaign not found");
  return data;
}

export async function createCampaign(input: CampaignInput, userId: string) {
  const { data, error } = await supabaseAdmin.from("email_campaigns").insert({ ...toRow(input), created_by: userId }).select().single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't create the campaign");
  return data;
}

export async function updateCampaign(id: string, input: Partial<CampaignInput>) {
  const current = await getCampaign(id);
  if (current.status === "sending" || current.status === "sent") throw new HttpError(400, "A campaign that has been sent can't be edited — duplicate it instead");
  const { data, error } = await supabaseAdmin.from("email_campaigns").update(toRow(input)).eq("id", id).select().single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't save");
  return data;
}

export async function deleteCampaign(id: string) {
  const current = await getCampaign(id);
  if (current.status === "sending") throw new HttpError(400, "Wait for the send to finish");
  const { error } = await supabaseAdmin.from("email_campaigns").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
}

async function audiencePage(audience: string, after: string | null, limit: number) {
  const { data, error } = await supabaseAdmin.rpc("console_campaign_audience", {
    p_audience: audience,
    p_new_since: newUserSince(),
    p_after: after,
    p_limit: limit,
  });
  if (error) throw new HttpError(500, `Audience query failed (is migration 0031 applied?): ${error.message}`);
  return (data ?? []) as { id: string; email: string; full_name: string | null }[];
}

/** Recipient count for the composer ("This goes to 1,284 people"). */
export async function countAudience(audience: string): Promise<number> {
  let total = 0;
  let after: string | null = null;
  for (;;) {
    const page = await audiencePage(audience, after, 1000);
    total += page.length;
    if (page.length < 1000) return total;
    after = page[page.length - 1]!.id;
  }
}

function personalize(text: string, name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0] || "there";
  return text.replace(/\{\{\s*first_name\s*\}\}/gi, first).replace(/\{\{\s*name\s*\}\}/gi, name?.trim() || "there");
}

type CampaignRow = Awaited<ReturnType<typeof getCampaign>>;

function renderFor(campaign: CampaignRow, recipient: { id: string; name: string | null }) {
  const unsubscribe = unsubscribeUrl(recipient.id);
  const html = brandedEmail({
    bodyHtml: renderMarkdown(personalize(campaign.body_markdown as string, recipient.name)),
    preheader: (campaign.preheader as string) || undefined,
    cta: campaign.cta_label && campaign.cta_url ? { label: campaign.cta_label as string, url: campaign.cta_url as string } : null,
    unsubscribeUrl: unsubscribe,
    footerNote: "You're getting this because you have a Friday account.",
  });
  return {
    subject: personalize(campaign.subject as string, recipient.name),
    html,
    // RFC 8058 one-click unsubscribe — Gmail/Yahoo bulk-sender requirement.
    headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

export async function sendTest(id: string, to: string, name: string | null, userId: string) {
  if (!mailConfigured()) throw new HttpError(400, "Email isn't configured (RESEND_API_KEY)");
  const campaign = await getCampaign(id);
  const sender = await fromAddress({ identityId: campaign.from_identity_id as string | null, purpose: "marketing" });
  const rendered = renderFor(campaign, { id: userId, name });
  await sendEmail({ ...sender, to, subject: `[Test] ${rendered.subject}`, html: rendered.html, headers: rendered.headers });
}

/** Queue now (or at `scheduledAt`). The scheduler picks it up; nothing is sent in the request. */
export async function scheduleCampaign(id: string, scheduledAt: string | null) {
  if (!mailConfigured()) throw new HttpError(400, "Email isn't configured (RESEND_API_KEY)");
  const campaign = await getCampaign(id);
  if (campaign.status === "sending" || campaign.status === "sent") throw new HttpError(400, "Already sent");
  if (!(campaign.subject as string).trim() || !(campaign.body_markdown as string).trim()) throw new HttpError(400, "Add a subject and a message first");
  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .update({ status: "scheduled", scheduled_at: scheduledAt ?? new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null })
    .eq("id", id)
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't schedule");
  void runDueCampaigns();
  return data;
}

export async function cancelSchedule(id: string) {
  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .update({ status: "draft", scheduled_at: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "scheduled")
    .select()
    .single();
  if (error || !data) throw new HttpError(400, "Only a scheduled campaign can be cancelled");
  return data;
}

/** Enqueue every recipient (idempotent), then send pending ones in batches. */
async function deliver(campaign: CampaignRow) {
  let after: string | null = null;
  for (;;) {
    const page = await audiencePage(campaign.audience as string, after, 1000);
    if (page.length) {
      await supabaseAdmin
        .from("email_campaign_sends")
        .upsert(page.map((r) => ({ campaign_id: campaign.id, user_id: r.id, email: r.email })), { onConflict: "campaign_id,user_id", ignoreDuplicates: true });
    }
    if (page.length < 1000) break;
    after = page[page.length - 1]!.id;
  }
  const { count: total } = await supabaseAdmin.from("email_campaign_sends").select("user_id", { count: "exact", head: true }).eq("campaign_id", campaign.id);
  await supabaseAdmin.from("email_campaigns").update({ total_recipients: total ?? 0 }).eq("id", campaign.id);

  const sender = await fromAddress({ identityId: campaign.from_identity_id as string | null, purpose: "marketing" });
  const names = new Map<string, string | null>();
  for (;;) {
    const { data: pending } = await supabaseAdmin
      .from("email_campaign_sends")
      .select("user_id, email")
      .eq("campaign_id", campaign.id)
      .eq("status", "pending")
      .limit(RESEND_BATCH_MAX);
    if (!pending || pending.length === 0) break;
    const missing = pending.map((p) => p.user_id as string).filter((id) => !names.has(id));
    if (missing.length) {
      const { data: profiles } = await supabaseAdmin.from("profiles").select("id, full_name").in("id", missing);
      for (const id of missing) names.set(id, ((profiles ?? []).find((p) => p.id === id)?.full_name as string | null) ?? null);
    }
    const messages = pending.map((p) => {
      const rendered = renderFor(campaign, { id: p.user_id as string, name: names.get(p.user_id as string) ?? null });
      return { ...sender, to: p.email as string, subject: rendered.subject, html: rendered.html, headers: rendered.headers };
    });
    const ids = pending.map((p) => p.user_id as string);
    try {
      await sendEmailBatch(messages);
      await supabaseAdmin.from("email_campaign_sends").update({ status: "sent", sent_at: new Date().toISOString() }).eq("campaign_id", campaign.id).in("user_id", ids);
    } catch (err) {
      const message = err instanceof Error ? err.message : "send failed";
      await supabaseAdmin.from("email_campaign_sends").update({ status: "failed", error: message.slice(0, 500) }).eq("campaign_id", campaign.id).in("user_id", ids);
      await supabaseAdmin.from("email_campaigns").update({ last_error: message.slice(0, 500) }).eq("id", campaign.id);
    }
    const [{ count: sent }, { count: failed }] = await Promise.all([
      supabaseAdmin.from("email_campaign_sends").select("user_id", { count: "exact", head: true }).eq("campaign_id", campaign.id).eq("status", "sent"),
      supabaseAdmin.from("email_campaign_sends").select("user_id", { count: "exact", head: true }).eq("campaign_id", campaign.id).eq("status", "failed"),
    ]);
    // updated_at doubles as the heartbeat: a live send never looks "stuck" to another instance's resume check.
    await supabaseAdmin
      .from("email_campaigns")
      .update({ sent_count: sent ?? 0, failed_count: failed ?? 0, updated_at: new Date().toISOString() })
      .eq("id", campaign.id);
    // Stay well under the provider's rate limit.
    await new Promise((r) => setTimeout(r, 600));
  }
  const { count: sentTotal } = await supabaseAdmin.from("email_campaign_sends").select("user_id", { count: "exact", head: true }).eq("campaign_id", campaign.id).eq("status", "sent");
  const finalStatus = (total ?? 0) > 0 && !sentTotal ? "failed" : "sent";
  await supabaseAdmin.from("email_campaigns").update({ status: finalStatus, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", campaign.id);
}

let running = false;

/**
 * Claims due campaigns atomically (scheduled → sending in one conditional UPDATE, so two instances
 * can't both claim one) and delivers them. Also resumes a campaign stuck in 'sending' after a restart.
 */
export async function runDueCampaigns(): Promise<void> {
  if (running || !mailConfigured()) return;
  running = true;
  try {
    const nowIso = new Date().toISOString();
    const { data: due } = await supabaseAdmin.from("email_campaigns").select("id").eq("status", "scheduled").lte("scheduled_at", nowIso).limit(5);
    for (const row of due ?? []) {
      const { data: claimed } = await supabaseAdmin
        .from("email_campaigns")
        .update({ status: "sending", updated_at: nowIso })
        .eq("id", row.id)
        .eq("status", "scheduled")
        .select()
        .maybeSingle();
      if (!claimed) continue;
      await deliver(claimed).catch(async (err) => {
        await supabaseAdmin
          .from("email_campaigns")
          .update({ status: "failed", last_error: (err instanceof Error ? err.message : "failed").slice(0, 500) })
          .eq("id", row.id);
      });
    }
    // Resume sends orphaned by a restart (no progress for 10 minutes).
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: stuck } = await supabaseAdmin.from("email_campaigns").select("*").eq("status", "sending").lt("updated_at", stale).limit(2);
    for (const campaign of stuck ?? []) {
      await supabaseAdmin.from("email_campaigns").update({ updated_at: new Date().toISOString() }).eq("id", campaign.id);
      await deliver(campaign).catch(() => {});
    }
  } catch (err) {
    console.error("[campaigns] scheduler tick failed:", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;
/** In-process scheduler (FRIDAY_DISABLE_CAMPAIGNS=1 turns it off on an instance). */
export function startCampaignScheduler(intervalMs = 60_000) {
  if (timer || process.env.FRIDAY_DISABLE_CAMPAIGNS) return;
  timer = setInterval(() => void runDueCampaigns(), intervalMs);
  timer.unref?.();
}

export async function unsubscribe(userId: string) {
  const { error } = await supabaseAdmin.from("profiles").update({ marketing_opt_out: true }).eq("id", userId);
  if (error) throw new HttpError(500, error.message);
}
