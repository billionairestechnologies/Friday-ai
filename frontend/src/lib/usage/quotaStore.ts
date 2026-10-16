import { create } from "zustand";
import { api } from "@/lib/api";
import type { QuotaResponse } from "./quota";

type QuotaState = {
  data: QuotaResponse | null;
  error: string | null;
  loadedAt: number;
  loading: Promise<void> | null;
  /** Fetches unless a fresh copy (< maxAgeMs) is already here. Concurrent callers share one request. */
  load: (maxAgeMs?: number) => Promise<void>;
};

/**
 * The one copy of the user's balance in the app. The Usage panel, Billing, the threshold toasts and
 * the plan badge all read it, so two screens can never show two different numbers. The server
 * ledger is the only source — nothing here is computed or enforced client-side.
 */
export const useQuota = create<QuotaState>((set, get) => ({
  data: null,
  error: null,
  loadedAt: 0,
  loading: null,
  load: async (maxAgeMs = 0) => {
    const state = get();
    if (state.loading) return state.loading;
    if (state.data && Date.now() - state.loadedAt < maxAgeMs) return;
    const loading = api
      .get<QuotaResponse>("/usage/quota")
      .then((data) => set({ data, error: null, loadedAt: Date.now() }))
      .catch((err) => set({ error: err instanceof Error ? err.message : "Couldn't load usage" }))
      .finally(() => set({ loading: null }));
    set({ loading });
    return loading;
  },
}));

let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * A chat / Build turn just ended: the server settles its reservation right after the last event,
 * so refresh a moment later (debounced — a burst of turns causes one fetch).
 */
export function notifyUsageChanged(delayMs = 1_500) {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void useQuota.getState().load();
  }, delayMs);
}
