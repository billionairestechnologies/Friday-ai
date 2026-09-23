import { useEffect, useState } from "react";

/**
 * Landing point for both Android apps' Google/GitHub OAuth Custom Tab handoff. The backend's
 * OAuth callback redirects here with `#friday_session=<payload>` exactly like it does for the web
 * app's own login (see src/lib/auth/client.ts's consumeHashSession) — this page just re-emits
 * that same hash as a deep link so Android's intent-filter can hand it back to the right app
 * instead of leaving the session stranded in a browser tab the user has to manually close.
 *
 * Three different apps land here, and each needs its own scheme (`?app=ios` is the native iOS
 * app, handled via `com.friday.app.ios://auth-callback`):
 * - The repo-integrated `com.friday.app` (AuthApi.kt) passes `?app=main`, handled via
 *   `com.friday.app://auth-callback`.
 * - The older, separate `ai.friday.app` project passes no `app` param, so it falls back to the
 *   legacy `fridayai://auth-callback` it has always used.
 * These must NOT collide on one scheme: with two apps registered for the same custom scheme,
 * Android can't tell them apart and shows an "Open with" chooser instead of a clean handoff —
 * easy to miss, which read live as Google/GitHub sign-in just "not working".
 *
 * The automatic `window.location.href` redirect is attempted, but a scripted top-level navigation
 * to a non-http(s) scheme isn't always honored by the browser depending on gesture/redirect-chain
 * history, so the visible "Open Friday app" link below is the reliable fallback — a real anchor
 * tap always works.
 */
export function MobileAuthBridge() {
  const [deepLink, setDeepLink] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("friday_session=")) return;
    const app = new URLSearchParams(window.location.search).get("app");
    const scheme = app === "main" ? "com.friday.app" : app === "ios" ? "com.friday.app.ios" : "fridayai";
    const link = `${scheme}://auth-callback${hash}`;
    setDeepLink(link);
    window.location.href = link;
  }, []);

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 text-center text-foreground">
      <div className="flex flex-col items-center">
        <h1 className="text-xl font-semibold">
          {deepLink ? "Signed in" : "Finishing sign-in…"}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {deepLink
            ? "Tap below if the Friday app didn't open automatically."
            : "This will only take a moment."}
        </p>
        {deepLink && (
          <a
            href={deepLink}
            className="mt-6 rounded-full bg-foreground px-6 py-3 text-sm font-medium text-background"
          >
            Open Friday app
          </a>
        )}
      </div>
    </main>
  );
}
