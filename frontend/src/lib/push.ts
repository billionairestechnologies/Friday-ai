import { api } from "@/lib/api";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Registers this browser for Web Push so a reply that finishes after the tab is closed still
 *  notifies the user. Permission is only requested once (browsers block repeated prompts); if the
 *  user declined, or the browser has no push support, this quietly does nothing. */
export async function registerWebPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission === "denied") return;
  try {
    const { vapidPublicKey } = await api.get<{ vapidPublicKey: string | null }>("/push/config");
    if (!vapidPublicKey) return;
    const registration = await navigator.serviceWorker.register("/sw.js");
    if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
    await api.post("/push/subscriptions", {
      platform: "web",
      token: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
  } catch (err) {
    console.warn("[push] web push registration failed:", err);
  }
}
