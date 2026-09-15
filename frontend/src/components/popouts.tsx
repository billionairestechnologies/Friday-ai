import { type FormEvent, type ReactNode, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LogIn, Settings, UserRound, X } from "lucide-react";
import { authEnabled, signOut, useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useChat } from "@/lib/chat/store";
import { PluginsDrawer } from "@/components/plugins-drawer";
import { SettingsModal } from "@/components/settings-modal";

function Shell({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed top-[50%] left-[50%] z-50 w-[min(92vw,420px)] translate-x-[-50%] translate-y-[-50%] rounded-2xl border border-border bg-elevated p-5 shadow-[var(--shadow-composer)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <div className="mb-4 flex items-start justify-between gap-3">
            <Dialog.Title className="text-lg font-semibold tracking-tight text-foreground">
              {title}
            </Dialog.Title>
            <Dialog.Close className="flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.9-2.26 5.36-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function LoginPopout() {
  const dialog = useChat((s) => s.dialog);
  const setDialog = useChat((s) => s.setDialog);
  const { user } = useCurrentUserState();
  const login = useAuthStore((s) => s.login);
  const verifyOtp = useAuthStore((s) => s.verifyOtp);
  const resendOtp = useAuthStore((s) => s.resendOtp);
  const signup = useAuthStore((s) => s.signup);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [step, setStep] = useState<"credentials" | "otp">("credentials");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const signedIn = Boolean(user && !user.isDevFallback);

  function resetForm() {
    setStep("credentials");
    setCode("");
    setError(null);
    setNotice(null);
  }

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
        setStep("otp");
      } else {
        await signup(name, email, phone, password);
        setDialog(null);
        setPassword("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function submitOtp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await verifyOtp(email, code);
      setDialog(null);
      setPassword("");
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await resendOtp(email);
      setNotice("Sent a new code.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't resend the code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      open={dialog === "login"}
      onClose={() => setDialog(null)}
      title={
        signedIn
          ? "Account"
          : step === "otp"
            ? "Check your email"
            : mode === "login"
              ? "Sign in to Friday"
              : "Create your account"
      }
    >
      {signedIn ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-xl bg-chip px-3 py-3">
            {user?.profileImageUrl ? (
              <img src={user.profileImageUrl} alt="" className="size-10 rounded-full object-cover" />
            ) : (
              <span className="grid size-10 place-items-center rounded-full bg-elevated text-sm font-semibold text-foreground">
                {(user?.displayName ?? "F").charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{user?.displayName ?? "Account"}</p>
              {user?.primaryEmail && (
                <p className="truncate text-xs text-muted">{user.primaryEmail}</p>
              )}
            </div>
          </div>
          {authEnabled && (
            <button
              type="button"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                void signOut().catch(() => setSigningOut(false));
              }}
              className="h-10 rounded-full border border-border text-sm font-medium text-foreground transition-colors hover:bg-chip disabled:opacity-60"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          )}
        </div>
      ) : step === "otp" ? (
        <form onSubmit={submitOtp} className="flex flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted">
            We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>. It expires in
            10 minutes.
          </p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
            maxLength={6}
            className="h-12 rounded-xl border border-border bg-background px-3 text-center font-mono text-xl tracking-[0.4em] text-foreground outline-none placeholder:text-subtle"
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          {notice && <p className="text-sm text-muted">{notice}</p>}
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="h-11 rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-transform duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
          <div className="flex items-center justify-between text-xs">
            <button type="button" onClick={resetForm} className="text-muted hover:text-foreground">
              Back
            </button>
            <button type="button" onClick={() => void handleResend()} disabled={busy} className="text-muted hover:text-foreground disabled:opacity-60">
              Resend code
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <form onSubmit={submitCredentials} className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted">
              Save chats across devices. You can keep using Friday as a guest.
            </p>
            {mode === "signup" && (
              <>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name"
                  required
                  className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-subtle"
                />
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Mobile number"
                  required
                  className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-subtle"
                />
              </>
            )}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              autoFocus
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-subtle"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              minLength={6}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-subtle"
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="h-11 rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-transform duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? "Please wait…" : mode === "login" ? "Continue" : "Create account"}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode(mode === "login" ? "signup" : "login");
              }}
              className="text-center text-xs text-muted hover:text-foreground"
            >
              {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
            </button>
          </form>
          <div className="flex items-center gap-2 py-1">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-subtle">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <button
            type="button"
            disabled
            title="Coming soon"
            className="flex h-11 items-center justify-center gap-2.5 rounded-full border border-border text-sm font-medium text-muted opacity-60"
          >
            <GoogleLogo className="size-4" />
            Continue with Google
            <span className="ml-1 rounded-full bg-chip px-2 py-0.5 text-[10px] font-medium text-subtle">Coming soon</span>
          </button>
        </div>
      )}
    </Shell>
  );
}

function HelpPopout() {
  const dialog = useChat((s) => s.dialog);
  const setDialog = useChat((s) => s.setDialog);
  return (
    <Shell open={dialog === "help"} onClose={() => setDialog(null)} title="Help">
      <p className="text-sm leading-relaxed text-muted">
        Friday answers in this chat. Turn on Search for live web, Think for the reasoning trail, and Canvas to open a workspace on the right when something is built. Friday can be wrong — check anything important.
      </p>
    </Shell>
  );
}

function UpgradePopout() {
  const dialog = useChat((s) => s.dialog);
  const setDialog = useChat((s) => s.setDialog);
  return (
    <Shell open={dialog === "upgrade"} onClose={() => setDialog(null)} title="Upgrade plan">
      <div className="rounded-xl border border-border bg-chip/40 p-4">
        <p className="text-sm font-semibold">Friday</p>
        <p className="mt-1 text-sm text-muted">This workspace already has model access. There’s nothing extra to buy here.</p>
      </div>
    </Shell>
  );
}

export function HeaderActions() {
  const setDialog = useChat((s) => s.setDialog);
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Settings"
        onClick={() => setDialog("settings")}
        className="flex size-9 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-chip hover:text-foreground"
      >
        <Settings className="size-4" />
      </button>
      <button
        type="button"
        aria-label={signedIn ? "Account" : "Sign in"}
        onClick={() => setDialog("login")}
        className="flex size-9 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-chip hover:text-foreground"
      >
        {signedIn ? (
          user?.profileImageUrl ? (
            <img src={user.profileImageUrl} alt="" className="size-6 rounded-full object-cover" />
          ) : (
            <UserRound className="size-4" />
          )
        ) : (
          <LogIn className="size-4" />
        )}
      </button>
    </div>
  );
}

export function Popouts() {
  return (
    <>
      <LoginPopout />
      <SettingsModal />
      <PluginsDrawer />
      <HelpPopout />
      <UpgradePopout />
    </>
  );
}
