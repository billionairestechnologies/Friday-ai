import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";

export type DirectoryUser = {
  id: string;
  email: string | null;
  full_name: string | null;
  plan: string;
  role: string;
  created_at: string;
  last_sign_in_at: string | null;
  marketing_opt_out: boolean;
  banned_until: string | null;
};

/** Users joined with their auth email (see console_user_directory in migration 0031). */
export async function searchUsers(search: string | null, limit = 50, offset = 0): Promise<DirectoryUser[]> {
  const { data, error } = await supabaseAdmin.rpc("console_user_directory", { p_search: search || null, p_limit: limit, p_offset: offset });
  if (error) throw new HttpError(500, `User directory unavailable (is migration 0031 applied?): ${error.message}`);
  return (data ?? []) as DirectoryUser[];
}

export async function findUserByEmail(email: string): Promise<DirectoryUser | null> {
  const wanted = email.trim().toLowerCase();
  const rows = await searchUsers(wanted, 20);
  return rows.find((u) => u.email?.toLowerCase() === wanted) ?? null;
}

/** Display info for a set of user ids (staff names on tickets, owners on contacts…). */
export async function userLabels(ids: (string | null | undefined)[]): Promise<Record<string, { name: string; email: string | null }>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return {};
  const { data: profiles } = await supabaseAdmin.from("profiles").select("id, full_name").in("id", unique);
  const out: Record<string, { name: string; email: string | null }> = {};
  await Promise.all(
    unique.map(async (id) => {
      const profile = (profiles ?? []).find((p) => p.id === id);
      const { data } = await supabaseAdmin.auth.admin.getUserById(id);
      const email = data?.user?.email ?? null;
      out[id] = { name: (profile?.full_name as string | null) || email?.split("@")[0] || "Unknown", email };
    }),
  );
  return out;
}

/** How recent counts as a "new user" for audiences (announcements + campaigns). */
export const NEW_USER_DAYS = 14;
export function newUserSince(): string {
  return new Date(Date.now() - NEW_USER_DAYS * 86_400_000).toISOString();
}
