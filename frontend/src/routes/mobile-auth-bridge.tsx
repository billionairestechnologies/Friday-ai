import { useEffect, useState } from "react";

/**
 * Landing point for the Android app's Google/GitHub OAuth Custom Tab (see AuthRepository.
 * startOAuth in the Android project — googleStart/githubStart pass returnTo=/mobile-auth-bridge).
 * The backend's OAuth callback redirects here with `#friday_session=<payload>` exactly like it
 * does for the web app's own login (see src/lib/auth/client.ts's consumeHashSession) — this page
 * just re-emits that same hash as a `fridayai://auth-callback` deep link so Android's
 * intent-filter can hand it back to the app instead of leaving the session stranded in a browser
 * tab the user has to manually close.
 *
 * The automatic `window.location.href` redirect is attempted, but Chrome (Custom Tabs included)
 * silently drops a top-level navigation to a non-http(s) scheme when it isn't tied to a real user
 * gesture — and arriving here is itself the tail of a server-side OAuth redirect chain, so there's
 * no gesture to attach to. That left this page stuck forever on "Finishing sign-in…" with no way
 * out. The visible "Open Friday app" link below is a real anchor the user taps themselves, which
 * Chrome always honors, so it's the reliable path — the auto-redirect is just a best-effort head
 * start for cases where the browser allows it.
 */
export function MobileAuthBridge() {
  const [deepLink, setDeepLink] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("friday_session=")) return;
    const link = `fridayai://auth-callback${hash}`;
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
