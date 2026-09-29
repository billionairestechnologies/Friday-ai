import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Activity, CircleHelp, LogOut, Puzzle, Settings, Sparkles } from "lucide-react";
import { authEnabled, signOut } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useChat } from "@/lib/chat/store";

export function ProfileDock() {
  const { user } = useCurrentUserState();
  const navigate = useNavigate();
  const setDialog = useChat((s) => s.setDialog);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const signedIn = Boolean(user && !user.isDevFallback);
  const name = signedIn ? (user?.displayName ?? "Account") : "Guest";
  const email = signedIn ? (user?.primaryEmail ?? "") : "Tap for settings";
  const initial = (name || "F").charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function go(id: "settings" | "plugins" | "help" | "login") {
    setOpen(false);
    setDialog(id);
  }

  return (
    <div ref={wrap} className="relative px-2 pb-3 pt-1">
      {open && (
        <div role="menu" className="absolute right-2 bottom-[calc(100%+8px)] left-2 z-20 overflow-hidden rounded-2xl border border-border bg-elevated py-1.5 shadow-[var(--shadow-composer)]">
          <p className="px-3 py-2">
            <span className="block truncate text-sm font-medium">{name}</span>
            {email && <span className="block truncate text-xs text-muted">{email}</span>}
          </p>
          <div className="my-1 h-px bg-border" />
          <MenuItem icon={<Settings className="size-4" />} label="Settings" onClick={() => go("settings")} />
          <MenuItem icon={<Puzzle className="size-4" />} label="Plugins" onClick={() => go("plugins")} />
          <MenuItem icon={<CircleHelp className="size-4" />} label="Help & support" onClick={() => go("help")} />
          <MenuItem
            icon={<Activity className="size-4" />}
            label="System status"
            onClick={() => {
              setOpen(false);
              void navigate({ to: "/status" });
            }}
          />
          <MenuItem
            icon={<Sparkles className="size-4" />}
            label="Upgrade plan"
            onClick={() => {
              setOpen(false);
              void navigate({ to: "/upgrade" });
            }}
          />
          <div className="my-1 h-px bg-border" />
          {signedIn && authEnabled ? (
            <MenuItem
              icon={<LogOut className="size-4" />}
              label={signingOut ? "Signing out…" : "Sign out"}
              onClick={() => {
                setSigningOut(true);
                void signOut().catch(() => setSigningOut(false));
              }}
            />
          ) : (
            <MenuItem icon={<LogOut className="size-4" />} label="Sign in" onClick={() => go("login")} />
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-12 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-chip"
      >
        {signedIn && user?.profileImageUrl ? (
          <img src={user.profileImageUrl} alt="" className="size-8 rounded-full object-cover" />
        ) : (
          <span className="grid size-8 place-items-center rounded-full bg-chip text-xs font-semibold">
            {initial}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted">{email || "Account"}</span>
        </span>
      </button>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      className="flex h-9 w-full items-center gap-2.5 px-3 text-sm text-foreground hover:bg-chip"
    >
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  );
}
