import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { recordAdminAuditLog } from "./usageService.js";

export type OrganizationRole = "owner" | "admin" | "member";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return base || "team";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const { data } = await supabaseAdmin.from("organizations").select("id").eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
  }
  return `${base}-${randomBytes(4).toString("hex")}`;
}

export async function listOrganizationsForUser(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("organization_memberships")
    .select("role, organizations(id, name, slug, plan, monthly_budget_cents, created_at)")
    .eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);

  return (data ?? [])
    .map((row) => {
      const org = row.organizations as
        | {
            id: string;
            name: string;
            slug: string;
            plan: string;
            monthly_budget_cents: number;
            created_at: string;
          }
        | {
            id: string;
            name: string;
            slug: string;
            plan: string;
            monthly_budget_cents: number;
            created_at: string;
          }[]
        | null;
      const organization = Array.isArray(org) ? org[0] : org;
      if (!organization) return null;
      return {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        plan: organization.plan,
        monthlyBudgetCents: organization.monthly_budget_cents,
        createdAt: organization.created_at,
        role: row.role as OrganizationRole,
      };
    })
    .filter(Boolean);
}

export async function createOrganization(userId: string, name: string) {
  const slug = await uniqueSlug(name);
  const { data: org, error } = await supabaseAdmin
    .from("organizations")
    .insert({
      name: name.trim(),
      slug,
      plan: "free",
      monthly_budget_cents: 0,
      created_by: userId,
    })
    .select("id, name, slug, plan, monthly_budget_cents, created_at")
    .single();
  if (error || !org) throw new HttpError(500, error?.message ?? "Failed to create organization");

  const { error: membershipError } = await supabaseAdmin.from("organization_memberships").insert({
    organization_id: org.id,
    user_id: userId,
    role: "owner",
  });
  if (membershipError) throw new HttpError(500, membershipError.message);

  await recordAdminAuditLog(userId, "organization.create", "organization", org.id as string, {
    name: org.name,
    slug: org.slug,
  });

  return {
    id: org.id as string,
    name: org.name as string,
    slug: org.slug as string,
    plan: org.plan as string,
    monthlyBudgetCents: org.monthly_budget_cents as number,
    createdAt: org.created_at as string,
    role: "owner" as const,
  };
}

async function requireOrgRole(userId: string, organizationId: string, roles: OrganizationRole[]) {
  const { data, error } = await supabaseAdmin
    .from("organization_memberships")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data || !roles.includes(data.role as OrganizationRole)) {
    throw new HttpError(403, "Organization admin access required");
  }
  return data.role as OrganizationRole;
}

export async function updateOrganizationBudget(userId: string, organizationId: string, monthlyBudgetCents: number) {
  await requireOrgRole(userId, organizationId, ["owner", "admin"]);
  const { data, error } = await supabaseAdmin
    .from("organizations")
    .update({ monthly_budget_cents: monthlyBudgetCents })
    .eq("id", organizationId)
    .select("id, name, slug, plan, monthly_budget_cents, created_at")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to update budget");

  await recordAdminAuditLog(userId, "organization.budget_update", "organization", organizationId, {
    monthlyBudgetCents,
  });

  return {
    id: data.id as string,
    name: data.name as string,
    slug: data.slug as string,
    plan: data.plan as string,
    monthlyBudgetCents: data.monthly_budget_cents as number,
    createdAt: data.created_at as string,
  };
}

export async function inviteOrganizationMember(
  userId: string,
  organizationId: string,
  email: string,
  role: "admin" | "member" = "member",
) {
  await requireOrgRole(userId, organizationId, ["owner", "admin"]);
  const normalizedEmail = email.trim().toLowerCase();
  const token = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("organization_invites")
    .insert({
      organization_id: organizationId,
      email: normalizedEmail,
      role,
      invited_by: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    })
    .select("id, email, role, expires_at, created_at")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to create invite");

  await recordAdminAuditLog(userId, "organization.invite", "organization_invite", data.id as string, {
    organizationId,
    email: normalizedEmail,
    role,
  });

  return {
    id: data.id as string,
    email: data.email as string,
    role: data.role as string,
    expiresAt: data.expires_at as string,
    createdAt: data.created_at as string,
    // Returned once so the admin can share it; only the hash is stored.
    inviteToken: token,
  };
}

export async function acceptOrganizationInvite(userId: string, inviteToken: string) {
  const tokenHash = createHash("sha256").update(inviteToken).digest("hex");
  const { data: invite, error } = await supabaseAdmin
    .from("organization_invites")
    .select("id, organization_id, email, role, expires_at, accepted_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!invite) throw new HttpError(404, "Invite not found");
  if (invite.accepted_at) throw new HttpError(409, "Invite already accepted");
  if (new Date(invite.expires_at as string).getTime() < Date.now()) {
    throw new HttpError(410, "Invite expired");
  }

  const { error: membershipError } = await supabaseAdmin.from("organization_memberships").upsert(
    {
      organization_id: invite.organization_id,
      user_id: userId,
      role: invite.role === "admin" ? "admin" : "member",
    },
    { onConflict: "organization_id,user_id" },
  );
  if (membershipError) throw new HttpError(500, membershipError.message);

  const { error: acceptError } = await supabaseAdmin
    .from("organization_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("id", invite.id);
  if (acceptError) throw new HttpError(500, acceptError.message);

  await recordAdminAuditLog(userId, "organization.invite_accept", "organization", invite.organization_id as string, {
    inviteId: invite.id,
  });

  return { organizationId: invite.organization_id as string, role: invite.role as string };
}

export async function listOrganizationMembers(userId: string, organizationId: string) {
  await requireOrgRole(userId, organizationId, ["owner", "admin", "member"]);
  const { data, error } = await supabaseAdmin
    .from("organization_memberships")
    .select("role, created_at, user_id, profiles(full_name)")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  if (error) throw new HttpError(500, error.message);

  return (data ?? []).map((row) => {
    const profile = row.profiles as { full_name: string | null } | { full_name: string | null }[] | null;
    const resolved = Array.isArray(profile) ? profile[0] : profile;
    return {
      userId: row.user_id as string,
      role: row.role as OrganizationRole,
      fullName: resolved?.full_name ?? null,
      joinedAt: row.created_at as string,
    };
  });
}
