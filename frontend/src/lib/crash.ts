import { API_BASE_URL, getAccessToken } from "@/lib/api";

/**
 * Crash reporting for the web app: the router's error screen and uncaught errors / rejections post
 * to /api/status/crash, where the team sees them grouped in the console (Status → Crashes). Kept
 * dependency-free and fire-and-forget: reporting a crash must never cause another one.
 */

const MAX_PER_SESSION = 10;
const seen = new Set<string>();
let sent = 0;

// Noise every web app sees that isn't a Friday bug.
const IGNORED = [/ResizeObserver loop/i, /Script error\.?$/i, /Loading chunk \d+ failed/i, /Failed to fetch dynamically imported module/i, /AbortError/i, /The user aborted a request/i];

export function reportCrash(error: unknown, extra: { source?: string } = {}): void {
  try {
    const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error ?? "Unknown error"));
    const message = `${extra.source ? `[${extra.source}] ` : ""}${err.name && err.name !== "Error" ? `${err.name}: ` : ""}${err.message || "Unknown error"}`.slice(0, 2000);
    if (IGNORED.some((re) => re.test(message))) return;
    const key = `${message}|${(err.stack ?? "").split("\n")[1] ?? ""}`;
    if (seen.has(key) || sent >= MAX_PER_SESSION) return;
    seen.add(key);
    sent++;
    const token = getAccessToken();
    void fetch(`${API_BASE_URL}/status/crash`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ platform: "web", message, stack: err.stack?.slice(0, 20_000) ?? null, url: window.location.href.slice(0, 1000), release: import.meta.env.VITE_APP_VERSION ?? null }),
    }).catch(() => {});
  } catch {
    // never throw from the crash reporter
  }
}

let installed = false;
export function installCrashReporter(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    // Resource load errors (img/script 404s) have no `error` — not crashes.
    if (event.error) reportCrash(event.error, { source: "uncaught" });
  });
  window.addEventListener("unhandledrejection", (event) => reportCrash(event.reason, { source: "unhandled promise" }));
}
