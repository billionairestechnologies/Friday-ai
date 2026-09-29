import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { findUserByEmail } from "./directory.js";
import { brandedEmail, fromAddress, mailConfigured, renderMarkdown, sendEmail } from "./mail.js";
import { invalidateStaff, isKnownPermission } from "./permissions.js";

export type StaffRole = { id: string; name: string; description: string; permissions: string[]; is_system: boolean };

export type StaffMemberRow = {
  userId: string;
  email: string | null;
  name: string | null;
  roleId: string;
  title: string;
  team: string;
  active: boolean;
  createdAt: string;
  lastSignInAt: string | null;
};

export async function listRoles(): Promise<StaffRole[]> {
  const { data, error } = await supabaseAdmin.from("staff_roles").select("*").order("is_system", { ascending: false }).order("name");
  if (error) throw new HttpError(500, error.message);
  return (data ?? []) as StaffRole[];
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export async function saveRole(input: { id?: string; name: string; description?: string; permissions: string[] }): Promise<StaffRole> {
  const bad = input.permissions.filter((p) => !isKnownPermission(p));
  if (bad.length) throw new HttpError(400, `Unknown permissions: ${bad.join(", ")}`);
  const id = input.id ?? slug(input.name);
  if (!id) throw new HttpError(400, "Role name is required");
  if (id === "owner") throw new HttpError(400, "The Owner role can't be changed");
  const { data, error } = await supabaseAdmin
    .from("staff_roles")
    .upsert({ id, name: input.name, description: input.description ?? "", permissions: input.permissions }, { onConflict: "id" })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't save role");
  await invalidateMembersOfRole(id);
  return data as StaffRole;
}

export async function deleteRole(id: string): Promise<void> {
  const { data: role } = await supabaseAdmin.from("staff_roles").select("is_system").eq("id", id).maybeSingle();
  if (!role) throw new HttpError(404, "Role not found");
  if (role.is_system) throw new HttpError(400, "Built-in roles can be edited but not deleted");
  const { count } = await supabaseAdmin.from("staff_members").select("user_id", { count: "exact", head: true }).eq("role_id", id);
  if (count) throw new HttpError(400, "Move the people in this role to another role first");
  const { error } = await supabaseAdmin.from("staff_roles").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
}

async function invalidateMembersOfRole(roleId: string) {
  const { data } = await supabaseAdmin.from("staff_members").select("user_id").eq("role_id", roleId);
  for (const row of data ?? []) invalidateStaff(row.user_id as string);
}

export async function listMembers(): Promise<StaffMemberRow[]> {
  const { data, error } = await supabaseAdmin.from("staff_members").select("*").order("created_at");
  if (error) throw new HttpError(500, error.message);
  const rows = await Promise.all(
    (data ?? []).map(async (m) => {
      const [{ data: auth }, { data: profile }] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(m.user_id as string),
        supabaseAdmin.from("profiles").select("full_name").eq("id", m.user_id).maybeSingle(),
      ]);
      return {
        userId: m.user_id as string,
        email: auth?.user?.email ?? null,
        name: (profile?.full_name as string | null) ?? null,
        roleId: m.role_id as string,
        title: m.title as string,
        team: m.team as string,
        active: m.active as boolean,
        createdAt: m.created_at as string,
        lastSignInAt: auth?.user?.last_sign_in_at ?? null,
      };
    }),
  );
  // The original admin account(s) are owners without a staff row — show them too.
  const { data: admins } = await supabaseAdmin.from("profiles").select("id, full_name, created_at").eq("role", "admin");
  for (const admin of admins ?? []) {
    if (rows.some((r) => r.userId === admin.id)) continue;
    const { data: auth } = await supabaseAdmin.auth.admin.getUserById(admin.id as string);
    rows.unshift({
      userId: admin.id as string,
      email: auth?.user?.email ?? null,
      name: (admin.full_name as string | null) ?? null,
      roleId: "owner",
      title: "Account owner",
      team: "",
      active: true,
      createdAt: admin.created_at as string,
      lastSignInAt: auth?.user?.last_sign_in_at ?? null,
    });
  }
  return rows;
}

/**
 * Gives someone Team Console access. An existing Friday account keeps its password; a new person gets
 * an account with a one-time password, emailed to them (they sign in at /admin with password + the
 * emailed code, like the admin). Returns the temporary password only when no email could be sent,
 * so the inviter can hand it over another way.
 */
export async function inviteMember(
  input: { email: string; name: string; roleId: string; title?: string; team?: string },
  invitedBy: string,
): Promise<{ member: StaffMemberRow | undefined; temporaryPassword?: string; emailed: boolean }> {
  const { data: role } = await supabaseAdmin.from("staff_roles").select("id, name").eq("id", input.roleId).maybeSingle();
  if (!role) throw new HttpError(400, "Unknown role");
  const email = input.email.trim().toLowerCase();
  let user = await findUserByEmail(email);
  let temporaryPassword: string | undefined;
  if (!user) {
    temporaryPassword = randomBytes(9).toString("base64url");
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { full_name: input.name },
    });
    if (error || !data.user) throw new HttpError(400, error?.message ?? "Couldn't create the account");
    await supabaseAdmin.from("profiles").update({ full_name: input.name }).eq("id", data.user.id);
    user = { id: data.user.id, email, full_name: input.name } as NonNullable<typeof user>;
  }
  const { error } = await supabaseAdmin.from("staff_members").upsert(
    { user_id: user.id, role_id: input.roleId, title: input.title ?? "", team: input.team ?? "", active: true, invited_by: invitedBy, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) throw new HttpError(500, error.message);
  invalidateStaff(user.id);

  let emailed = false;
  if (mailConfigured()) {
    const consoleUrl = `${env.publicAppUrl.replace(/\/$/, "")}/admin`;
    const body = temporaryPassword
      ? `You've been added to the **Friday Team Console** as **${role.name}**.\n\nSign in at ${consoleUrl} with:\n\n- Email: **${email}**\n- Temporary password: \`${temporaryPassword}\`\n\nYou'll get a one-time code by email to finish signing in. Please change your password after your first sign-in.`
      : `You've been given access to the **Friday Team Console** as **${role.name}**.\n\nSign in at ${consoleUrl} with your usual Friday email and password.`;
    try {
      const sender = await fromAddress({ purpose: "general" });
      await sendEmail({
        ...sender,
        to: email,
        subject: "You've been added to the Friday team",
        html: brandedEmail({ heading: `Welcome to the team, ${input.name.split(/\s+/)[0] || "there"}`, bodyHtml: renderMarkdown(body), cta: { label: "Open the Team Console", url: consoleUrl } }),
      });
      emailed = true;
    } catch (err) {
      console.error("[console] invite email failed:", err instanceof Error ? err.message : err);
    }
  }
  const member = (await listMembers()).find((m) => m.userId === user!.id);
  return { member, emailed, ...(emailed ? {} : { temporaryPassword }) };
}

export async function updateMember(userId: string, patch: { roleId?: string; title?: string; team?: string; active?: boolean }, actorId: string): Promise<void> {
  if (userId === actorId && patch.active === false) throw new HttpError(400, "You can't deactivate yourself");
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.roleId !== undefined) update.role_id = patch.roleId;
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.team !== undefined) update.team = patch.team;
  if (patch.active !== undefined) update.active = patch.active;
  const { error, count } = await supabaseAdmin.from("staff_members").update(update, { count: "exact" }).eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
  if (!count) throw new HttpError(404, "That person isn't on the team (account owners are managed in the database)");
  invalidateStaff(userId);
}

export async function removeMember(userId: string, actorId: string): Promise<void> {
  if (userId === actorId) throw new HttpError(400, "You can't remove yourself");
  const { error } = await supabaseAdmin.from("staff_members").delete().eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
  invalidateStaff(userId);
}

// ── Mail identities ────────────────────────────────────────────────────────

export async function listMailIdentities() {
  const { data, error } = await supabaseAdmin.from("mail_identities").select("*").order("created_at");
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function saveMailIdentity(input: { id?: string; address: string; displayName: string; team?: string; purpose: string; isDefault?: boolean }) {
  if (input.isDefault) await supabaseAdmin.from("mail_identities").update({ is_default: false }).neq("address", input.address);
  const row = {
    address: input.address.trim().toLowerCase(),
    display_name: input.displayName,
    team: input.team ?? "",
    purpose: input.purpose,
    is_default: Boolean(input.isDefault),
  };
  const { data, error } = input.id
    ? await supabaseAdmin.from("mail_identities").update(row).eq("id", input.id).select().single()
    : await supabaseAdmin.from("mail_identities").insert(row).select().single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't save the address");
  return data;
}

export async function deleteMailIdentity(id: string) {
  const { error } = await supabaseAdmin.from("mail_identities").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
}
