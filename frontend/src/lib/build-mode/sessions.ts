import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api";

/** Mirrors backend projectBuild/sessions.ts BuildSessionSummary. */
export type BuildSessionStatus = "running" | "needs_input" | "done" | "error" | "idle";
export type BuildSession = {
  id: string;
  title: string;
  updatedAt: string;
  status: BuildSessionStatus;
  activity: string;
  repo: string | null;
  prUrl: string | null;
  previewUrl: string | null;
};

type State = {
  sessions: BuildSession[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
};

export const useBuildSessions = create<State>((set) => ({
  sessions: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      const res = await api.get<{ sessions: BuildSession[] }>("/build/sessions");
      set({ sessions: res.sessions, loaded: true, error: null });
    } catch (err) {
      set({ loaded: true, error: err instanceof Error ? err.message : "Couldn't load your builds" });
    }
  },
}));

/** Keeps the list fresh while the Build workspace is open: on mount, on focus, after a turn ends,
 *  and every few seconds while any session is running (statuses flip server-side). */
export function useBuildSessionsSync(enabled: boolean, refreshKey: unknown) {
  const load = useBuildSessions((s) => s.load);
  const anyRunning = useBuildSessions((s) => s.sessions.some((x) => x.status === "running"));
  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load, refreshKey]);
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);
  useEffect(() => {
    if (!enabled || !anyRunning) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [enabled, anyRunning, load]);
}

export const STATUS_META: Record<BuildSessionStatus, { label: string; dot: string; text: string }> = {
  needs_input: { label: "Needs input", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  running: { label: "Running", dot: "bg-sky-500 animate-pulse", text: "text-sky-600 dark:text-sky-400" },
  done: { label: "Done", dot: "bg-subtle", text: "text-muted" },
  error: { label: "Error", dot: "bg-danger", text: "text-danger" },
  idle: { label: "Stopped", dot: "bg-border", text: "text-muted" },
};

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString();
}
