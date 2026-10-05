import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { NEW_USER_DAYS } from "./directory.js";

/**
 * Product updates ("What's new"): written in the console, shown ONCE to each matching user as an
 * in-app popup on web/Android/iOS. "Once" is enforced server-side by announcement_views, so it holds
 * across devices; users who sign up while an update is live see it too (nothing is pre-assigned).
 */

export type Audience = "all" | "free" | "paid" | "pro" | "premium" | "new_users";
export type Platform = "web" | "android" | "ios" | "air" | "whatsapp" | "telegram";

export type AnnouncementInput = {
  title: string;
  body: string;
  imageUrl?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  kind: "feature" | "improvement" | "news" | "maintenance";
  audience: Audience;
  platforms: Platform[];
  publishAt?: string | null;
  expiresAt?: string | null;
};

function toRow(input: Partial<AnnouncementInput>) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) row.title = input.title;
  if (input.body !== undefined) row.body = input.body;
  if (input.imageUrl !== undefined) row.image_url = input.imageUrl || null;
  if (input.ctaLabel !== undefined) row.cta_label = input.ctaLabel || null;
  if (input.ctaUrl !== undefined) row.cta_url = input.ctaUrl || null;
  if (input.kind !== undefined) row.kind = input.kind;
  if (input.audience !== undefined) row.audience = input.audience;
  if (input.platforms !== undefined) row.platforms = input.platforms;
  if (input.publishAt !== undefined) row.publish_at = input.publishAt || null;
  if (input.expiresAt !== undefined) row.expires_at = input.expiresAt || null;
  return row;
}

export async function listAnnouncements() {
  const { data, error } = await supabaseAdmin.from("announcements").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) throw new HttpError(500, error.message);
  const ids = (data ?? []).map((a) => a.id as string);
  const seen = new Map<string, { views: number; clicks: number }>();
  if (ids.length) {
    const { data: views } = await supabaseAdmin.from("announcement_views").select("announcement_id, clicked").in("announcement_id", ids);
    for (const v of views ?? []) {
      const s = seen.get(v.announcement_id as string) ?? { views: 0, clicks: 0 };
      s.views++;
      if (v.clicked) s.clicks++;
      seen.set(v.announcement_id as string, s);
    }
  }
  return (data ?? []).map((a) => ({ ...a, stats: seen.get(a.id as string) ?? { views: 0, clicks: 0 } }));
}

export async function createAnnouncement(input: AnnouncementInput, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("announcements")
    .insert({ ...toRow(input), status: "draft", created_by: userId })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't create the update");
  return data;
}

export async function updateAnnouncement(id: string, input: Partial<AnnouncementInput>) {
  const { data, error } = await supabaseAdmin.from("announcements").update(toRow(input)).eq("id", id).select().single();
  if (error || !data) throw new HttpError(404, "Update not found");
  return data;
}

export async function setAnnouncementStatus(id: string, status: "draft" | "published" | "archived") {
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "published") {
    const { data: current } = await supabaseAdmin.from("announcements").select("publish_at").eq("id", id).maybeSingle();
    if (!current) throw new HttpError(404, "Update not found");
    if (!current.publish_at) patch.publish_at = new Date().toISOString();
  }
  const { data, error } = await supabaseAdmin.from("announcements").update(patch).eq("id", id).select().single();
  if (error || !data) throw new HttpError(404, "Update not found");
  return data;
}

export async function deleteAnnouncement(id: string) {
  const { error } = await supabaseAdmin.from("announcements").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
}

/** Does this user belong to the update's audience? (Exported for tests.) */
export function matchesAudience(audience: string, user: { plan: string; createdAt: string }, now = Date.now()): boolean {
  const plan = user.plan || "free";
  switch (audience) {
    case "all":
      return true;
    case "free":
      return plan === "free";
    case "paid":
      return plan !== "free";
    case "pro":
      return plan === "pro";
    case "premium":
      return plan === "premium";
    case "new_users":
      return now - new Date(user.createdAt).getTime() <= NEW_USER_DAYS * 86_400_000;
    default:
      return false;
  }
}

/** Live updates this user hasn't seen yet on this platform — newest first, at most 3. */
export async function pendingForUser(userId: string, platform: Platform) {
  const nowIso = new Date().toISOString();
  const { data: live, error } = await supabaseAdmin
    .from("announcements")
    .select("id, title, body, image_url, cta_label, cta_url, kind, audience, platforms, publish_at, expires_at")
    .eq("status", "published")
    .lte("publish_at", nowIso)
    .contains("platforms", [platform])
    .order("publish_at", { ascending: false })
    .limit(20);
  if (error) {
    // Before migration 0031 the table doesn't exist — the popup simply has nothing to show.
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new HttpError(500, error.message);
  }
  const candidates = (live ?? []).filter((a) => !a.expires_at || (a.expires_at as string) > nowIso);
  if (candidates.length === 0) return [];
  const [{ data: seen }, { data: profile }, { data: auth }] = await Promise.all([
    supabaseAdmin.from("announcement_views").select("announcement_id").eq("user_id", userId).in("announcement_id", candidates.map((a) => a.id)),
    supabaseAdmin.from("profiles").select("plan").eq("id", userId).maybeSingle(),
    supabaseAdmin.auth.admin.getUserById(userId),
  ]);
  const seenIds = new Set((seen ?? []).map((s) => s.announcement_id as string));
  const user = { plan: (profile?.plan as string) ?? "free", createdAt: auth?.user?.created_at ?? new Date().toISOString() };
  return candidates
    .filter((a) => !seenIds.has(a.id as string) && matchesAudience(a.audience as string, user))
    .slice(0, 3)
    .map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      imageUrl: a.image_url,
      ctaLabel: a.cta_label,
      ctaUrl: a.cta_url,
      kind: a.kind,
      publishedAt: a.publish_at,
    }));
}

export async function markSeen(userId: string, announcementIds: string[], clickedId?: string) {
  if (announcementIds.length === 0) return;
  const rows = announcementIds.map((id) => ({ announcement_id: id, user_id: userId, clicked: id === clickedId }));
  const { error } = await supabaseAdmin.from("announcement_views").upsert(rows, { onConflict: "announcement_id,user_id" });
  if (error) throw new HttpError(500, error.message);
}
