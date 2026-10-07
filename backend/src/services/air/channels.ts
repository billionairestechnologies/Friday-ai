import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Native WhatsApp (Meta Cloud API) and Telegram (Bot API) webhooks. Pure parsing + verification here;
 * routes/air.ts hands the messages to doors.acceptChannelMessage.
 *
 * WhatsApp: Meta signs every POST with X-Hub-Signature-256 = HMAC-SHA256(app secret, raw body). The
 * sender's wa_id is their phone number, which is matched to the verified number on the account.
 * Telegram: the webhook URL carries a secret path segment; a chat is linked once with
 * /start <code> from a link the web app hands out (the code is an HMAC of the user id — nothing stored).
 */

export function verifyWhatsAppSubscription(query: Record<string, unknown>): string | null {
  const token = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
  if (!token) return null;
  if (query["hub.mode"] !== "subscribe" || query["hub.verify_token"] !== token) return null;
  return typeof query["hub.challenge"] === "string" ? query["hub.challenge"] : null;
}

export function whatsAppSignatureOk(rawBody: Buffer | undefined, header: string | undefined): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET ?? "";
  if (!secret || !rawBody || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

type WhatsAppBody = {
  entry?: { changes?: { value?: { messages?: { from?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string } } }[] } }[] }[];
};

/** Text messages (and button taps) from a signed Meta webhook. Unsigned or malformed → none. */
export function readWhatsAppWebhook(body: unknown, signature: string | undefined, rawBody: Buffer | undefined): { from: string; text: string }[] {
  if (!whatsAppSignatureOk(rawBody, signature)) return [];
  const out: { from: string; text: string }[] = [];
  for (const entry of (body as WhatsAppBody)?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? "";
        if (m.from && text.trim()) out.push({ from: m.from, text: text.slice(0, 8000) });
      }
    }
  }
  return out;
}

type TelegramUpdate = { message?: { chat?: { id?: number | string }; text?: string } };

export function readTelegramUpdate(body: unknown): { chatId: string; text: string } | null {
  const message = (body as TelegramUpdate)?.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (chatId == null || !text) return null;
  return { chatId: String(chatId), text: text.slice(0, 8000) };
}

function linkMac(userId: string) {
  return createHmac("sha256", `${env.keyEncryptionSecret}:telegram-link`).update(userId).digest("base64url").slice(0, 10);
}

/** `<userId>_<mac>` — fits Telegram's 64-char /start payload, [A-Za-z0-9_-] only. */
export function telegramLinkCode(userId: string): string {
  return `${userId}_${linkMac(userId)}`;
}

export function userFromTelegramCode(code: string): string | null {
  const m = /^([0-9a-f-]{36})_([A-Za-z0-9_-]{10})$/i.exec(code.trim());
  if (!m) return null;
  const want = Buffer.from(linkMac(m[1]!));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1]! : null;
}

export function telegramLinkUrl(userId: string): string | null {
  const bot = process.env.TELEGRAM_BOT_USERNAME ?? "";
  return bot ? `https://t.me/${bot.replace(/^@/, "")}?start=${telegramLinkCode(userId)}` : null;
}
