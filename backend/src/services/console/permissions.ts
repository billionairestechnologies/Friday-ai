import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError, asyncHandler } from "../../middleware/errorHandler.js";
import { memoAsync } from "../../utils/ttlMemo.js";

/**
 * Team Console access control. A staff member's role (a row in `staff_roles`) is a list of
 * permission strings; roles are data, editable from the console. This file only defines the
 * vocabulary — which permissions exist and what they mean — so the console can render a role editor
 * and every route can say exactly what it needs.
 *
 * Matching: "*" grants everything, "crm.*" grants every crm permission, otherwise exact.
 * profiles.role = 'admin' accounts are always owners (the original single-admin setup keeps working).
 */
export const PERMISSIONS = [
  { id: "overview.view", group: "Overview", label: "See the dashboard and KPIs" },
  { id: "users.view", group: "Users", label: "Look up users, plans and usage" },
  { id: "users.manage", group: "Users", label: "Change plans and caps, suspend accounts" },
  { id: "credits.view", group: "Credits", label: "See credit grants, balances and approvals" },
  { id: "credits.grant", group: "Credits", label: "Grant bonus credits (one person or a bulk audience) and revoke them" },
  { id: "credits.approve", group: "Credits", label: "Approve or reject grants above the approval threshold (not your own)" },
  { id: "credits.settings", group: "Credits", label: "Change the approval threshold and grant limits" },
  { id: "team.manage", group: "Team", label: "Invite teammates, edit roles and access" },
  { id: "updates.view", group: "Updates", label: "See product updates" },
  { id: "updates.manage", group: "Updates", label: "Create and publish product updates" },
  { id: "marketing.view", group: "Marketing", label: "See email campaigns" },
  { id: "marketing.manage", group: "Marketing", label: "Create and edit email campaigns" },
  { id: "marketing.send", group: "Marketing", label: "Send and schedule campaigns" },
  { id: "crm.view", group: "CRM", label: "See leads and clients" },
  { id: "crm.manage", group: "CRM", label: "Create and edit leads, clients and the pipeline" },
  { id: "support.view", group: "Support", label: "See support tickets" },
  { id: "support.reply", group: "Support", label: "Reply to users and add notes" },
  { id: "support.manage", group: "Support", label: "Assign, prioritise and close tickets" },
  { id: "tasks.view", group: "Tasks", label: "See team tasks" },
  { id: "tasks.manage", group: "Tasks", label: "Create, assign and update tasks" },
  { id: "plans.view", group: "Plans & Offers", label: "See packages, offers and access grants" },
  { id: "plans.review", group: "Plans & Offers", label: "Approve or reject student passes and other reviewed offers" },
  { id: "plans.manage", group: "Plans & Offers", label: "Build packages, create offers, grant and revoke access" },
  { id: "providers.view", group: "Models", label: "See model providers and keys" },
  { id: "providers.manage", group: "Models", label: "Manage providers, keys and model tiers" },
  { id: "models.multipliers", group: "Models", label: "Change model usage multipliers (how much of a plan's allowance each model costs)" },
  { id: "mail.manage", group: "Mail", label: "Manage team mail addresses, company domains and employee mailboxes" },
  { id: "mailbox.use", group: "Mail", label: "Use the Mailbox (own company mailbox + Gmail/other accounts)" },
  { id: "finance.view", group: "Finance", label: "See model prices, profitability, revenue and expenses" },
  { id: "finance.manage", group: "Finance", label: "Edit model prices, FX/markup settings and expenses" },
  { id: "audit.view", group: "Audit", label: "See the audit log" },
  { id: "status.view", group: "Status", label: "See system status, incidents and crash reports" },
  { id: "status.manage", group: "Status", label: "Post incidents and status updates" },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["id"];
const KNOWN = new Set<string>(PERMISSIONS.map((p) => p.id));

export function isKnownPermission(value: string): boolean {
  return value === "*" || KNOWN.has(value) || (value.endsWith(".*") && PERMISSIONS.some((p) => p.id.startsWith(value.slice(0, -1))));
}

export function hasPermission(granted: readonly string[], needed: string): boolean {
  if (granted.includes("*") || granted.includes(needed)) return true;
  const group = needed.split(".")[0];
  return granted.includes(`${group}.*`);
}

export type StaffContext = {
  userId: string;
  email: string | null;
  name: string | null;
  roleId: string;
  roleName: string;
  title: string;
  team: string;
  permissions: string[];
  /** Everything, including team/roles management. */
  isOwner: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: StaffContext;
    }
  }
}

async function loadStaffUncached(userId: string): Promise<StaffContext | null> {
  const { data: profile } = await supabaseAdmin.from("profiles").select("full_name, role").eq("id", userId).maybeSingle();
  const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
  const email = authUser?.user?.email ?? null;
  const name = (profile?.full_name as string | null) ?? null;
  if (profile?.role === "admin") {
    return { userId, email, name, roleId: "owner", roleName: "Owner", title: "", team: "", permissions: ["*"], isOwner: true };
  }
  const { data: member } = await supabaseAdmin
    .from("staff_members")
    .select("role_id, title, team, active, staff_roles(name, permissions)")
    .eq("user_id", userId)
    .maybeSingle();
  if (!member || !member.active) return null;
  const role = (Array.isArray(member.staff_roles) ? member.staff_roles[0] : member.staff_roles) as { name: string; permissions: string[] } | null;
  const permissions = role?.permissions ?? [];
  return {
    userId,
    email,
    name,
    roleId: member.role_id as string,
    roleName: role?.name ?? (member.role_id as string),
    title: (member.title as string) ?? "",
    team: (member.team as string) ?? "",
    permissions,
    isOwner: permissions.includes("*"),
  };
}

/** Short cache: every console request needs this, and roles change rarely (invalidated on edit). */
export const loadStaff = memoAsync(30_000, async (userId: string) => (await loadStaffUncached(userId)) ?? false, (id) => id);

export async function getStaff(userId: string): Promise<StaffContext | null> {
  return (await loadStaff(userId)) || null;
}

export function invalidateStaff(userId: string) {
  loadStaff.invalidate(userId);
}

/** After requireAuth: 403 unless the caller is an active staff member (or an admin account). */
export const requireStaff = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const staff = req.user ? await getStaff(req.user.id) : null;
  if (!staff) throw new HttpError(403, "Team Console access required");
  req.staff = staff;
  next();
});

export function requirePermission(needed: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.staff || !hasPermission(req.staff.permissions, needed)) {
      throw new HttpError(403, `You don't have permission for this (${needed})`);
    }
    next();
  };
}

/** Passes when the staff member has ANY of the listed permissions. */
export function requireAnyPermission(...needed: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.staff || !needed.some((p) => hasPermission(req.staff!.permissions, p))) {
      throw new HttpError(403, `You don't have permission for this (${needed.join(" or ")})`);
    }
    next();
  };
}
