import { useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { POLICY_VERSION } from "@/lib/site/legal";

// The backdrop is a light dim (not an opaque wash) so the app stays visible behind the box, like every other dialog.

// Routes that must stay reachable even while the gate would otherwise apply: the policy pages
// themselves (so there's somewhere for the gate's own links to open), the OAuth hand-off page
// (mobile-auth-bridge briefly holds a signed-in user mid-relay to the native app — blocking it
// here would strand that relay), and the separate admin login gate (its own auth, not this one).
const EXEMPT_PATHS = ["/privacy", "/terms", "/status", "/mobile-auth-bridge", "/admin"];

/**
 * Blocks the app behind a full-screen, non-dismissable "I agree" screen for any signed-in
 * account whose `policyVersion` doesn't match the currently-in-force POLICY_VERSION — that's
 * every account created before this shipped (policyVersion is null), and any account that agreed
 * to an older version after a material policy change. A brand-new signup already agreed via the
 * signup form's own checkbox (see popouts.tsx), so it never sees this. Mounted once, in
 * routes/__root.tsx, so it applies regardless of which page is open.
 */
export function ConsentGate() {
  const { user, isPending } = useCurrentUserState();
  const acceptPolicy = useAuthStore((s) => s.acceptPolicy);
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedIn = Boolean(user && !user.isDevFallback);
  const exempt = EXEMPT_PATHS.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`));
  const needsAcceptance = signedIn && user!.policyVersion !== POLICY_VERSION;

  if (isPending || !needsAcceptance || exempt) return null;

  async function agree() {
    setBusy(true);
    setError(null);
    try {
      // A hung request (dropped connection, a backend that never responds) would otherwise leave
      // this saying "Saving…" forever with no way out but for the user to already know to reload —
      // this screen has to always resolve to either "through" or "a visible error with a way out".
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out — check your connection and try again.")), 15000));
      await Promise.race([acceptPolicy(), timeout]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    // pointer-events-auto guards against an ancestor (a dialog/overlay elsewhere in the tree that
    // failed to close — see client.ts's bootstrap()/verifyOtp() fix for why one could get stuck
    // open) leaving `pointer-events: none` inherited down to here: this is the one screen that must
    // always stay clickable no matter what else is going on behind it.
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/45 px-4 backdrop-blur-[2px] pointer-events-auto">
      <div className="w-full max-w-md rounded-[var(--radius-2xl)] border border-border bg-surface p-6 shadow-[var(--shadow-panel)] sm:p-8">
        <h1 className="text-lg font-semibold text-foreground">Updated Terms &amp; Privacy Policy</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Before you continue, please review and agree to our{" "}
          <a href="/terms" target="_blank" rel="noreferrer" className="underline hover:text-foreground">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-foreground">
            Privacy Policy
          </a>
          . They cover what Friday stores, which AI providers and connectors your messages can reach, and the controls you have over your data.
        </p>
        {error && (
          <p className="mt-3 text-sm text-danger">
            {error}{" "}
            <button type="button" onClick={() => window.location.reload()} className="underline hover:text-foreground">
              Reload and try again
            </button>
          </p>
        )}
        <button
          type="button"
          onClick={() => void agree()}
          disabled={busy}
          className="mt-6 h-11 w-full rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-transform duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
        >
          {busy ? "Saving…" : "I Agree"}
        </button>
      </div>
    </div>
  );
}
