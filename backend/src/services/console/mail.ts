import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";

/**
 * Outbound email for the Team Console: marketing campaigns, support replies, team invites. One
 * branded template, a deliberately small Markdown renderer (the console composes in Markdown), team
 * "from" identities (support@, hello@… — rows in mail_identities, not constants), and signed
 * one-click unsubscribe links. Transport is Resend, same account as the sign-in OTP mail.
 */

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
export const RESEND_BATCH_MAX = 100;

export function mailConfigured(): boolean {
  return Boolean(env.resendApiKey);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code style="background:#f1f0ec;border-radius:4px;padding:1px 5px;font-size:13px;">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Links last, on the escaped text; only http(s)/mailto targets survive.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const url = safeUrl(href.replace(/&amp;/g, "&"));
    return url ? `<a href="${escapeHtml(url)}" style="color:#1a56db;text-decoration:underline;">${label}</a>` : label;
  });
  return out;
}

/**
 * Markdown subset for emails and announcements: # headings, paragraphs, - / 1. lists, **bold**,
 * *italic*, `code`, [links](https://…), --- rules. Everything is HTML-escaped first, so a campaign
 * body can never inject markup or scripts.
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.65;color:#2b2b2e;">${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    html.push(
      `<${tag} style="margin:0 0 16px 0;padding-left:22px;font-size:15px;line-height:1.65;color:#2b2b2e;">${list.items.map((i) => `<li style="margin:0 0 6px 0;">${inline(i)}</li>`).join("")}</${tag}>`,
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (/^-{3,}$/.test(line.trim())) {
      flushParagraph();
      flushList();
      html.push('<hr style="border:0;border-top:1px solid #ecebe6;margin:24px 0;" />');
    } else if (heading) {
      flushParagraph();
      flushList();
      const size = heading[1]!.length === 1 ? 22 : heading[1]!.length === 2 ? 18 : 16;
      html.push(`<h${heading[1]!.length} style="margin:8px 0 12px 0;font-size:${size}px;line-height:1.3;color:#18181a;font-weight:700;">${inline(heading[2]!)}</h${heading[1]!.length}>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return html.join("\n");
}

export function brandedEmail(opts: {
  heading?: string;
  bodyHtml: string;
  preheader?: string;
  cta?: { label: string; url: string } | null;
  unsubscribeUrl?: string | null;
  footerNote?: string;
}): string {
  const ctaUrl = opts.cta ? safeUrl(opts.cta.url) : null;
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheader)}</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:40px 16px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e8e6e1;">
          <tr><td style="padding:32px 40px 0 40px;">
            <div style="display:inline-block;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#18181a,#4a4a4d);text-align:center;line-height:28px;color:#ffffff;font-weight:800;font-size:15px;">F</div>
            <span style="font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#18181a;margin-left:8px;vertical-align:middle;">Friday</span>
          </td></tr>
          <tr><td style="padding:28px 40px 8px 40px;">
            ${opts.heading ? `<h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.3;color:#18181a;font-weight:700;letter-spacing:-0.01em;">${escapeHtml(opts.heading)}</h1>` : ""}
            ${opts.bodyHtml}
            ${ctaUrl && opts.cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px 0;"><tr><td style="border-radius:999px;background:#18181a;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(opts.cta.label)}</a></td></tr></table>` : ""}
          </td></tr>
          <tr><td style="padding:20px 40px 28px 40px;border-top:1px solid #efeeea;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#9a9a9e;">
              ${opts.footerNote ? `${escapeHtml(opts.footerNote)}<br/>` : ""}© ${new Date().getFullYear()} Billionaires Technologies.
              ${opts.unsubscribeUrl ? ` · <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#9a9a9e;text-decoration:underline;">Unsubscribe</a>` : ""}
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// ── Identities ────────────────────────────────────────────────────────────────

export type MailIdentity = { id: string; address: string; display_name: string; team: string; purpose: string; is_default: boolean };

/** The "From" for a purpose (support replies, campaigns…): that purpose's identity, else the default one, else env. */
export async function fromAddress(opts: { identityId?: string | null; purpose?: MailIdentity["purpose"] } = {}): Promise<{ from: string; replyTo?: string }> {
  const { data } = await supabaseAdmin.from("mail_identities").select("*");
  const identities = (data ?? []) as MailIdentity[];
  const pick =
    (opts.identityId && identities.find((i) => i.id === opts.identityId)) ||
    (opts.purpose && identities.find((i) => i.purpose === opts.purpose)) ||
    identities.find((i) => i.is_default);
  if (!pick) return { from: env.resendFromEmail };
  return { from: `${pick.display_name} <${pick.address}>`, replyTo: pick.address };
}

// ── Sending ──────────────────────────────────────────────────────────────────

export type OutboundEmail = { from: string; to: string; subject: string; html: string; replyTo?: string; headers?: Record<string, string> };

function toResend(m: OutboundEmail) {
  return { from: m.from, to: [m.to], subject: m.subject, html: m.html, ...(m.replyTo ? { reply_to: m.replyTo } : {}), ...(m.headers ? { headers: m.headers } : {}) };
}

export async function sendEmail(message: OutboundEmail): Promise<void> {
  if (!env.resendApiKey) throw new Error("Email sending is not configured (missing RESEND_API_KEY)");
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(toResend(message)),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** Up to RESEND_BATCH_MAX messages in one API call. */
export async function sendEmailBatch(messages: OutboundEmail[]): Promise<void> {
  if (!env.resendApiKey) throw new Error("Email sending is not configured (missing RESEND_API_KEY)");
  if (messages.length === 0) return;
  if (messages.length > RESEND_BATCH_MAX) throw new Error(`At most ${RESEND_BATCH_MAX} emails per batch`);
  const res = await fetch(RESEND_BATCH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(messages.map(toResend)),
  });
  if (!res.ok) throw new Error(`Email batch failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

// ── Unsubscribe ──────────────────────────────────────────────────────────────

/** Stateless unsubscribe token: an HMAC of the user id with the server secret (nothing stored). */
export function unsubscribeToken(userId: string): string {
  return createHmac("sha256", `${env.keyEncryptionSecret}:unsubscribe`).update(userId).digest("base64url").slice(0, 32);
}

export function verifyUnsubscribeToken(userId: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(userId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function unsubscribeUrl(userId: string): string {
  return `${env.publicAppUrl.replace(/\/$/, "")}/api/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}
