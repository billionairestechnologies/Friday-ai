import { useEffect, useState } from "react";

/**
 * Landing point for the Android app's Google/GitHub OAuth Custom Tab (see AuthRepository.
 * startOAuth in the Android project — googleStart/githubStart pass returnTo=/mobile-auth-bridge).
 * The backend's OAuth callback redirects here with `#friday_session=<payload>` exactly like it
 * does for the web app's own login (see src/lib/auth/client.ts's consumeHashSession) — this page
 * just re-emits that same hash as a `fridayai://auth-callback` deep link so Android's
 * intent-filter can hand it back to the app instead of leaving the session stranded in a browser
 * tab the user has to manually close.
 */
export function MobileAuthBridge() {
  const [handedOff, setHandedOff] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("friday_session=")) return;
    window.location.href = `fridayai://auth-callback${hash}`;
    setHandedOff(true);
  }, []);

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 text-center text-foreground">
      <div>
        <h1 className="text-xl font-semibold">
          {handedOff ? "Signed in — you can close this tab" : "Finishing sign-in…"}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {handedOff
            ? "Return to the Friday app."
            : "If this doesn't redirect automatically, return to the Friday app and try again."}
        </p>
      </div>
    </main>
  );
}
