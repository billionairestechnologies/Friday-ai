import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { findUserByEmail, userLabels } from "./directory.js";
import { brandedEmail, fromAddress, mailConfigured, renderMarkdown, sendEmail } from "./mail.js";
import { entitlementsFor } from "../quota/entitlements.js";

/**
 * Support center. Users open tickets from the app (web/Android/iOS) or by emailing the support
 * address (inbound webhook); staff work them in the console — assign, prioritise, reply (emailed to
 * the user from the support identity, reply-to kept on the ticket via "[#1234]" in the subject),
 * internal notes the user never sees, and statuses. Users see their own tickets and replies in-app.
 */

export type TicketStatus = "open" | "pending" | "resolved" | "closed";

const SUBJECT_TAG = /\[#(\d+)\]/;

async function notifyUser(ticket: { number: number; email: string; name: string; subject: string }, body: string) {
  if (!mailConfigured()) return;
  const sender = await fromAddress({ purpose: "support" });
  const appUrl = env.publicAppUrl.replace(/\/$/, "");
  await sendEmail({
    ...sender,
    to: ticket.email,
    subject: `Re: ${ticket.subject} [#${ticket.number}]`,
    html: brandedEmail({
      heading: `Hi ${ticket.name.split(/\s+/)[0] || "there"},`,
      bodyHtml: renderMarkdown(body),
      cta: { label: "View your ticket", url: `${appUrl}/?support=${ticket.number}` },
      footerNote: `Ticket #${ticket.number} · reply to this email to continue the conversation.`,
    }),
  }).catch((err) => console.error("[support] reply email failed:", err instanceof Error ? err.message : err));
}

// ── User side ────────────────────────────────────────────────────────────────

export async function createTicket(input: {
  userId: string | null;
  email: string;
  name: string;
  subject: string;
  body: string;
  category?: string;
  channel: "app" | "email" | "web" | "console";
  priority?: string;
}) {
  // Priority support is an entitlement (Premium / Enterprise, or a package): those tickets open high.
  const priority = input.priority ?? (input.userId && (await entitlementsFor(input.userId)).prioritySupport ? "high" : "normal");
  const { data: ticket, error } = await supabaseAdmin
    .from("support_tickets")
    .insert({
      user_id: input.userId,
      email: input.email.trim().toLowerCase(),
      name: input.name,
      subject: input.subject.slice(0, 200),
      category: input.category ?? "general",
      channel: input.channel,
      priority,
    })
    .select()
    .single();
  if (error || !ticket) throw new HttpError(500, error?.message ?? "Couldn't open the ticket");
  await supabaseAdmin.from("support_messages").insert({ ticket_id: ticket.id, author_type: "user", author_id: input.userId, body: input.body });
  if (input.channel !== "console") {
    await notifyUser(
      ticket as { number: number; email: string; name: string; subject: string },
      `Thanks for reaching out — we've got your message and a real person on the team will reply soon.\n\n**Your message:**\n\n${input.body.slice(0, 2000)}`,
    );
  }
  return ticket;
}

export async function listTicketsForUser(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("support_tickets")
    .select("id, number, subject, status, category, created_at, last_message_at")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(50);
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function getTicketForUser(userId: string, ticketId: string) {
  const { data: ticket } = await supabaseAdmin.from("support_tickets").select("id, number, subject, status, category, created_at").eq("id", ticketId).eq("user_id", userId).maybeSingle();
  if (!ticket) throw new HttpError(404, "Ticket not found");
  const { data: messages } = await supabaseAdmin
    .from("support_messages")
    .select("id, author_type, body, created_at")
    .eq("ticket_id", ticketId)
    .eq("internal", false)
    .order("created_at");
  return { ...ticket, messages: messages ?? [] };
}

export async function userReply(userId: string, ticketId: string, body: string) {
  const { data: ticket } = await supabaseAdmin.from("support_tickets").select("id, status").eq("id", ticketId).eq("user_id", userId).maybeSingle();
  if (!ticket) throw new HttpError(404, "Ticket not found");
  await supabaseAdmin.from("support_messages").insert({ ticket_id: ticketId, author_type: "user", author_id: userId, body });
  await supabaseAdmin
    .from("support_tickets")
    .update({ status: "open", last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", ticketId);
}

/**
 * Inbound email (from the email provider's inbound webhook, normalised by the controller): a reply
 * whose subject carries "[#1234]" joins that ticket; anything else opens a new one.
 */
export async function ingestEmail(input: { from: string; name?: string; subject: string; text: string }) {
  const email = input.from.trim().toLowerCase();
  const tag = input.subject.match(SUBJECT_TAG);
  if (tag) {
    const { data: ticket } = await supabaseAdmin.from("support_tickets").select("id, email").eq("number", Number(tag[1])).maybeSingle();
    if (ticket && (ticket.email as string).toLowerCase() === email) {
      await supabaseAdmin.from("support_messages").insert({ ticket_id: ticket.id, author_type: "user", body: input.text });
      await supabaseAdmin.from("support_tickets").update({ status: "open", last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", ticket.id);
      return { ticketId: ticket.id as string, created: false };
    }
  }
  const account = await findUserByEmail(email).catch(() => null);
  const ticket = await createTicket({
    userId: account?.id ?? null,
    email,
    name: input.name || account?.full_name || email.split("@")[0]!,
    subject: input.subject.replace(SUBJECT_TAG, "").trim() || "(no subject)",
    body: input.text,
    channel: "email",
  });
  return { ticketId: ticket.id as string, created: true };
}

// ── Staff side ───────────────────────────────────────────────────────────────

export async function listTickets(filter: { status?: string; assigneeId?: string; q?: string; unassigned?: boolean }) {
  let query = supabaseAdmin.from("support_tickets").select("*").order("last_message_at", { ascending: false }).limit(300);
  if (filter.status === "active") query = query.in("status", ["open", "pending"]);
  else if (filter.status) query = query.eq("status", filter.status);
  if (filter.assigneeId) query = query.eq("assignee_id", filter.assigneeId);
  if (filter.unassigned) query = query.is("assignee_id", null);
  if (filter.q) {
    const q = filter.q.replace(/[%,()]/g, " ").trim();
    if (/^#?\d+$/.test(q)) query = query.eq("number", Number(q.replace("#", "")));
    else if (q) query = query.or(`subject.ilike.%${q}%,email.ilike.%${q}%,name.ilike.%${q}%`);
  }
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  const labels = await userLabels((data ?? []).map((t) => t.assignee_id as string | null));
  return (data ?? []).map((t) => ({ ...t, assignee: t.assignee_id ? labels[t.assignee_id as string] ?? null : null }));
}

export async function getTicket(ticketId: string) {
  const { data: ticket } = await supabaseAdmin.from("support_tickets").select("*").eq("id", ticketId).maybeSingle();
  if (!ticket) throw new HttpError(404, "Ticket not found");
  const { data: messages } = await supabaseAdmin.from("support_messages").select("*").eq("ticket_id", ticketId).order("created_at");
  const labels = await userLabels([ticket.assignee_id as string | null, ...(messages ?? []).map((m) => m.author_id as string | null)]);
  let account: { plan: string; createdAt: string } | null = null;
  if (ticket.user_id) {
    const [{ data: profile }, { data: auth }] = await Promise.all([
      supabaseAdmin.from("profiles").select("plan").eq("id", ticket.user_id).maybeSingle(),
      supabaseAdmin.auth.admin.getUserById(ticket.user_id as string),
    ]);
    account = { plan: (profile?.plan as string) ?? "free", createdAt: auth?.user?.created_at ?? "" };
  }
  return {
    ...ticket,
    account,
    assignee: ticket.assignee_id ? labels[ticket.assignee_id as string] ?? null : null,
    messages: (messages ?? []).map((m) => ({ ...m, author: m.author_id ? labels[m.author_id as string] ?? null : null })),
  };
}

export async function staffReply(ticketId: string, staffId: string, body: string, internal: boolean) {
  const { data: ticket } = await supabaseAdmin.from("support_tickets").select("*").eq("id", ticketId).maybeSingle();
  if (!ticket) throw new HttpError(404, "Ticket not found");
  await supabaseAdmin.from("support_messages").insert({ ticket_id: ticketId, author_type: "staff", author_id: staffId, body, internal });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (!internal) {
    patch.last_message_at = new Date().toISOString();
    if (ticket.status === "open") patch.status = "pending";
    if (!ticket.assignee_id) patch.assignee_id = staffId;
  }
  await supabaseAdmin.from("support_tickets").update(patch).eq("id", ticketId);
  if (!internal) await notifyUser(ticket as { number: number; email: string; name: string; subject: string }, body);
}

export async function updateTicket(ticketId: string, patch: { status?: TicketStatus; priority?: string; assigneeId?: string | null; category?: string }, staffId: string) {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const notes: string[] = [];
  if (patch.status !== undefined) {
    update.status = patch.status;
    notes.push(`Status → ${patch.status}`);
  }
  if (patch.priority !== undefined) {
    update.priority = patch.priority;
    notes.push(`Priority → ${patch.priority}`);
  }
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.assigneeId !== undefined) {
    update.assignee_id = patch.assigneeId;
    const who = patch.assigneeId ? (await userLabels([patch.assigneeId]))[patch.assigneeId]?.name : "nobody";
    notes.push(`Assigned to ${who}`);
  }
  const { data, error } = await supabaseAdmin.from("support_tickets").update(update).eq("id", ticketId).select().single();
  if (error || !data) throw new HttpError(404, "Ticket not found");
  if (notes.length) await supabaseAdmin.from("support_messages").insert({ ticket_id: ticketId, author_type: "system", author_id: staffId, body: notes.join(" · "), internal: true });
  return data;
}

export async function supportStats() {
  const statuses: TicketStatus[] = ["open", "pending", "resolved", "closed"];
  const counts = await Promise.all(
    statuses.map(async (s) => {
      const { count } = await supabaseAdmin.from("support_tickets").select("id", { count: "exact", head: true }).eq("status", s);
      return [s, count ?? 0] as const;
    }),
  );
  const { count: unassigned } = await supabaseAdmin
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "pending"])
    .is("assignee_id", null);
  return { ...Object.fromEntries(counts), unassigned: unassigned ?? 0 } as Record<TicketStatus | "unassigned", number>;
}
