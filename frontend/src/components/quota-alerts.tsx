import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { formatResetAt, mainBucket, percentUsed, type QuotaStatus } from "@/lib/usage/quota";
import { useQuota } from "@/lib/usage/quotaStore";

type Toast = { id: string; message: string; danger: boolean };

// The server sends the thresholds it notifies at (80 / 95 / 100 % of the period's tokens).
const DEFAULT_THRESHOLDS = [80, 95, 100];
const POLL_MS = 60_000;

function armedKey(name: string, threshold: number): string {
  return `quota-alert-armed:${name}:${threshold}`;
}

/**
 * Fires a toast the moment usage crosses UP through each threshold, then stays silent while it
 * remains above, and re-arms once it drops back below (a new period, a bonus). Keyed by the
 * period's start so every period gets its own set of notices.
 */
function crossedThresholds(name: string, bucket: { used: number; limit: number } | null, thresholds: number[]): number[] {
  if (!bucket) return [];
  const pct = percentUsed(bucket);
  const fired: number[] = [];
  for (const threshold of thresholds) {
    const key = armedKey(name, threshold);
    let alreadyArmed = false;
    try {
      alreadyArmed = sessionStorage.getItem(key) === "1";
    } catch {
      // Private browsing / storage blocked — fall through and treat as never-armed.
    }
    if (pct >= threshold) {
      if (!alreadyArmed) {
        fired.push(threshold);
        try {
          sessionStorage.setItem(key, "1");
        } catch {
          /* best-effort */
        }
      }
    } else if (alreadyArmed) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* best-effort */
      }
    }
  }
  return fired;
}

function messageFor(threshold: number, status: QuotaStatus): string {
  const what = status.isEnterprise ? "your team's tokens" : "this month's tokens";
  if (threshold >= 100) {
    const resetAt = mainBucket(status)?.resetAt;
    return `You've used all of ${what}. They renew ${resetAt ? formatResetAt(resetAt) : "at the start of your next period"}.`;
  }
  return `You've used ${threshold}% of ${what}.`;
}

export function QuotaAlerts() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useCurrentUserState();
  // The admin panel is Friday's own platform-management surface, not a regular user's chat
  // session — a toast about the logged-in admin's personal token usage there is just noise on
  // top of whatever they're actually doing (managing providers, other users' plans, etc).
  const onAdminPanel = location.pathname.startsWith("/admin");
  const signedIn = Boolean(user && !user.isDevFallback) && !onAdminPanel;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  function push(message: string, danger: boolean) {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, danger }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timers.current.delete(id);
    }, 7_000);
    timers.current.set(id, timer);
  }

  const data = useQuota((q) => q.data);

  useEffect(() => {
    if (!signedIn) return;
    // A usage check is a courtesy notification, not a gate — failures just retry next interval.
    void useQuota.getState().load(30_000);
    const interval = setInterval(() => void useQuota.getState().load(30_000), POLL_MS);
    return () => clearInterval(interval);
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn || !data) return;
    const { status } = data;
    const periodKey = status.period?.start ?? mainBucket(status)?.resetAt ?? "period";
    const thresholds = data.thresholds?.length ? data.thresholds : DEFAULT_THRESHOLDS;
    for (const threshold of crossedThresholds(`tokens:${periodKey}`, mainBucket(status), thresholds)) {
      push(messageFor(threshold, status), threshold >= 100);
    }
    if (status.memberCap) {
      for (const threshold of crossedThresholds(`member:${periodKey}`, status.memberCap, thresholds)) {
        push(threshold >= 100 ? "You've reached the monthly cap your admin set." : `You've used ${threshold}% of the monthly cap your admin set.`, threshold >= 100);
      }
    }
    // push is stable for the component's life; data is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, signedIn]);

  useEffect(() => {
    return () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    };
  }, []);

  if (!signedIn) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto flex max-w-md items-center gap-2 rounded-full border border-border bg-elevated px-4 py-2 text-sm shadow-[var(--shadow-panel)]"
          >
            <AlertTriangle className={toast.danger ? "size-4 shrink-0 text-danger" : "size-4 shrink-0 text-canvas"} />
            <span className={toast.danger ? "text-danger" : "text-foreground"}>{toast.message}</span>
            {toast.danger && (
              <button
                type="button"
                onClick={() => void navigate({ to: "/upgrade" })}
                className="ml-1 shrink-0 rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Upgrade
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
