import { create } from "zustand";
import { api, API_BASE_URL, setAccessToken, setUnauthorizedHandler } from "@/lib/api";
import type { AuthUser, Session } from "@/lib/types";

const STORAGE_KEY = "friday-ai-session";

/** Friday AI always has real (Supabase-backed) auth configured — no dev fallback. */
export const authEnabled = true;

interface StoredAuth {
  session: Session;
  user: AuthUser;
}

type AuthState = {
  user: AuthUser | null;
  isPending: boolean;
  bootstrap: () => Promise<void>;
  /** Verifies the password and sends an OTP to the account's email — login only completes once
   *  that code is confirmed with verifyOtp(). */
  login: (email: string, password: string) => Promise<{ email: string }>;
  verifyOtp: (email: string, code: string) => Promise<void>;
  resendOtp: (email: string) => Promise<void>;
  /** The hidden /admin gate's own login — skips the OTP step (see backend adminLogin for why). */
  adminLogin: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, phone: string, password: string) => Promise<void>;
  /** Fills in a profile field missing on an older account (currently just phone). */
  updateProfile: (phone: string) => Promise<void>;
  logout: () => void;
  /** Exchanges the stored refresh token for a new access token. Returns whether it worked. */
  refresh: () => Promise<boolean>;
};

function loadStored(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

function persist(session: Session, user: AuthUser) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ session, user }));
  setAccessToken(session.access_token);
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isPending: true,

  bootstrap: async () => {
    const stored = loadStored();
    if (!stored) {
      set({ isPending: false });
      return;
    }
    setAccessToken(stored.session.access_token);
    set({ user: stored.user });
    try {
      const res = await api.get<{ user: AuthUser }>("/auth/me");
      set({ user: res.user, isPending: false });
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setAccessToken(null);
      set({ user: null, isPending: false });
    }
  },

  login: async (email, password) => {
    const res = await api.post<{ otpRequired: true; email: string }>("/auth/login", { email, password });
    return { email: res.email };
  },

  verifyOtp: async (email, code) => {
    const res = await api.post<{ user: AuthUser; session: Session }>("/auth/verify-otp", { email, code });
    persist(res.session, res.user);
    set({ user: res.user, isPending: false });
  },

  resendOtp: async (email) => {
    await api.post("/auth/resend-otp", { email });
  },

  adminLogin: async (email, password) => {
    const res = await api.post<{ user: AuthUser; session: Session }>("/auth/admin-login", { email, password });
    persist(res.session, res.user);
    set({ user: res.user, isPending: false });
  },

  signup: async (name, email, phone, password) => {
    const res = await api.post<{ user: AuthUser; session: Session | null }>("/auth/signup", {
      name,
      email,
      phone,
      password,
    });
    if (res.session && res.user) {
      persist(res.session, res.user);
      set({ user: res.user, isPending: false });
    } else {
      throw new Error("Check your email to confirm your account, then log in.");
    }
  },

  updateProfile: async (phone) => {
    const res = await api.patch<{ user: AuthUser }>("/auth/profile", { phone });
    const stored = loadStored();
    if (stored) persist(stored.session, res.user);
    set({ user: res.user });
  },

  logout: () => {
    localStorage.removeItem(STORAGE_KEY);
    setAccessToken(null);
    set({ user: null });
  },

  refresh: async () => {
    const stored = loadStored();
    if (!stored) return false;
    try {
      // Raw fetch, not the shared `api` client — that client retries 401s through this same
      // refresh() action, and routing the refresh call itself back through it would recurse.
      const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: stored.session.refresh_token }),
      });
      if (!res.ok) throw new Error("refresh failed");
      const body = (await res.json()) as { user: AuthUser; session: Session };
      persist(body.session, body.user);
      set({ user: body.user });
      return true;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setAccessToken(null);
      set({ user: null });
      return false;
    }
  },
}));

setUnauthorizedHandler(() => useAuthStore.getState().refresh());

// Proactive refresh: the access token lives ~1hr, so a tab left open longer than that would
// otherwise sit on a dead token until the next request happens to hit a 401. Refreshing well
// before it expires means a signed-in user effectively never gets logged out while the tab is open.
const PROACTIVE_REFRESH_INTERVAL_MS = 45 * 60_000;
if (typeof window !== "undefined") {
  window.setInterval(() => {
    if (useAuthStore.getState().user) void useAuthStore.getState().refresh();
  }, PROACTIVE_REFRESH_INTERVAL_MS);
}

export async function signOut(): Promise<void> {
  useAuthStore.getState().logout();
}
