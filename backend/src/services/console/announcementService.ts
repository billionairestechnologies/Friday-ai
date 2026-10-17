import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { NEW_USER_DAYS } from "./directory.js";

/**
 * Product updates ("What's new"): written in the console, shown ONCE to each matching user as an
 * in-app popup on web/Android/iOS. "Once" is enforced server-side by announcement_views, so it holds
 * across devices; users who sign up while an update is live see it too (nothing is pre-assigned).
 */

export type Audience = "all" | "free" | "paid" | "pro" | "premium" | "new_users";
export type Platform = "web" | "android" | "ios";

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
  /** Higher shows first. */
  priority?: number;
  variant?: "modal" | "banner";
  accent?: "default" | "blue" | "green" | "amber" | "purple" | "red";
  icon?: "sparkles" | "rocket" | "gift" | "wrench" | "shield" | "megaphone" | "graduation";
  cta2Label?: string | null;
  cta2Url?: string | null;
};

/**
 * CTA destinations are allow-listed: an in-app path ("/plans", "/?support=programs") or an https
 * URL. Never javascript:, data:, protocol-relative "//evil" or plain http — the console must not be
 * able to ship an executable link to every user.
 */
export function safeCtaUrl(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (u.startsWith("/") && !u.startsWith("//") && !/[\s<>"'`]/.test(u)) return u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return parsed.toString();
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Links must be an in-app path like /plans or an https:// address.");
}

function toRow(input: Partial<AnnouncementInput>) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) row.title = input.title;
  if (input.body !== undefined) row.body = input.body;
  if (input.imageUrl !== undefined) row.image_url = input.imageUrl || null;
  if (input.ctaLabel !== undefined) row.cta_label = input.ctaLabel || null;
  if (input.ctaUrl !== undefined) row.cta_url = safeCtaUrl(input.ctaUrl);
  if (input.cta2Label !== undefined) row.cta2_label = input.cta2Label || null;
  if (input.cta2Url !== undefined) row.cta2_url = safeCtaUrl(input.cta2Url);
  if (input.priority !== undefined) row.priority = input.priority;
  if (input.variant !== undefined) row.variant = input.variant;
  if (input.accent !== undefined) row.accent = input.accent;
  if (input.icon !== undefined) row.icon = input.icon;
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
  type Stats = { views: number; clicks: number; acknowledged: number; dismissed: number };
  const seen = new Map<string, Stats>();
  const version = new Map((data ?? []).map((a) => [a.id as string, Number(a.version ?? 1)]));
  if (ids.length) {
    const { data: views } = await supabaseAdmin.from("announcement_views").select("announcement_id, clicked, state, version").in("announcement_id", ids);
    for (const v of views ?? []) {
      // Stats are for the CURRENT version (a re-published update starts counting again).
      if (Number(v.version ?? 1) !== version.get(v.announcement_id as string)) continue;
      const s = seen.get(v.announcement_id as string) ?? { views: 0, clicks: 0, acknowledged: 0, dismissed: 0 };
      s.views++;
      if (v.clicked || v.state === "clicked") s.clicks++;
      if (v.state === "acknowledged") s.acknowledged++;
      if (v.state === "dismissed") s.dismissed++;
      seen.set(v.announcement_id as string, s);
    }
  }
  return (data ?? []).map((a) => ({ ...a, stats: seen.get(a.id as string) ?? { views: 0, clicks: 0, acknowledged: 0, dismissed: 0 } }));
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

/** Live updates this person hasn't been shown yet (in their current version) on this platform — priority first, at most 3. */
export async function pendingForUser(userId: string, platform: Platform) {
  const nowIso = new Date().toISOString();
  const { data: live, error } = await supabaseAdmin
    .from("announcements")
    .select("*")
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
    supabaseAdmin.from("announcement_views").select("announcement_id, version").eq("user_id", userId).in("announcement_id", candidates.map((a) => a.id)),
    supabaseAdmin.from("profiles").select("plan").eq("id", userId).maybeSingle(),
    supabaseAdmin.auth.admin.getUserById(userId),
  ]);
  const seenKeys = new Set((seen ?? []).map((s) => `${s.announcement_id}:${s.version ?? 1}`));
  const user = { plan: (profile?.plan as string) ?? "free", createdAt: auth?.user?.created_at ?? new Date().toISOString() };
  return candidates
    .filter((a) => !seenKeys.has(`${a.id}:${a.version ?? 1}`) && matchesAudience(a.audience as string, user))
    .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0))
    .slice(0, 3)
    .map((a) => ({
      id: a.id as string,
      version: Number(a.version ?? 1),
      title: a.title,
      body: a.body,
      imageUrl: a.image_url,
      ctaLabel: a.cta_label,
      ctaUrl: a.cta_url,
      cta2Label: a.cta2_label ?? null,
      cta2Url: a.cta2_url ?? null,
      kind: a.kind,
      variant: (a.variant as string) ?? "modal",
      accent: (a.accent as string) ?? "default",
      icon: (a.icon as string) ?? "sparkles",
      publishedAt: a.publish_at,
    }));
}

/** Claims the right to show one version now (atomic: one tab / device wins). */
export async function claimDisplay(userId: string, id: string, version: number, platform: Platform): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("announcement_claim", { p_announcement: id, p_user: userId, p_version: version, p_platform: platform });
  if (error) throw new HttpError(500, error.message);
  return data === true;
}

export async function recordAction(userId: string, id: string, version: number, state: "dismissed" | "acknowledged" | "clicked") {
  const { error } = await supabaseAdmin.rpc("announcement_act", { p_announcement: id, p_user: userId, p_version: version, p_state: state });
  if (error) throw new HttpError(500, error.message);
}

/**
 * Older app builds (Android/iOS before 0062) report "seen" for the items they showed: recorded as
 * displayed + acknowledged for each update's current version, so they never pop up again there.
 */
export async function markSeen(userId: string, announcementIds: string[], clickedId?: string) {
  if (announcementIds.length === 0) return;
  const { data } = await supabaseAdmin.from("announcements").select("id, version").in("id", announcementIds);
  for (const a of data ?? []) {
    const version = Number(a.version ?? 1);
    await claimDisplay(userId, a.id as string, version, "web").catch(() => false);
    await recordAction(userId, a.id as string, version, a.id === clickedId ? "clicked" : "acknowledged").catch(() => undefined);
  }
}

/** "Show it again": a published update becomes a new version that everyone in its audience sees once more. */
export async function publishNewVersion(id: string) {
  const { data: a } = await supabaseAdmin.from("announcements").select("version, status").eq("id", id).maybeSingle();
  if (!a) throw new HttpError(404, "Update not found");
  if (a.status !== "published") throw new HttpError(409, "Only a published update can be shown again.");
  const { data, error } = await supabaseAdmin
    .from("announcements")
    .update({ version: Number(a.version ?? 1) + 1, publish_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("version", a.version)
    .select()
    .single();
  if (error || !data) throw new HttpError(409, "Someone changed this update at the same time — reload and try again.");
  return data;
}

/** The person's What's New history for the inbox (published, matching audience, newest first). */
export async function historyForUser(userId: string, platform: Platform) {
  const nowIso = new Date().toISOString();
  const { data } = await supabaseAdmin
    .from("announcements")
    .select("id, title, body, cta_label, cta_url, kind, audience, publish_at, expires_at, icon")
    .eq("status", "published")
    .lte("publish_at", nowIso)
    .contains("platforms", [platform])
    .order("publish_at", { ascending: false })
    .limit(20);
  const { data: profile } = await supabaseAdmin.from("profiles").select("plan, created_at").eq("id", userId).maybeSingle();
  const user = { plan: (profile?.plan as string) ?? "free", createdAt: (profile?.created_at as string) ?? nowIso };
  return (data ?? [])
    .filter((a) => matchesAudience(a.audience as string, user))
    .slice(0, 10)
    .map((a) => ({ id: a.id as string, title: a.title as string, body: a.body as string, ctaLabel: a.cta_label as string | null, ctaUrl: a.cta_url as string | null, kind: a.kind as string, icon: (a.icon as string) ?? "sparkles", publishedAt: a.publish_at as string }));
}
