import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import * as updates from "../services/console/announcementService.js";
import * as support from "../services/console/supportService.js";
import { unsubscribe } from "../services/console/campaignService.js";
import { verifyUnsubscribeToken } from "../services/console/mail.js";

/** User-facing side of the Team Console: What's New popups, support tickets, unsubscribe, inbound support mail. */

export async function pendingUpdates(req: Request, res: Response) {
  const { platform } = z.object({ platform: z.enum(["web", "android", "ios"]).default("web") }).parse(req.query);
  res.json({ updates: await updates.pendingForUser(req.user!.id, platform) });
}

export async function markUpdatesSeen(req: Request, res: Response) {
  const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(20), clickedId: z.string().uuid().optional() }).parse(req.body);
  await updates.markSeen(req.user!.id, body.ids, body.clickedId);
  res.json({ ok: true });
}

export async function myTickets(req: Request, res: Response) {
  res.json({ tickets: await support.listTicketsForUser(req.user!.id) });
}

export async function openTicket(req: Request, res: Response) {
  const body = z
    .object({
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(20_000),
      category: z.enum(["general", "billing", "bug", "feature", "account"]).default("general"),
      platform: z.enum(["web", "android", "ios"]).default("web"),
    })
    .parse(req.body);
  if (!req.user!.email) throw new HttpError(400, "Your account has no email address to reply to");
  const ticket = await support.createTicket({
    userId: req.user!.id,
    email: req.user!.email,
    name: req.user!.name ?? "",
    subject: body.subject,
    body: body.body,
    category: body.category,
    channel: body.platform === "web" ? "web" : "app",
  });
  res.status(201).json({ ticket: { id: ticket.id, number: ticket.number, subject: ticket.subject, status: ticket.status } });
}

export async function myTicket(req: Request, res: Response) {
  res.json({ ticket: await support.getTicketForUser(req.user!.id, z.string().uuid().parse(req.params.ticketId)) });
}

export async function replyMyTicket(req: Request, res: Response) {
  const { body } = z.object({ body: z.string().trim().min(1).max(20_000) }).parse(req.body);
  await support.userReply(req.user!.id, z.string().uuid().parse(req.params.ticketId), body);
  res.json({ ticket: await support.getTicketForUser(req.user!.id, req.params.ticketId!) });
}

/**
 * Inbound support email. Point the email provider's inbound webhook (Resend, Postmark, Mailgun,
 * SendGrid…) here with header `x-friday-inbound-secret: $SUPPORT_INBOUND_SECRET`. Accepts the common
 * payload shapes: {from, subject, text} / Postmark {FromFull, Subject, TextBody} / Resend {data:{…}}.
 */
export async function inboundEmail(req: Request, res: Response) {
  const secret = process.env.SUPPORT_INBOUND_SECRET ?? "";
  const given = String(req.headers["x-friday-inbound-secret"] ?? "");
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    throw new HttpError(401, "Invalid inbound secret");
  }
  const raw = (req.body?.data ?? req.body ?? {}) as Record<string, unknown>;
  const fromField = raw.from ?? raw.From ?? (raw.FromFull as { Email?: string } | undefined)?.Email ?? "";
  const fromText = typeof fromField === "object" && fromField ? String((fromField as { email?: string }).email ?? "") : String(fromField);
  const email = fromText.match(/<([^>]+)>/)?.[1] ?? fromText;
  const name = String((raw.FromName as string) ?? fromText.match(/^([^<]+)</)?.[1]?.trim() ?? "");
  const subject = String(raw.subject ?? raw.Subject ?? "(no subject)");
  const text = String(raw.text ?? raw.TextBody ?? raw["stripped-text"] ?? raw.plain ?? "").trim();
  if (!z.string().email().safeParse(email.trim()).success) throw new HttpError(400, "No sender address");
  if (!text) throw new HttpError(400, "Empty message");
  res.json(await support.ingestEmail({ from: email, name, subject, text: text.slice(0, 20_000) }));
}

function unsubscribePage(title: string, message: string) {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title></head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:420px;padding:32px;background:#fff;border:1px solid #e8e6e1;border-radius:20px;text-align:center;">
<h1 style="margin:0 0 8px;font-size:20px;color:#18181a;">${title}</h1><p style="margin:0;color:#6b6b6f;font-size:14px;line-height:1.6;">${message}</p></div></body></html>`;
}

/** GET (link click) and POST (RFC 8058 one-click from the mail client) both unsubscribe. */
export async function emailUnsubscribe(req: Request, res: Response) {
  const userId = String(req.query.u ?? "");
  const token = String(req.query.t ?? "");
  if (!z.string().uuid().safeParse(userId).success || !verifyUnsubscribeToken(userId, token)) {
    res.status(400).type("html").send(unsubscribePage("Link not valid", "This unsubscribe link is invalid or incomplete."));
    return;
  }
  await unsubscribe(userId);
  if (req.method === "POST") {
    res.json({ ok: true });
    return;
  }
  res.type("html").send(unsubscribePage("You're unsubscribed", "You won't get Friday product and marketing emails any more. Account and security emails still arrive."));
}

export async function emailPreferences(req: Request, res: Response) {
  const { data } = await supabaseAdmin.from("profiles").select("marketing_opt_out").eq("id", req.user!.id).maybeSingle();
  res.json({ marketing: !(data?.marketing_opt_out ?? false) });
}

export async function updateEmailPreferences(req: Request, res: Response) {
  const { marketing } = z.object({ marketing: z.boolean() }).parse(req.body);
  const { error } = await supabaseAdmin.from("profiles").update({ marketing_opt_out: !marketing }).eq("id", req.user!.id);
  if (error) throw new HttpError(500, error.message);
  res.json({ marketing });
}
