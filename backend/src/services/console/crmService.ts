import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { findUserByEmail, userLabels } from "./directory.js";

/**
 * CRM for the team: leads and clients on a configurable pipeline (crm_stages rows, not constants),
 * an activity timeline per contact (notes, calls, emails, meetings, automatic stage changes), owners,
 * value, tags — and an automatic link to the person's Friday account when the email matches, so the
 * team sees their plan and usage next to the deal.
 */

export type ContactInput = {
  kind?: "lead" | "client";
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  source?: string;
  stageId?: string;
  ownerId?: string | null;
  value?: number;
  currency?: string;
  tags?: string[];
  notes?: string;
};

function toRow(input: Partial<ContactInput>) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.kind !== undefined) row.kind = input.kind;
  if (input.name !== undefined) row.name = input.name;
  if (input.email !== undefined) row.email = input.email?.trim().toLowerCase() || null;
  if (input.phone !== undefined) row.phone = input.phone || null;
  if (input.company !== undefined) row.company = input.company || null;
  if (input.source !== undefined) row.source = input.source;
  if (input.stageId !== undefined) row.stage_id = input.stageId;
  if (input.ownerId !== undefined) row.owner_id = input.ownerId || null;
  if (input.value !== undefined) row.value = input.value;
  if (input.currency !== undefined) row.currency = input.currency;
  if (input.tags !== undefined) row.tags = input.tags;
  if (input.notes !== undefined) row.notes = input.notes;
  return row;
}

export async function listStages() {
  const { data, error } = await supabaseAdmin.from("crm_stages").select("*").order("position");
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function saveStage(input: { id: string; name: string; position: number; outcome: "open" | "won" | "lost"; color: string }) {
  const { data, error } = await supabaseAdmin.from("crm_stages").upsert(input, { onConflict: "id" }).select().single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't save the stage");
  return data;
}

export async function deleteStage(id: string) {
  const { count } = await supabaseAdmin.from("crm_contacts").select("id", { count: "exact", head: true }).eq("stage_id", id);
  if (count) throw new HttpError(400, "Move the contacts in this stage first");
  const { error } = await supabaseAdmin.from("crm_stages").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
}

export async function listContacts(filter: { q?: string; kind?: string; stageId?: string; ownerId?: string; limit?: number }) {
  let query = supabaseAdmin.from("crm_contacts").select("*").order("last_activity_at", { ascending: false }).limit(Math.min(filter.limit ?? 300, 1000));
  if (filter.kind) query = query.eq("kind", filter.kind);
  if (filter.stageId) query = query.eq("stage_id", filter.stageId);
  if (filter.ownerId) query = query.eq("owner_id", filter.ownerId);
  if (filter.q) {
    const q = filter.q.replace(/[%,()]/g, " ").trim();
    if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,company.ilike.%${q}%`);
  }
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  const labels = await userLabels((data ?? []).map((c) => c.owner_id as string | null));
  return (data ?? []).map((c) => ({ ...c, owner: c.owner_id ? labels[c.owner_id as string] ?? null : null }));
}

async function linkAccount(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  return (await findUserByEmail(email).catch(() => null))?.id ?? null;
}

export async function createContact(input: ContactInput, actorId: string) {
  const row = { ...toRow(input), created_by: actorId, user_id: await linkAccount(input.email), owner_id: input.ownerId ?? actorId };
  const { data, error } = await supabaseAdmin.from("crm_contacts").insert(row).select().single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't create the contact");
  await addActivity(data.id as string, { kind: "system", body: `Created as a ${data.kind}` }, actorId);
  return data;
}

export async function updateContact(id: string, input: Partial<ContactInput>, actorId: string) {
  const { data: before } = await supabaseAdmin.from("crm_contacts").select("stage_id, kind, email").eq("id", id).maybeSingle();
  if (!before) throw new HttpError(404, "Contact not found");
  const row = toRow(input);
  if (input.email !== undefined && input.email !== before.email) row.user_id = await linkAccount(input.email);
  // Winning a deal makes the lead a client.
  if (input.stageId && input.stageId !== before.stage_id) {
    const { data: stage } = await supabaseAdmin.from("crm_stages").select("name, outcome").eq("id", input.stageId).maybeSingle();
    if (stage?.outcome === "won" && before.kind === "lead" && input.kind === undefined) row.kind = "client";
    row.last_activity_at = new Date().toISOString();
    await addActivity(id, { kind: "stage_change", body: `Moved to ${stage?.name ?? input.stageId}`, meta: { from: before.stage_id, to: input.stageId } }, actorId);
  }
  const { data, error } = await supabaseAdmin.from("crm_contacts").update(row).eq("id", id).select().single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't save");
  return data;
}

export async function deleteContact(id: string) {
  const { error } = await supabaseAdmin.from("crm_contacts").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
}

export async function getContact(id: string) {
  const { data: contact } = await supabaseAdmin.from("crm_contacts").select("*").eq("id", id).maybeSingle();
  if (!contact) throw new HttpError(404, "Contact not found");
  const { data: activities } = await supabaseAdmin.from("crm_activities").select("*").eq("contact_id", id).order("created_at", { ascending: false }).limit(200);
  const labels = await userLabels([contact.owner_id as string | null, ...(activities ?? []).map((a) => a.author_id as string | null)]);
  let account: { plan: string; createdAt: string } | null = null;
  if (contact.user_id) {
    const [{ data: profile }, { data: auth }] = await Promise.all([
      supabaseAdmin.from("profiles").select("plan").eq("id", contact.user_id).maybeSingle(),
      supabaseAdmin.auth.admin.getUserById(contact.user_id as string),
    ]);
    account = { plan: (profile?.plan as string) ?? "free", createdAt: auth?.user?.created_at ?? "" };
  }
  return {
    ...contact,
    owner: contact.owner_id ? labels[contact.owner_id as string] ?? null : null,
    account,
    activities: (activities ?? []).map((a) => ({ ...a, author: a.author_id ? labels[a.author_id as string] ?? null : null })),
  };
}

export async function addActivity(contactId: string, input: { kind: string; body: string; meta?: Record<string, unknown> }, actorId: string) {
  const { data, error } = await supabaseAdmin
    .from("crm_activities")
    .insert({ contact_id: contactId, kind: input.kind, body: input.body, meta: input.meta ?? {}, author_id: actorId })
    .select()
    .single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't add the activity");
  await supabaseAdmin.from("crm_contacts").update({ last_activity_at: new Date().toISOString() }).eq("id", contactId);
  return data;
}

/** Pipeline value per stage + counts, for the CRM header and the dashboard. */
export async function pipelineSummary() {
  const [stages, { data: contacts }] = await Promise.all([listStages(), supabaseAdmin.from("crm_contacts").select("stage_id, kind, value")]);
  return stages.map((s) => {
    const inStage = (contacts ?? []).filter((c) => c.stage_id === s.id);
    return { stageId: s.id, name: s.name, color: s.color, outcome: s.outcome, count: inStage.length, value: inStage.reduce((n, c) => n + Number(c.value ?? 0), 0) };
  });
}
