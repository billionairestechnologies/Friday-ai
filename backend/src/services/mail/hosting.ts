import { randomInt } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { encryptSecret } from "../../utils/crypto.js";

/**
 * Company mail hosting. The mailboxes live on OUR mail server — mailcow (open-source, Docker: Postfix
 * + Dovecot + rspamd + SOGo) on a VPS we control — and Friday manages it through mailcow's REST API:
 * the admin creates name@company.com for an employee here, and it is a real IMAP/SMTP mailbox they
 * can use in the Console webmail, Gmail's app, Outlook, Apple Mail or on their phone.
 *
 * Why mailcow rather than writing a mail server: deliverability (SPF/DKIM/DMARC, spam filtering,
 * TLS, queues, IP reputation) is years of work that already exists; owning the server keeps the
 * data and the cost ours. See docs/MAIL_HOSTING.md for the server + DNS setup.
 *
 * Env: MAILCOW_URL (https://mail.company.com), MAILCOW_API_KEY (read-write key from mailcow's
 * Configuration → Access → API), MAIL_SERVER_HOST (the hostname clients connect to; defaults to
 * MAILCOW_URL's host).
 */

export function mailHostingConfigured(): boolean {
  return Boolean(process.env.MAILCOW_URL && process.env.MAILCOW_API_KEY);
}

export function mailServerHost(): string {
  const explicit = process.env.MAIL_SERVER_HOST?.trim();
  if (explicit) return explicit;
  try {
    return new URL(process.env.MAILCOW_URL ?? "").hostname;
  } catch {
    return "";
  }
}

/** What any mail client needs for a hosted mailbox (shown to the employee). */
export function clientSettings(address: string) {
  const host = mailServerHost();
  return {
    email: address,
    username: address,
    incoming: { protocol: "IMAP", host, port: 993, security: "SSL/TLS" },
    outgoing: { protocol: "SMTP", host, port: 465, security: "SSL/TLS", altPort: 587, altSecurity: "STARTTLS" },
    webmail: process.env.MAILCOW_URL ? `${process.env.MAILCOW_URL.replace(/\/$/, "")}/SOGo` : null,
  };
}

type MailcowResult = { type?: string; msg?: unknown; log?: unknown };

/** Calls mailcow; its API answers 200 even on failure, with `type: "danger" | "error"` in the body. */
async function mailcow(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  if (!mailHostingConfigured()) throw new HttpError(503, "Mail hosting isn't connected — set MAILCOW_URL and MAILCOW_API_KEY on the server (see docs/MAIL_HOSTING.md).");
  const res = await fetch(`${process.env.MAILCOW_URL!.replace(/\/$/, "")}/api/v1/${path}`, {
    method,
    headers: { "X-API-Key": process.env.MAILCOW_API_KEY!, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch((err: unknown) => {
    throw new HttpError(502, `Mail server unreachable: ${err instanceof Error ? err.message : String(err)}`);
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new HttpError(502, `Mail server error ${res.status}: ${text.slice(0, 200)}`);
  const results = (Array.isArray(json) ? json : [json]) as MailcowResult[];
  const failed = results.find((r) => r && (r.type === "danger" || r.type === "error"));
  if (failed) throw new HttpError(400, `Mail server refused: ${Array.isArray(failed.msg) ? failed.msg.join(" ") : String(failed.msg ?? "unknown error")}`);
  return json;
}

/** A strong random password (no look-alike characters) for a new mailbox. */
export function generatePassword(length = 18): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%^*-_=+";
  let out = "";
  while (out.length < length) out += alphabet[randomInt(alphabet.length)];
  // Guarantee every character class so mailcow's password policy can't reject it.
  return `${out.slice(0, length - 4)}Aa7!`;
}

export function validLocalPart(local: string): boolean {
  return /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(local) && !local.includes("..");
}

// ── Domains ─────────────────────────────────────────────────────────────────────────────────

export async function listDomains() {
  const { data, error } = await supabaseAdmin.from("mail_domains").select("*").order("domain");
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function addDomain(domain: string, description: string, userId: string) {
  const d = domain.trim().toLowerCase();
  // 5 GB default per mailbox, 100 GB for the domain, up to 500 mailboxes — editable in mailcow.
  await mailcow("POST", "add/domain", { domain: d, description, aliases: 400, mailboxes: 500, defquota: 5120, maxquota: 102400, quota: 102400, active: 1 });
  // DKIM key so outgoing mail is signed (2048-bit, selector "dkim").
  await mailcow("POST", "add/dkim", { domains: d, dkim_selector: "dkim", key_size: 2048 }).catch(() => null);
  const { data, error } = await supabaseAdmin.from("mail_domains").insert({ domain: d, description, created_by: userId }).select("*").single();
  if (error) throw new HttpError(500, error.message);
  return data;
}

/** The DNS records the domain needs (the admin adds them at their DNS provider). */
export async function dnsRecords(domain: string) {
  const host = mailServerHost();
  type Dkim = { dkim_txt?: string; dkim_selector?: string };
  const dkim = (await mailcow("GET", `get/dkim/${encodeURIComponent(domain)}`).catch(() => null)) as Dkim | null;
  return [
    { type: "MX", name: domain, value: `${host}`, priority: 10, why: "Delivers incoming mail to our mail server" },
    { type: "TXT", name: domain, value: `v=spf1 mx a:${host} ~all`, why: "SPF: only our server may send as this domain" },
    ...(dkim?.dkim_txt ? [{ type: "TXT", name: `${dkim.dkim_selector ?? "dkim"}._domainkey.${domain}`, value: dkim.dkim_txt, why: "DKIM: signs every outgoing mail" }] : []),
    { type: "TXT", name: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, why: "DMARC: tells Gmail/Outlook to trust signed mail and reject spoofs" },
    { type: "CNAME", name: `autodiscover.${domain}`, value: host, why: "Outlook/phones find the server settings automatically" },
    { type: "CNAME", name: `autoconfig.${domain}`, value: host, why: "Thunderbird finds the server settings automatically" },
  ];
}

// ── Mailboxes ───────────────────────────────────────────────────────────────────────────────

export async function listMailboxes() {
  const { data, error } = await supabaseAdmin.from("mailboxes").select("*, mail_domains(domain)").order("address");
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

/**
 * Creates name@domain on the mail server and, when it's for a staff member, links it to their
 * webmail. Returns the one-time password so the admin can hand it over — it's never shown again.
 */
export async function createMailbox(input: { domainId: string; localPart: string; displayName: string; ownerUserId?: string | null; quotaMb?: number; password?: string }, userId: string) {
  const local = input.localPart.trim().toLowerCase();
  if (!validLocalPart(local)) throw new HttpError(400, "Use letters, numbers, dots, dashes or underscores for the name before @");
  const { data: domain } = await supabaseAdmin.from("mail_domains").select("id, domain").eq("id", input.domainId).maybeSingle();
  if (!domain) throw new HttpError(404, "Unknown domain");
  const address = `${local}@${domain.domain}`;
  const password = input.password?.trim() || generatePassword();
  if (password.length < 10) throw new HttpError(400, "Use a password of at least 10 characters");
  const quota = input.quotaMb ?? 5120;
  await mailcow("POST", "add/mailbox", {
    local_part: local,
    domain: domain.domain,
    name: input.displayName,
    password,
    password2: password,
    quota,
    active: "1",
    force_pw_update: "0",
    tls_enforce_in: "1",
    tls_enforce_out: "1",
  });
  const { data: mailbox, error } = await supabaseAdmin
    .from("mailboxes")
    .insert({ address, domain_id: domain.id, local_part: local, display_name: input.displayName, owner_user_id: input.ownerUserId ?? null, quota_mb: quota, created_by: userId })
    .select("*")
    .single();
  if (error || !mailbox) throw new HttpError(500, error?.message ?? "Mailbox created on the server but not recorded — refresh and check");
  if (input.ownerUserId) await linkHostedAccount(input.ownerUserId, mailbox.id as string, address, input.displayName, password);
  return { mailbox, password, settings: clientSettings(address) };
}

/** Adds (or refreshes) the hosted mailbox as an account in its owner's webmail. */
async function linkHostedAccount(userId: string, mailboxId: string, address: string, displayName: string, password: string) {
  const host = mailServerHost();
  const { count } = await supabaseAdmin.from("mail_accounts").select("id", { count: "exact", head: true }).eq("user_id", userId);
  const { error } = await supabaseAdmin.from("mail_accounts").upsert(
    {
      user_id: userId,
      kind: "hosted",
      mailbox_id: mailboxId,
      label: "Work",
      email: address,
      display_name: displayName,
      imap_host: host,
      imap_port: 993,
      imap_secure: true,
      smtp_host: host,
      smtp_port: 465,
      smtp_secure: true,
      username: address,
      secret_encrypted: encryptSecret(password),
      is_default: !count,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,email" },
  );
  if (error) throw new HttpError(500, error.message);
}

export async function updateMailbox(id: string, input: { displayName?: string; quotaMb?: number; status?: "active" | "disabled"; ownerUserId?: string | null; password?: string }) {
  const { data: mb } = await supabaseAdmin.from("mailboxes").select("*").eq("id", id).maybeSingle();
  if (!mb) throw new HttpError(404, "Mailbox not found");
  const attr: Record<string, unknown> = {};
  if (input.displayName !== undefined) attr.name = input.displayName;
  if (input.quotaMb !== undefined) attr.quota = input.quotaMb;
  if (input.status !== undefined) attr.active = input.status === "active" ? "1" : "0";
  let password: string | null = null;
  if (input.password !== undefined) {
    password = input.password.trim() || generatePassword();
    if (password.length < 10) throw new HttpError(400, "Use a password of at least 10 characters");
    attr.password = password;
    attr.password2 = password;
  }
  if (Object.keys(attr).length) await mailcow("POST", "edit/mailbox", { items: [mb.address], attr });
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.displayName !== undefined) row.display_name = input.displayName;
  if (input.quotaMb !== undefined) row.quota_mb = input.quotaMb;
  if (input.status !== undefined) row.status = input.status;
  if (input.ownerUserId !== undefined) row.owner_user_id = input.ownerUserId;
  const { data, error } = await supabaseAdmin.from("mailboxes").update(row).eq("id", id).select("*").single();
  if (error) throw new HttpError(500, error.message);
  // Keep the owner's webmail signed in after a reset, and move the account when ownership changes.
  if (input.ownerUserId !== undefined && input.ownerUserId !== mb.owner_user_id) {
    await supabaseAdmin.from("mail_accounts").delete().eq("mailbox_id", id);
  }
  const owner = (input.ownerUserId !== undefined ? input.ownerUserId : mb.owner_user_id) as string | null;
  if (owner && password) await linkHostedAccount(owner, id, mb.address as string, (data?.display_name as string) ?? "", password);
  else if (password) await supabaseAdmin.from("mail_accounts").update({ secret_encrypted: encryptSecret(password), last_error: null }).eq("mailbox_id", id);
  return { mailbox: data, password, settings: clientSettings(mb.address as string) };
}

/** Deletes the mailbox AND its mail on the server. Irreversible — the console asks to type the address. */
export async function deleteMailbox(id: string) {
  const { data: mb } = await supabaseAdmin.from("mailboxes").select("address").eq("id", id).maybeSingle();
  if (!mb) throw new HttpError(404, "Mailbox not found");
  await mailcow("POST", "delete/mailbox", [mb.address]);
  const { error } = await supabaseAdmin.from("mailboxes").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
}

/** Live usage (bytes, message count) for the admin list; empty when the server is unreachable. */
export async function mailboxUsage(): Promise<Record<string, { bytes: number; messages: number; active: boolean }>> {
  try {
    const all = (await mailcow("GET", "get/mailbox/all")) as { username?: string; quota_used?: number; messages?: number; active?: number | string }[];
    const out: Record<string, { bytes: number; messages: number; active: boolean }> = {};
    for (const m of Array.isArray(all) ? all : []) {
      if (m.username) out[m.username] = { bytes: Number(m.quota_used ?? 0), messages: Number(m.messages ?? 0), active: String(m.active) === "1" };
    }
    return out;
  } catch {
    return {};
  }
}

/** The employee changes their own hosted-mailbox password from the webmail. */
export async function changeOwnPassword(userId: string, accountId: string, newPassword: string) {
  if (newPassword.length < 10) throw new HttpError(400, "Use a password of at least 10 characters");
  const { data: acc } = await supabaseAdmin.from("mail_accounts").select("mailbox_id, email, kind").eq("id", accountId).eq("user_id", userId).maybeSingle();
  if (!acc || acc.kind !== "hosted" || !acc.mailbox_id) throw new HttpError(404, "Not a company mailbox");
  await mailcow("POST", "edit/mailbox", { items: [acc.email], attr: { password: newPassword, password2: newPassword } });
  await supabaseAdmin.from("mail_accounts").update({ secret_encrypted: encryptSecret(newPassword), last_error: null }).eq("id", accountId);
}
