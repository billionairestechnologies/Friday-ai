import { promises as dns } from "node:dns";
import { ImapFlow, type FetchMessageObject, type ListResponse } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { decryptSecret, encryptSecret } from "../../utils/crypto.js";
import { isBlockedAddress } from "../agent/safeFetch.js";
import { mailServerHost } from "./hosting.js";

/**
 * Webmail for the Team Console: any IMAP/SMTP account — the employee's hosted company mailbox or
 * their Gmail / Outlook / Zoho / other account — read and sent from one place.
 *
 * Every request opens a short IMAP session and closes it (no long-lived connections held by the API
 * process, which may be one of several behind a load balancer). Message HTML is NOT sanitised here:
 * the client renders it in a sandboxed iframe with scripts disabled and remote images blocked until
 * the reader allows them.
 */

export type MailAccount = {
  id: string;
  user_id: string;
  kind: "hosted" | "external";
  mailbox_id: string | null;
  label: string;
  email: string;
  display_name: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  username: string;
  secret_encrypted: string;
  is_default: boolean;
  last_error: string | null;
  last_checked_at: string | null;
};

/** Known providers — the employee only types their address and an app password. */
export const PRESETS: Record<string, { imap: [string, number, boolean]; smtp: [string, number, boolean]; help: string }> = {
  gmail: { imap: ["imap.gmail.com", 993, true], smtp: ["smtp.gmail.com", 465, true], help: "Turn on 2-Step Verification, then create an App password at myaccount.google.com/apppasswords and paste it here." },
  outlook: { imap: ["outlook.office365.com", 993, true], smtp: ["smtp.office365.com", 587, false], help: "Use an app password (account.microsoft.com → Security). Work accounts need IMAP/SMTP AUTH enabled by your admin." },
  zoho: { imap: ["imap.zoho.in", 993, true], smtp: ["smtp.zoho.in", 465, true], help: "Enable IMAP in Zoho Mail settings and use an app-specific password. Use imap.zoho.com / smtp.zoho.com outside India." },
  yahoo: { imap: ["imap.mail.yahoo.com", 993, true], smtp: ["smtp.mail.yahoo.com", 465, true], help: "Create an app password in Yahoo Account Security." },
  icloud: { imap: ["imap.mail.me.com", 993, true], smtp: ["smtp.mail.me.com", 587, false], help: "Create an app-specific password at appleid.apple.com." },
};

const MAIL_PORTS = new Set([143, 993, 25, 465, 587, 2525]);

/**
 * External hosts are user-supplied, so the API process would connect wherever it's told — the same
 * SSRF risk as fetching a URL. Only mail ports, only public addresses (our own mail server excepted).
 */
export async function assertMailHost(host: string, port: number): Promise<void> {
  if (!MAIL_PORTS.has(port)) throw new HttpError(400, `Port ${port} isn't a mail port (use 993/143 for IMAP, 465/587 for SMTP)`);
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new HttpError(400, "Invalid server name");
  if (host === mailServerHost()) return;
  const addrs = await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(400, `Can't find the server ${host}`);
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new HttpError(400, "That server address isn't allowed");
}

function imapClient(acc: Pick<MailAccount, "imap_host" | "imap_port" | "imap_secure" | "username">, password: string) {
  return new ImapFlow({
    host: acc.imap_host,
    port: acc.imap_port,
    secure: acc.imap_secure,
    auth: { user: acc.username, pass: password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });
}

function smtpTransport(acc: Pick<MailAccount, "smtp_host" | "smtp_port" | "smtp_secure" | "username">, password: string) {
  return nodemailer.createTransport({
    host: acc.smtp_host,
    port: acc.smtp_port,
    secure: acc.smtp_secure,
    requireTLS: !acc.smtp_secure,
    auth: { user: acc.username, pass: password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });
}

function friendlyError(err: unknown): string {
  const e = err as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string };
  if (e.authenticationFailed || /auth|credentials|login|535|534/i.test(`${e.responseText ?? ""} ${e.message ?? ""}`)) {
    return "Sign-in failed — check the address and password (Gmail/Outlook/Yahoo need an app password, not your normal one).";
  }
  if (e.code === "ENOTFOUND") return "Mail server not found — check the server name.";
  if (e.code === "ETIMEDOUT" || e.code === "ECONNREFUSED") return "Couldn't reach the mail server — check the server name and port.";
  return e.responseText || e.message || "Mail server error";
}

// ── Accounts ─────────────────────────────────────────────────────────────────────────────────

const PUBLIC_COLUMNS = "id, kind, mailbox_id, label, email, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, is_default, last_error, last_checked_at";

export async function listAccounts(userId: string) {
  const { data, error } = await supabaseAdmin.from("mail_accounts").select(PUBLIC_COLUMNS).eq("user_id", userId).order("is_default", { ascending: false }).order("created_at");
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

async function getAccount(userId: string, accountId: string): Promise<MailAccount> {
  const { data } = await supabaseAdmin.from("mail_accounts").select("*").eq("id", accountId).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(404, "Mail account not found");
  return data as MailAccount;
}

export type ExternalAccountInput = {
  email: string;
  displayName?: string;
  label?: string;
  password: string;
  preset?: keyof typeof PRESETS | "custom";
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username?: string;
};

/** Adds Gmail/Outlook/any IMAP account after proving the credentials work (IMAP login + SMTP verify). */
export async function addExternalAccount(userId: string, input: ExternalAccountInput) {
  const preset = input.preset && input.preset !== "custom" ? PRESETS[input.preset] : null;
  const acc = {
    imap_host: (preset?.imap[0] ?? input.imapHost ?? "").trim().toLowerCase(),
    imap_port: preset?.imap[1] ?? input.imapPort ?? 993,
    imap_secure: preset?.imap[2] ?? input.imapSecure ?? true,
    smtp_host: (preset?.smtp[0] ?? input.smtpHost ?? "").trim().toLowerCase(),
    smtp_port: preset?.smtp[1] ?? input.smtpPort ?? 465,
    smtp_secure: preset?.smtp[2] ?? input.smtpSecure ?? true,
    username: (input.username || input.email).trim(),
  };
  if (!acc.imap_host || !acc.smtp_host) throw new HttpError(400, "Enter the IMAP and SMTP server names");
  await assertMailHost(acc.imap_host, acc.imap_port);
  await assertMailHost(acc.smtp_host, acc.smtp_port);
  // Prove it works before saving — a half-configured account is worse than none.
  const client = imapClient(acc, input.password);
  try {
    await client.connect();
  } catch (err) {
    throw new HttpError(400, friendlyError(err));
  } finally {
    await client.logout().catch(() => undefined);
  }
  try {
    await smtpTransport(acc, input.password).verify();
  } catch (err) {
    throw new HttpError(400, `Reading works, sending doesn't: ${friendlyError(err)}`);
  }
  const { count } = await supabaseAdmin.from("mail_accounts").select("id", { count: "exact", head: true }).eq("user_id", userId);
  const { data, error } = await supabaseAdmin
    .from("mail_accounts")
    .upsert(
      {
        user_id: userId,
        kind: "external",
        label: input.label?.trim() || (input.preset && input.preset !== "custom" ? input.preset[0]!.toUpperCase() + input.preset.slice(1) : "Mail"),
        email: input.email.trim().toLowerCase(),
        display_name: input.displayName?.trim() ?? "",
        ...acc,
        secret_encrypted: encryptSecret(input.password),
        is_default: !count,
        last_error: null,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,email" },
    )
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) throw new HttpError(500, error.message);
  return data;
}

export async function removeAccount(userId: string, accountId: string) {
  const acc = await getAccount(userId, accountId);
  if (acc.kind === "hosted") throw new HttpError(400, "Your company mailbox is managed by an admin — it can't be removed here.");
  await supabaseAdmin.from("mail_accounts").delete().eq("id", accountId).eq("user_id", userId);
}

export async function setDefaultAccount(userId: string, accountId: string) {
  await getAccount(userId, accountId);
  await supabaseAdmin.from("mail_accounts").update({ is_default: false }).eq("user_id", userId);
  await supabaseAdmin.from("mail_accounts").update({ is_default: true }).eq("id", accountId).eq("user_id", userId);
}

async function withImap<T>(userId: string, accountId: string, fn: (client: ImapFlow, acc: MailAccount) => Promise<T>): Promise<T> {
  const acc = await getAccount(userId, accountId);
  const client = imapClient(acc, decryptSecret(acc.secret_encrypted));
  try {
    await client.connect();
  } catch (err) {
    const message = friendlyError(err);
    await supabaseAdmin.from("mail_accounts").update({ last_error: message, last_checked_at: new Date().toISOString() }).eq("id", acc.id);
    throw new HttpError(502, message);
  }
  try {
    const result = await fn(client, acc);
    if (acc.last_error) await supabaseAdmin.from("mail_accounts").update({ last_error: null, last_checked_at: new Date().toISOString() }).eq("id", acc.id);
    return result;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

const FOLDER_ORDER = ["\\Inbox", "\\Flagged", "\\Drafts", "\\Sent", "\\Archive", "\\Junk", "\\Trash", "\\All"];

export async function listFolders(userId: string, accountId: string) {
  return withImap(userId, accountId, async (client) => {
    const list = (await client.list({ statusQuery: { unseen: true, messages: true } })) as (ListResponse & { status?: { unseen?: number; messages?: number } })[];
    return list
      .filter((f) => !f.flags.has("\\Noselect"))
      .map((f) => ({
        path: f.path,
        name: f.path.toUpperCase() === "INBOX" ? "Inbox" : f.name,
        specialUse: f.path.toUpperCase() === "INBOX" ? "\\Inbox" : (f.specialUse ?? null),
        unseen: f.status?.unseen ?? 0,
        total: f.status?.messages ?? 0,
      }))
      .sort((a, b) => {
        const ia = a.specialUse ? FOLDER_ORDER.indexOf(a.specialUse) : -1;
        const ib = b.specialUse ? FOLDER_ORDER.indexOf(b.specialUse) : -1;
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.name.localeCompare(b.name);
      });
  });
}

function addr(list?: { name?: string; address?: string }[]) {
  return (list ?? []).map((a) => ({ name: a.name ?? "", address: a.address ?? "" }));
}

function summary(m: FetchMessageObject) {
  return {
    uid: m.uid,
    subject: m.envelope?.subject ?? "(no subject)",
    from: addr(m.envelope?.from),
    to: addr(m.envelope?.to),
    date: (m.envelope?.date ?? m.internalDate ?? null) as Date | string | null,
    seen: m.flags?.has("\\Seen") ?? false,
    flagged: m.flags?.has("\\Flagged") ?? false,
    answered: m.flags?.has("\\Answered") ?? false,
    size: m.size ?? 0,
    hasAttachments: Boolean(m.bodyStructure && JSON.stringify(m.bodyStructure).includes('"disposition":"attachment"')),
  };
}

/** Newest first, `pageSize` per page; `query` searches subject, from, to and body on the server. */
export async function listMessages(userId: string, accountId: string, folder: string, page = 0, pageSize = 50, query = "") {
  return withImap(userId, accountId, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      const total = mailbox && typeof mailbox === "object" ? mailbox.exists : 0;
      let uids: number[] | null = null;
      if (query.trim()) {
        const q = query.trim().slice(0, 200);
        const found = await client.search({ or: [{ subject: q }, { from: q }, { to: q }, { body: q }] }, { uid: true });
        uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
      }
      const items: ReturnType<typeof summary>[] = [];
      if (uids) {
        const slice = uids.slice(page * pageSize, page * pageSize + pageSize);
        if (slice.length) for await (const m of client.fetch(slice, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true }, { uid: true })) items.push(summary(m));
      } else if (total > 0) {
        const end = total - page * pageSize;
        const start = Math.max(1, end - pageSize + 1);
        if (end >= 1) for await (const m of client.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true })) items.push(summary(m));
      }
      items.sort((a, b) => b.uid - a.uid);
      return { total: uids ? uids.length : total, page, pageSize, messages: items };
    } finally {
      lock.release();
    }
  });
}

function addressList(a: AddressObject | AddressObject[] | undefined) {
  const arr = Array.isArray(a) ? a : a ? [a] : [];
  return arr.flatMap((x) => x.value.map((v) => ({ name: v.name ?? "", address: v.address ?? "" })));
}

/** One message, parsed. Marks it read. Attachments come back as metadata (downloaded separately). */
export async function getMessage(userId: string, accountId: string, folder: string, uid: number) {
  return withImap(userId, accountId, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!msg || !msg.source) throw new HttpError(404, "Message not found");
      if (msg.source.length > 40 * 1024 * 1024) throw new HttpError(413, "This message is over 40 MB — open it in a mail app.");
      const parsed = await simpleParser(msg.source);
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => undefined);
      return {
        uid,
        messageId: parsed.messageId ?? null,
        references: (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []) as string[],
        subject: parsed.subject ?? "(no subject)",
        from: addressList(parsed.from),
        to: addressList(parsed.to),
        cc: addressList(parsed.cc),
        replyTo: addressList(parsed.replyTo),
        date: parsed.date?.toISOString() ?? null,
        html: typeof parsed.html === "string" ? parsed.html : null,
        text: parsed.text ?? "",
        flagged: msg.flags?.has("\\Flagged") ?? false,
        attachments: parsed.attachments
          .filter((a) => a.contentDisposition !== "inline" || !a.cid)
          .map((a, index) => ({ index, filename: a.filename ?? `attachment-${index + 1}`, contentType: a.contentType, size: a.size })),
        // Inline images referenced by cid: in the HTML, as data URLs so the sandboxed view can show them.
        inline: Object.fromEntries(
          parsed.attachments
            .filter((a) => a.cid && a.size < 2 * 1024 * 1024)
            .map((a) => [a.cid!, `data:${a.contentType};base64,${a.content.toString("base64")}`]),
        ),
      };
    } finally {
      lock.release();
    }
  });
}

export async function getAttachment(userId: string, accountId: string, folder: string, uid: number, index: number) {
  return withImap(userId, accountId, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) throw new HttpError(404, "Message not found");
      const parsed = await simpleParser(msg.source);
      const list = parsed.attachments.filter((a) => a.contentDisposition !== "inline" || !a.cid);
      const att = list[index];
      if (!att) throw new HttpError(404, "Attachment not found");
      return { filename: att.filename ?? `attachment-${index + 1}`, contentType: att.contentType || "application/octet-stream", content: att.content };
    } finally {
      lock.release();
    }
  });
}

async function specialFolder(client: ImapFlow, use: string): Promise<string | null> {
  const list = await client.list();
  return list.find((f) => f.specialUse === use)?.path ?? null;
}

/** Flags, moves to Trash/Archive/any folder, or deletes for good (when already in Trash). */
export async function updateMessages(userId: string, accountId: string, folder: string, uids: number[], action: "read" | "unread" | "flag" | "unflag" | "trash" | "archive" | "delete" | "move", target?: string) {
  if (!uids.length) return { ok: true };
  return withImap(userId, accountId, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const set = uids.join(",");
      if (action === "read") await client.messageFlagsAdd(set, ["\\Seen"], { uid: true });
      else if (action === "unread") await client.messageFlagsRemove(set, ["\\Seen"], { uid: true });
      else if (action === "flag") await client.messageFlagsAdd(set, ["\\Flagged"], { uid: true });
      else if (action === "unflag") await client.messageFlagsRemove(set, ["\\Flagged"], { uid: true });
      else if (action === "delete") await client.messageDelete(set, { uid: true });
      else {
        const dest = action === "move" ? target : await specialFolder(client, action === "trash" ? "\\Trash" : "\\Archive");
        if (!dest) {
          if (action === "trash") await client.messageDelete(set, { uid: true });
          else throw new HttpError(400, "This account has no Archive folder");
        } else if (dest !== folder) await client.messageMove(set, dest, { uid: true });
      }
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}

export type OutgoingMail = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { filename: string; contentType?: string; dataBase64: string }[];
};

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

/** Sends through the account's own SMTP server, then saves a copy to Sent (Gmail does that itself). */
export async function sendMail(userId: string, accountId: string, mail: OutgoingMail) {
  const acc = await getAccount(userId, accountId);
  const all = [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])];
  if (!mail.to.length) throw new HttpError(400, "Add at least one recipient");
  if (all.length > 100) throw new HttpError(400, "Up to 100 recipients per message");
  const bad = all.find((a) => !EMAIL_RE.test(a));
  if (bad) throw new HttpError(400, `"${bad}" isn't a valid email address`);
  const password = decryptSecret(acc.secret_encrypted);
  const from = acc.display_name ? `"${acc.display_name.replace(/"/g, "")}" <${acc.email}>` : acc.email;
  const message = {
    from,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    inReplyTo: mail.inReplyTo ?? undefined,
    references: mail.references?.length ? mail.references : undefined,
    attachments: (mail.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.dataBase64, "base64") })),
  };
  const transport = smtpTransport(acc, password);
  try {
    await transport.sendMail(message);
  } catch (err) {
    throw new HttpError(502, friendlyError(err));
  }
  // Gmail/Outlook store sent mail automatically; other servers (incl. ours) need an IMAP APPEND.
  if (!/gmail\.com|office365\.com|outlook\.com/.test(acc.smtp_host)) {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
      composer.sendMail(message, (err, info) => (err ? reject(err) : resolve(info.message as Buffer)));
    }).catch(() => null);
    if (raw) {
      await withImap(userId, accountId, async (client) => {
        const sent = (await specialFolder(client, "\\Sent")) ?? "Sent";
        await client.append(sent, raw, ["\\Seen"]).catch(() => undefined);
      }).catch(() => undefined);
    }
  }
  return { ok: true };
}
