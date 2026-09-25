import webpush from "web-push";
import { supabaseAdmin } from "../config/supabase.js";

type Platform = "web" | "android" | "ios";
type Sub = { id: string; platform: Platform; token: string; keys: { p256dh: string; auth: string } | null };

const vapidPublic = process.env.VAPID_PUBLIC_KEY ?? "";
const vapidPrivate = process.env.VAPID_PRIVATE_KEY ?? "";
const vapidReady = Boolean(vapidPublic && vapidPrivate);
if (vapidReady) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@friday.app", vapidPublic, vapidPrivate);
}

export function getVapidPublicKey(): string | null {
  return vapidReady ? vapidPublic : null;
}

// firebase-admin is loaded lazily and only when FCM_SERVICE_ACCOUNT_JSON is set, so the server
// boots fine (and web push still works) before a Firebase project has been wired up.
type Fcm = { send(message: Record<string, unknown>): Promise<string> };
let fcmPromise: Promise<Fcm | null> | null = null;
function getFcm(): Promise<Fcm | null> {
  fcmPromise ??= (async () => {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    try {
      const { initializeApp, getApps, cert } = await import("firebase-admin/app");
      const { getMessaging } = await import("firebase-admin/messaging");
      const app = getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(raw)) });
      return getMessaging(app) as unknown as Fcm;
    } catch (err) {
      console.error("[push] FCM init failed:", err instanceof Error ? err.message : err);
      return null;
    }
  })();
  return fcmPromise;
}

export async function saveSubscription(
  userId: string,
  platform: Platform,
  token: string,
  keys: { p256dh: string; auth: string } | null,
) {
  const { error } = await supabaseAdmin
    .from("push_subscriptions")
    .upsert({ user_id: userId, platform, token, keys }, { onConflict: "token" });
  if (error) throw new Error(error.message);
}

export async function removeSubscription(userId: string, token: string) {
  await supabaseAdmin.from("push_subscriptions").delete().eq("user_id", userId).eq("token", token);
}

export type PushPayload = { title: string; body: string; conversationId?: string };

export async function notifyUser(userId: string, payload: PushPayload): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, platform, token, keys")
    .eq("user_id", userId);
  if (error || !data?.length) return;

  const dead: string[] = [];
  await Promise.all(
    (data as Sub[]).map(async (sub) => {
      try {
        if (sub.platform === "web") {
          if (!vapidReady || !sub.keys) return;
          await webpush.sendNotification(
            { endpoint: sub.token, keys: sub.keys },
            JSON.stringify(payload),
            { TTL: 60 * 60 },
          );
        } else {
          const fcm = await getFcm();
          if (!fcm) return;
          await fcm.send({
            token: sub.token,
            notification: { title: payload.title, body: payload.body },
            data: payload.conversationId ? { conversationId: payload.conversationId } : {},
            android: { priority: "high" },
          });
        }
      } catch (err) {
        const code = (err as { statusCode?: number; code?: string }).statusCode;
        const fcmCode = (err as { code?: string }).code ?? "";
        if (code === 404 || code === 410 || fcmCode.includes("registration-token-not-registered")) {
          dead.push(sub.id);
        } else {
          console.error("[push] send failed:", err instanceof Error ? err.message : err);
        }
      }
    }),
  );
  if (dead.length) await supabaseAdmin.from("push_subscriptions").delete().in("id", dead);
}
