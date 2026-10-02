import type { Request, Response } from "express";
import { z } from "zod";
import { recordAdminAuditLog } from "../services/usageService.js";
import * as hosting from "../services/mail/hosting.js";
import * as webmail from "../services/mail/webmail.js";

const id = z.string().uuid();
const uid = z.coerce.number().int().positive();
const folder = z.string().min(1).max(500);

function audit(req: Request, action: string, targetId?: string, meta: Record<string, unknown> = {}) {
  void recordAdminAuditLog(req.user!.id, action, "mail", targetId, meta).catch(() => {});
}

// ── Hosting (admin) ────────────────────────────────────────────────────────────────────────────

export async function hostingOverview(_req: Request, res: Response) {
  const [domains, mailboxes, usage] = await Promise.all([hosting.listDomains(), hosting.listMailboxes(), hosting.mailboxUsage()]);
  res.json({ configured: hosting.mailHostingConfigured(), serverHost: hosting.mailServerHost(), domains, mailboxes, usage });
}

export async function addDomain(req: Request, res: Response) {
  const input = z.object({ domain: z.string().trim().toLowerCase().min(3).max(253), description: z.string().trim().max(200).default("") }).parse(req.body);
  const domain = await hosting.addDomain(input.domain, input.description, req.user!.id);
  audit(req, "mail.domain_added", domain.id as string, { domain: input.domain });
  res.status(201).json({ domain, dns: await hosting.dnsRecords(input.domain) });
}

export async function domainDns(req: Request, res: Response) {
  const domain = z.string().trim().toLowerCase().min(3).max(253).parse(req.params.domain);
  res.json({ dns: await hosting.dnsRecords(domain) });
}

export async function createMailbox(req: Request, res: Response) {
  const input = z
    .object({
      domainId: id,
      localPart: z.string().trim().min(1).max(64),
      displayName: z.string().trim().max(120).default(""),
      ownerUserId: id.nullable().optional(),
      quotaMb: z.number().int().min(100).max(102400).optional(),
      password: z.string().max(200).optional(),
    })
    .parse(req.body);
  const created = await hosting.createMailbox(input, req.user!.id);
  audit(req, "mail.mailbox_created", created.mailbox.id as string, { address: created.mailbox.address, owner: input.ownerUserId ?? null });
  res.status(201).json(created);
}

export async function updateMailbox(req: Request, res: Response) {
  const mailboxId = id.parse(req.params.mailboxId);
  const input = z
    .object({
      displayName: z.string().trim().max(120).optional(),
      quotaMb: z.number().int().min(100).max(102400).optional(),
      status: z.enum(["active", "disabled"]).optional(),
      ownerUserId: id.nullable().optional(),
      // "" = generate a new random password.
      password: z.string().max(200).optional(),
    })
    .parse(req.body);
  const result = await hosting.updateMailbox(mailboxId, input);
  audit(req, "mail.mailbox_updated", mailboxId, { status: input.status, passwordReset: input.password !== undefined, owner: input.ownerUserId });
  res.json(result);
}

export async function deleteMailbox(req: Request, res: Response) {
  const mailboxId = id.parse(req.params.mailboxId);
  await hosting.deleteMailbox(mailboxId);
  audit(req, "mail.mailbox_deleted", mailboxId);
  res.status(204).end();
}

// ── Webmail (every staff member, own accounts only) ──────────────────────────────────────────

export async function accounts(req: Request, res: Response) {
  const list = await webmail.listAccounts(req.user!.id);
  const presets = Object.fromEntries(Object.entries(webmail.PRESETS).map(([k, v]) => [k, { help: v.help }]));
  res.json({ accounts: list, presets, settings: list.filter((a) => a.kind === "hosted").map((a) => hosting.clientSettings(a.email as string)) });
}

export async function addAccount(req: Request, res: Response) {
  const input = z
    .object({
      email: z.string().trim().email().max(254),
      displayName: z.string().trim().max(120).optional(),
      label: z.string().trim().max(40).optional(),
      password: z.string().min(1).max(500),
      preset: z.enum(["gmail", "outlook", "zoho", "yahoo", "icloud", "custom"]).optional(),
      imapHost: z.string().trim().max(253).optional(),
      imapPort: z.number().int().optional(),
      imapSecure: z.boolean().optional(),
      smtpHost: z.string().trim().max(253).optional(),
      smtpPort: z.number().int().optional(),
      smtpSecure: z.boolean().optional(),
      username: z.string().trim().max(254).optional(),
    })
    .parse(req.body);
  const account = await webmail.addExternalAccount(req.user!.id, input);
  res.status(201).json({ account });
}

export async function removeAccount(req: Request, res: Response) {
  await webmail.removeAccount(req.user!.id, id.parse(req.params.accountId));
  res.status(204).end();
}

export async function makeDefault(req: Request, res: Response) {
  await webmail.setDefaultAccount(req.user!.id, id.parse(req.params.accountId));
  res.json({ ok: true });
}

export async function changePassword(req: Request, res: Response) {
  const { password } = z.object({ password: z.string().min(10).max(200) }).parse(req.body);
  await hosting.changeOwnPassword(req.user!.id, id.parse(req.params.accountId), password);
  res.json({ ok: true });
}

export async function folders(req: Request, res: Response) {
  res.json({ folders: await webmail.listFolders(req.user!.id, id.parse(req.params.accountId)) });
}

export async function messages(req: Request, res: Response) {
  const q = z.object({ folder: folder.default("INBOX"), page: z.coerce.number().int().min(0).max(10_000).default(0), q: z.string().max(200).default("") }).parse(req.query);
  res.json(await webmail.listMessages(req.user!.id, id.parse(req.params.accountId), q.folder, q.page, 50, q.q));
}

export async function message(req: Request, res: Response) {
  const q = z.object({ folder: folder.default("INBOX") }).parse(req.query);
  res.json({ message: await webmail.getMessage(req.user!.id, id.parse(req.params.accountId), q.folder, uid.parse(req.params.uid)) });
}

export async function attachment(req: Request, res: Response) {
  const q = z.object({ folder: folder.default("INBOX") }).parse(req.query);
  const att = await webmail.getAttachment(req.user!.id, id.parse(req.params.accountId), q.folder, uid.parse(req.params.uid), z.coerce.number().int().min(0).parse(req.params.index));
  res.setHeader("Content-Type", att.contentType);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(att.content);
}

export async function act(req: Request, res: Response) {
  const input = z
    .object({
      folder: folder,
      uids: z.array(z.number().int().positive()).min(1).max(500),
      action: z.enum(["read", "unread", "flag", "unflag", "trash", "archive", "delete", "move"]),
      target: folder.optional(),
    })
    .parse(req.body);
  res.json(await webmail.updateMessages(req.user!.id, id.parse(req.params.accountId), input.folder, input.uids, input.action, input.target));
}

const emails = z.array(z.string().trim().max(254)).max(100);

export async function send(req: Request, res: Response) {
  const input = z
    .object({
      to: emails.min(1),
      cc: emails.optional(),
      bcc: emails.optional(),
      subject: z.string().max(998).default(""),
      text: z.string().max(2_000_000).default(""),
      html: z.string().max(4_000_000).optional(),
      inReplyTo: z.string().max(998).nullable().optional(),
      references: z.array(z.string().max(998)).max(100).optional(),
      attachments: z
        .array(z.object({ filename: z.string().max(255), contentType: z.string().max(200).optional(), dataBase64: z.string().max(27_000_000) }))
        .max(10)
        .optional(),
    })
    .parse(req.body);
  const total = (input.attachments ?? []).reduce((n, a) => n + a.dataBase64.length * 0.75, 0);
  if (total > 20 * 1024 * 1024) {
    res.status(413).json({ error: "Attachments are limited to 20 MB per message." });
    return;
  }
  res.json(await webmail.sendMail(req.user!.id, id.parse(req.params.accountId), input));
}
