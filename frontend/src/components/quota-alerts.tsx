import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { formatResetAt, percentUsed, type QuotaResponse, type QuotaStatus } from "@/lib/usage/quota";
import { useChat } from "@/lib/chat/store";

type Toast = { id: string; message: string; danger: boolean };

// The 5-hour rolling window is this app's closest analog to a "daily" throttle (there is no
// literal daily bucket — see tokenQuotaService.ts), so it gets the same treatment requested for
// daily usage; weekly gets the finer-grained 50/80/90/100 ladder since it's the harder wall.
const ROLLING_THRESHOLDS = [80, 100];
const WEEKLY_THRESHOLDS = [50, 80, 90, 100];
const POLL_MS = 60_000;

function bucketKey(name: string, resetAt: string): string {
  return `quota-alert:${name}:${resetAt}`;
}

/** Fires a toast the first time a bucket crosses each threshold for its current period —
 *  deduped via sessionStorage so a re-render/remount can't re-fire the same threshold, but a
 *  new period (a changed resetAt) naturally gets a fresh set of thresholds to cross again. */
function crossedThresholds(name: string, bucket: { used: number; limit: number; resetAt: string } | null, thresholds: number[]): number[] {
  if (!bucket) return [];
  const pct = percentUsed(bucket);
  const fired: number[] = [];
  for (const threshold of thresholds) {
    if (pct < threshold) continue;
    const key = bucketKey(`${name}:${threshold}`, bucket.resetAt);
    try {
      if (sessionStorage.getItem(key)) continue;
      sessionStorage.setItem(key, "1");
    } catch {
      // Private browsing / storage blocked — fall through and fire anyway rather than go silent.
    }
    fired.push(threshold);
  }
  return fired;
}

function messageFor(label: string, threshold: number, status: QuotaStatus): string {
  if (threshold >= 100) {
    const resetAt = label === "5-hour" ? status.rolling?.resetAt : status.weekly.resetAt;
    return `You've used 100% of your ${label} limit. Resets ${resetAt ? formatResetAt(resetAt) : "soon"}.`;
  }
  return `You've used ${threshold}% of your ${label} limit.`;
}

export function QuotaAlerts() {
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
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

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;

    async function check() {
      try {
        const res = await api.get<QuotaResponse>("/usage/quota");
        if (cancelled) return;
        const { status } = res;

        for (const threshold of crossedThresholds("rolling", status.rolling, ROLLING_THRESHOLDS)) {
          push(messageFor("5-hour", threshold, status), threshold >= 100);
        }
        for (const threshold of crossedThresholds("weekly", status.weekly, WEEKLY_THRESHOLDS)) {
          push(messageFor("weekly", threshold, status), threshold >= 100);
        }
        if (status.monthly) {
          for (const threshold of crossedThresholds("monthly", status.monthly, WEEKLY_THRESHOLDS)) {
            push(messageFor("monthly", threshold, status), threshold >= 100);
          }
        }
        if (status.org) {
          for (const threshold of crossedThresholds("org", status.org, ROLLING_THRESHOLDS)) {
            push(messageFor("organization", threshold, status), threshold >= 100);
          }
        }
      } catch {
        // Usage check is a courtesy notification, not a gate — a failed poll just tries again
        // next interval instead of surfacing an error for something the user didn't ask for.
      }
    }

    void check();
    const interval = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [signedIn]);

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
                onClick={() => {
                  useChat.getState().setSettingsTab("usage");
                  useChat.getState().setDialog("settings");
                }}
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
