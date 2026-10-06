import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import { matchesAudience } from "../console/announcementService.js";

/**
 * A product update published with the Telegram or WhatsApp platform goes out on those channels to the
 * people who linked them (and match the update's audience).
 *
 * Telegram's Bot API has no per-message fee; we pace at ~20 messages a second (its limit is 30).
 * WhatsApp outside the 24-hour reply window only allows a Meta-approved template, and a marketing
 * template costs about ₹1.02 a person (airdots/PLAN.md), so WhatsApp only sends when the team has set
 * WHATSAPP_UPDATE_TEMPLATE (a template with one body parameter) — it is a deliberate choice, never the
 * default.
 */
export async function broadcastAnnouncement(update: { id: string; title: string; body: string; audience: string; platforms: string[]; cta_url?: string | null }) {
  const wantTelegram = update.platforms.includes("telegram") && Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const template = process.env.WHATSAPP_UPDATE_TEMPLATE ?? "";
  const wantWhatsApp = update.platforms.includes("whatsapp") && Boolean(template && process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
  if (!wantTelegram && !wantWhatsApp) return { telegram: 0, whatsapp: 0 };

  const channels = [wantTelegram ? "telegram" : null, wantWhatsApp ? "whatsapp" : null].filter(Boolean) as string[];
  const { data: links } = await supabaseAdmin.from("air_channels").select("user_id, channel, external_id").in("channel", channels).limit(50_000);
  const userIds = [...new Set((links ?? []).map((l) => l.user_id as string))];
  const plans = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += 500) {
    const { data } = await supabaseAdmin.from("profiles").select("id, plan, created_at").in("id", userIds.slice(i, i + 500));
    for (const p of data ?? []) plans.set(p.id as string, JSON.stringify({ plan: p.plan ?? "free", createdAt: p.created_at ?? new Date(0).toISOString() }));
  }
  const text = `${update.title}\n\n${update.body}${update.cta_url ? `\n\n${update.cta_url}` : ""}`.slice(0, 3900);
  let telegram = 0;
  let whatsapp = 0;
  for (const link of links ?? []) {
    const who = plans.get(link.user_id as string);
    if (!who || !matchesAudience(update.audience, JSON.parse(who) as { plan: string; createdAt: string })) continue;
    try {
      if (link.channel === "telegram") {
        const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: link.external_id, text }),
        });
        if (res.ok) telegram++;
      } else {
        const res = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: link.external_id,
            type: "template",
            template: { name: template, language: { code: process.env.WHATSAPP_UPDATE_TEMPLATE_LANG ?? "en" }, components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 1000) }] }] },
          }),
        });
        if (res.ok) whatsapp++;
      }
    } catch {
      /* one failed chat never stops the rest */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  logger.info("announcement_broadcast", { id: update.id, telegram, whatsapp });
  return { telegram, whatsapp };
}

/** The one featured card on the Air Dots home: the newest live update marked featured for Air Dots. */
export async function featuredForUser(userId: string) {
  const nowIso = new Date().toISOString();
  const { data } = await supabaseAdmin
    .from("announcements")
    .select("id, title, body, cta_label, cta_url, audience, expires_at, image_url")
    .eq("status", "published")
    .eq("featured", true)
    .contains("platforms", ["air"])
    .lte("publish_at", nowIso)
    .order("publish_at", { ascending: false })
    .limit(5);
  const { data: profile } = await supabaseAdmin.from("profiles").select("plan, created_at").eq("id", userId).maybeSingle();
  const user = { plan: (profile?.plan as string) ?? "free", createdAt: (profile?.created_at as string) ?? nowIso };
  const card = (data ?? []).find((a) => (!a.expires_at || (a.expires_at as string) > nowIso) && matchesAudience(a.audience as string, user));
  return card ? { id: card.id, title: card.title, body: card.body, ctaLabel: card.cta_label, ctaUrl: card.cta_url, imageUrl: card.image_url } : null;
}
