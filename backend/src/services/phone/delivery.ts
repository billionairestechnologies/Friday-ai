import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import type { DeliveryChannel, PhoneConfig } from "./policy.js";
import { queueDelivery } from "./store.js";

async function telegramChatId(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("air_channels")
    .select("external_id")
    .eq("user_id", userId)
    .eq("channel", "telegram")
    .maybeSingle();
  if (error || !data) return null;
  return (data as { external_id: string }).external_id;
}

async function whatsAppTo(userId: string): Promise<string | null> {
  const linked = await supabaseAdmin
    .from("air_channels")
    .select("external_id")
    .eq("user_id", userId)
    .eq("channel", "whatsapp")
    .maybeSingle();
  if (!linked.error && linked.data) return (linked.data as { external_id: string }).external_id;
  const profile = await supabaseAdmin.from("profiles").select("phone").eq("id", userId).maybeSingle();
  if (profile.error || !profile.data) return null;
  const phone = (profile.data as { phone?: string | null }).phone ?? "";
  const digits = phone.replace(/\D/g, "");
  return digits || null;
}

/** App always already has the reply. The other channels send when their switch and credentials are on. */
export async function deliverResult(userId: string, email: string | null, text: string, channels: DeliveryChannel[], config: PhoneConfig) {
  const body = text.trim();
  if (!body) return;
  for (const channel of channels) {
    if (channel === "call") continue;
    queueDelivery(userId, channel, body);
    if (channel === "email" && config.channels.email && email && env.resendApiKey) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.resendFromEmail, to: email, subject: "Friday", text: body }),
      }).catch(() => undefined);
    }
    if (channel === "telegram" && config.channels.telegram && process.env.TELEGRAM_BOT_TOKEN) {
      const chatId = await telegramChatId(userId);
      if (chatId) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: body.slice(0, 4000) }),
        }).catch(() => undefined);
      }
    }
    if (channel === "whatsapp" && config.channels.whatsapp && process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID) {
      const to = await whatsAppTo(userId);
      if (to) {
        await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body: body.slice(0, 4000) },
          }),
        }).catch(() => undefined);
      }
    }
  }
}
