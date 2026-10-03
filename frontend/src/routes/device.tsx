import { useEffect, useState } from "react";
import { CheckCircle2, ShieldAlert, Terminal, XCircle } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { LoginPopout } from "@/components/popouts";
import { ApiError, api } from "@/lib/api";
import { setAuthIntent } from "@/lib/auth/intent";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useChat } from "@/lib/chat/store";

type DeviceRequest = { userCode: string; clientName: string | null; clientVersion: string | null; expiresAt: string };
type Phase = "enter" | "confirm" | "approved" | "denied";

/**
 * /device — where `friday login` (CLI) and the editor extensions send people. They sign in as usual, check
 * the code matches the one in THEIR terminal, and approve. Anyone who didn't just run `friday login` should
 * press Deny: the code is the only thing tying this page to a specific terminal.
 */
export function DevicePage() {
  const { user, isPending } = useCurrentUserState();
  const setDialog = useChat((s) => s.setDialog);
  const signedIn = Boolean(user && !user.isDevFallback);
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get("code") ?? "");
  const [request, setRequest] = useState<DeviceRequest | null>(null);
  const [phase, setPhase] = useState<Phase>("enter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup(raw = code) {
    if (!raw.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setRequest(await api.get<DeviceRequest>(`/x/auth/device/${encodeURIComponent(raw.trim())}`));
      setPhase("confirm");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check that code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // A code in the link (?code=ABCD-EFGH) is looked up as soon as the person is signed in.
  useEffect(() => {
    if (signedIn && code && phase === "enter" && !request && !error) void lookup(code);
  }, [signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  async function decide(approve: boolean) {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/x/auth/device/${approve ? "approve" : "deny"}`, { user_code: request.userCode });
      setPhase(approve ? "approved" : "denied");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save your choice. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-md rounded-3xl border border-border bg-elevated p-7 shadow-[var(--shadow-soft)]">
        <div className="mb-5 flex items-center gap-3">
          <BrandMark className="size-9 text-base" />
          <div>
            <p className="text-base font-semibold">Friday X</p>
            <p className="text-xs text-muted">Sign in from your terminal or editor</p>
          </div>
        </div>

        {isPending ? (
          <p className="text-sm text-muted">One moment…</p>
        ) : !signedIn ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">Sign in to your Friday account to connect Friday X. Your plan and usage carry over, exactly as on the web app.</p>
            <button
              type="button"
              onClick={() => {
                setAuthIntent("login");
                setDialog("login");
              }}
              className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background"
            >
              Sign in
            </button>
          </div>
        ) : phase === "enter" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup();
            }}
          >
            <label className="text-sm text-muted" htmlFor="device-code">
              Enter the code shown in your terminal
            </label>
            <input
              id="device-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              maxLength={12}
              className="rounded-2xl border border-border bg-background px-4 py-3 text-center font-mono text-xl tracking-[0.3em] outline-none focus:border-foreground/40"
            />
            <button type="submit" disabled={busy || !code.trim()} className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background disabled:opacity-50">
              {busy ? "Checking…" : "Continue"}
            </button>
          </form>
        ) : phase === "confirm" && request ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-2xl bg-chip p-4">
              <Terminal className="mt-0.5 size-5 shrink-0" />
              <div className="text-sm">
                <p className="font-medium">{request.clientName ?? "Friday X"} wants to sign in as {user?.primaryEmail ?? "you"}</p>
                <p className="mt-1 text-muted">
                  Code <span className="font-mono text-foreground">{request.userCode}</span>. Make sure it matches your terminal.
                </p>
              </div>
            </div>
            <p className="flex items-start gap-2 text-xs text-muted">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              It can use models and tools with your Friday plan and usage. You can sign it out any time in Settings. If you didn't just run <span className="font-mono">friday login</span>, deny it.
            </p>
            <div className="flex gap-3">
              <button type="button" disabled={busy} onClick={() => void decide(false)} className="flex-1 rounded-full border border-border px-5 py-2.5 text-sm font-medium disabled:opacity-50">
                Deny
              </button>
              <button type="button" disabled={busy} onClick={() => void decide(true)} className="flex-1 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background disabled:opacity-50">
                {busy ? "Working…" : "Approve"}
              </button>
            </div>
          </div>
        ) : phase === "approved" ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <CheckCircle2 className="size-10 text-emerald-500" />
            <p className="text-base font-medium">You're connected</p>
            <p className="text-sm text-muted">Go back to your terminal or editor — it signs in by itself. You can close this tab.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <XCircle className="size-10 text-muted" />
            <p className="text-base font-medium">Request denied</p>
            <p className="text-sm text-muted">Nothing was connected. You can close this tab.</p>
          </div>
        )}

        {error ? <p className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
      </div>
      <LoginPopout />
    </div>
  );
}
