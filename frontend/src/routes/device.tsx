import { useEffect, useState } from "react";
import { Check, Laptop, Lock, LogOut, ShieldCheck, Terminal, X } from "lucide-react";
import { LoginPopout } from "@/components/popouts";
import { ApiError, api } from "@/lib/api";
import { setAuthIntent } from "@/lib/auth/intent";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useChat } from "@/lib/chat/store";
import { cn } from "@/lib/utils";

type DeviceRequest = { userCode: string; clientName: string | null; clientVersion: string | null; expiresAt: string };
type Phase = "enter" | "confirm" | "approved" | "denied";

/** The Friday mark (a white wordmark on a rounded black square), the same asset the browser tab uses. */
function FridayLogo({ className }: { className?: string }) {
  return <img src="/icon-192.png" alt="Friday" width={56} height={56} className={cn("size-14 rounded-2xl shadow-[0_8px_30px_-8px_rgba(0,0,0,0.45)]", className)} />;
}

/** The code, shown big and split in two groups so it can be compared with the terminal at a glance. */
function CodeBlocks({ code }: { code: string }) {
  const [a = "", b = ""] = code.split("-");
  return (
    <div className="flex items-center justify-center gap-2.5" aria-label={`Code ${code}`}>
      {[a, b].map((group, i) => (
        <div key={i} className="flex gap-1.5">
          {group.split("").map((ch, j) => (
            <span key={j} className="grid h-12 w-9 place-items-center rounded-xl border border-border bg-background font-mono text-xl font-semibold tracking-tight text-foreground shadow-sm">
              {ch}
            </span>
          ))}
          {i === 0 ? <span className="mx-1 self-center text-muted">–</span> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * /device — where `friday login` (terminal) and the editor integrations send people. They sign in as usual, check
 * the code matches the one in THEIR terminal, and approve. Anyone who didn't just run `friday login` should press
 * Deny: the code is the only thing tying this page to a specific terminal.
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

  const email = user?.primaryEmail ?? "your account";
  const initial = (user?.displayName ?? email).trim().charAt(0).toUpperCase() || "F";

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10 text-foreground">
      {/* soft light behind the card; decorative only */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-0 [background:radial-gradient(60rem_40rem_at_50%_-10%,color-mix(in_oklab,var(--color-foreground)_9%,transparent),transparent_70%)]" />

      <main className="relative z-10 w-full max-w-[28rem]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <FridayLogo />
          <div>
            <h1 className="text-[1.65rem] font-semibold tracking-tight">FridayX</h1>
            <p className="mt-0.5 text-sm text-muted">Friday's coding agent for your terminal and editor</p>
          </div>
        </div>

        <div className="rounded-[1.75rem] border border-border bg-elevated p-6 shadow-[0_20px_60px_-24px_rgba(0,0,0,0.35)]">
          {isPending ? (
            <p className="py-8 text-center text-sm text-muted">One moment…</p>
          ) : !signedIn ? (
            <div className="flex flex-col gap-5">
              <div className="text-center">
                <h2 className="text-lg font-semibold">Sign in to connect</h2>
                <p className="mt-1.5 text-sm text-muted">Use your Friday account. Your plan, models and usage carry over, the same as in the app.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAuthIntent("login");
                  setDialog("login");
                }}
                className="h-12 rounded-full bg-foreground text-sm font-medium text-background transition hover:opacity-90"
              >
                Sign in to Friday
              </button>
            </div>
          ) : phase === "enter" ? (
            <form
              className="flex flex-col gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                void lookup();
              }}
            >
              <div className="text-center">
                <h2 className="text-lg font-semibold">Enter the code from your terminal</h2>
                <p className="mt-1.5 text-sm text-muted">Run <span className="rounded-md bg-chip px-1.5 py-0.5 font-mono text-[0.8rem] text-foreground">friday</span> in your terminal to get one.</p>
              </div>
              <input
                id="device-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                maxLength={12}
                spellCheck={false}
                autoComplete="off"
                className="h-14 rounded-2xl border border-border bg-background text-center font-mono text-2xl tracking-[0.35em] outline-none transition focus:border-foreground/40"
              />
              <button type="submit" disabled={busy || !code.trim()} className="h-12 rounded-full bg-foreground text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40">
                {busy ? "Checking…" : "Continue"}
              </button>
            </form>
          ) : phase === "confirm" && request ? (
            <div className="flex flex-col gap-5">
              <div className="text-center">
                <h2 className="text-lg font-semibold">Connect this device?</h2>
                <p className="mt-1.5 text-sm text-muted">Check that this code matches the one in your terminal.</p>
              </div>

              <CodeBlocks code={request.userCode} />

              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background text-sm">
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-9 place-items-center rounded-full bg-chip">
                    {/vs ?code|editor|jetbrains|zed/i.test(request.clientName ?? "") ? <Laptop className="size-4" /> : <Terminal className="size-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{request.clientName ?? "FridayX"}</p>
                    <p className="text-xs text-muted">Asking to sign in{request.clientVersion ? ` · v${request.clientVersion}` : ""}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-9 place-items-center rounded-full bg-foreground text-sm font-semibold text-background">{initial}</span>
                  <div className="min-w-0">
                    <p className="break-all font-medium leading-snug">{email}</p>
                    <p className="text-xs text-muted">The account it will use</p>
                  </div>
                </div>
              </div>

              <ul className="space-y-2 text-[0.8rem] leading-relaxed text-muted">
                <li className="flex gap-2.5"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground/70" />It uses models and tools with your Friday plan and usage, the same meter as the apps.</li>
                <li className="flex gap-2.5"><LogOut className="mt-0.5 size-4 shrink-0 text-foreground/70" />You can sign it out any time in Settings → FridayX.</li>
                <li className="flex gap-2.5"><Lock className="mt-0.5 size-4 shrink-0 text-foreground/70" />Didn't just run <span className="font-mono text-foreground">friday</span>? Press Deny.</li>
              </ul>

              <div className="grid grid-cols-2 gap-3">
                <button type="button" disabled={busy} onClick={() => void decide(false)} className="h-12 rounded-full border border-border text-sm font-medium transition hover:bg-chip disabled:opacity-50">
                  Deny
                </button>
                <button type="button" disabled={busy} onClick={() => void decide(true)} className="h-12 rounded-full bg-foreground text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-60">
                  {busy ? "Connecting…" : "Approve"}
                </button>
              </div>
            </div>
          ) : phase === "approved" ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <span className="grid size-16 place-items-center rounded-full bg-emerald-500/12 text-emerald-500 ring-8 ring-emerald-500/8">
                <Check className="size-8" strokeWidth={2.5} />
              </span>
              <h2 className="mt-2 text-xl font-semibold">You're connected</h2>
              <p className="max-w-[18rem] text-sm text-muted">Head back to your terminal or editor. It signs in by itself. You can close this tab.</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <span className="grid size-16 place-items-center rounded-full bg-chip text-muted ring-8 ring-chip/50">
                <X className="size-8" strokeWidth={2.5} />
              </span>
              <h2 className="mt-2 text-xl font-semibold">Request denied</h2>
              <p className="max-w-[18rem] text-sm text-muted">Nothing was connected. You can close this tab.</p>
            </div>
          )}

          {error ? <p className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-center text-sm text-danger">{error}</p> : null}
        </div>

        <p className="mt-5 text-center text-xs text-muted">Signed in as the wrong account? Switch account in the app, then run <span className="font-mono">friday login</span> again.</p>
      </main>
      <LoginPopout />
    </div>
  );
}
