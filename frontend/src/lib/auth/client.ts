import { create } from "zustand";
import { api, API_BASE_URL, setAccessToken, setUnauthorizedHandler } from "@/lib/api";
import { useChat } from "@/lib/chat/store";
import { registerWebPush } from "@/lib/push";
import { setRealtimeAuth, startRealtimeSync, stopRealtimeSync } from "@/lib/chat/realtime";
import type { AuthUser, Session } from "@/lib/types";

const STORAGE_KEY = "friday-ai-session";

/** Shared in-flight `/auth/refresh` attempt — see `refresh()` below for why this must be
 *  single-flighted across concurrent 401s. */
let inFlightRefresh: Promise<boolean> | null = null;

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
  requestPasswordReset: (email: string) => Promise<void>;
  /** Verifies admin credentials and starts the mandatory email OTP challenge. */
  adminLogin: (email: string, password: string) => Promise<{ email: string }>;
  signup: (
    name: string,
    email: string,
    phone: string,
    birthday: string,
    password: string,
    acceptedTerms: boolean,
  ) => Promise<{ email: string }>;
  /** Records agreement to the current Privacy Policy/Terms for the signed-in user — called by
   *  the blocking "I agree" gate. Updates the stored user in place so the gate closes. */
  acceptPolicy: () => Promise<void>;
  /** Fills in profile fields missing on an account — phone/birthday (the "complete your profile"
   *  prompt for older accounts) and/or birthday alone (Settings → Account). */
  updateProfile: (patch: { phone?: string; birthday?: string }) => Promise<void>;
  logout: () => void;
  /** Exchanges the stored refresh token for a new access token. Returns whether it worked. */
  refresh: () => Promise<boolean>;
};

function consumeHashSession(): StoredAuth | null {
  if (typeof window === "undefined") return null;
  // mobile-auth-bridge.tsx needs this exact hash intact so it can relay it on as a deep link to
  // the native app — if bootstrap() consumed and stripped it first (it runs at module load, well
  // before that page's own effect), the browser tab would silently log itself in instead and the
  // native app would be left stuck on "Finishing sign-in" forever with nothing to redirect on.
  if (window.location.pathname === "/mobile-auth-bridge") return null;
  const packed = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("friday_session");
  if (!packed) return null;
  try {
    const padded = packed.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (packed.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as StoredAuth;
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (parsed.session?.access_token && parsed.user?.id) return parsed;
  } catch {
    return null;
  }
  return null;
}

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
    const fromHash = consumeHashSession();
    const stored = fromHash ?? loadStored();
    if (fromHash) persist(fromHash.session, fromHash.user);
    if (!stored) {
      set({ isPending: false });
      return;
    }
    setAccessToken(stored.session.access_token);
    set({ user: stored.user });
    let res: { user: AuthUser };
    try {
      res = await api.get<{ user: AuthUser }>("/auth/me");
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setAccessToken(null);
      set({ user: null, isPending: false });
      useChat.getState().syncOwner(null);
      return;
    }
    // The session itself is now confirmed valid — everything below is best-effort follow-up
    // (realtime sync, push registration, an invite link) that must never undo it. This used to
    // share the try/catch above: a transient failure in any of these (a flaky websocket, a push
    // API hiccup) would wipe the just-verified session and silently sign the user back out,
    // which also meant any UI gated on being signed in (the consent gate, most visibly) could be
    // left stuck mid-transition if that same failure interrupted something else reacting to it.
    set({ user: res.user, isPending: false });
    try {
      useChat.getState().syncOwner(res.user.id);
      startRealtimeSync(res.user.id, stored.session.access_token);
      void registerWebPush();
    } catch (err) {
      console.warn("[auth] post-login setup failed (session is still valid):", err);
    }
    const invite = new URLSearchParams(window.location.search).get("invite");
    if (invite) {
      try {
        await api.post("/organizations/invites/accept", { token: invite });
      } catch {
        /* invite may already be used */
      }
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
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
    // The account is verified and signed in at this point — the caller (the login/signup dialog)
    // closes itself once this promise resolves, so a throw from here on would leave the dialog
    // stuck open on top of (or under) whatever renders next for a signed-in user, e.g. the consent
    // gate, even though the user genuinely is signed in. Best-effort follow-up only, same as
    // bootstrap() above.
    try {
      useChat.getState().syncOwner(res.user.id);
      startRealtimeSync(res.user.id, res.session.access_token);
      void registerWebPush();
    } catch (err) {
      console.warn("[auth] post-verify setup failed (session is still valid):", err);
    }
  },

  resendOtp: async (email) => {
    await api.post("/auth/resend-otp", { email });
  },

  requestPasswordReset: async (email) => {
    await api.post("/auth/password-reset", { email });
  },

  adminLogin: async (email, password) => {
    const res = await api.post<{ otpRequired: true; email: string }>("/auth/admin-login", { email, password });
    return { email: res.email };
  },

  /** Creates the account, then sends the same 6-digit OTP flow as login() — signup only
   *  completes once that code is confirmed with verifyOtp(). */
  signup: async (name, email, phone, birthday, password, acceptedTerms) => {
    const res = await api.post<{ otpRequired: true; email: string }>("/auth/signup", {
      name,
      email,
      phone,
      birthday,
      password,
      acceptedTerms,
      platform: "web",
    });
    return { email: res.email };
  },

  acceptPolicy: async () => {
    const res = await api.post<{ user: AuthUser }>("/auth/accept-policy", { platform: "web" });
    const stored = loadStored();
    if (stored) persist(stored.session, res.user);
    set({ user: res.user });
  },

  updateProfile: async (patch) => {
    const res = await api.patch<{ user: AuthUser }>("/auth/profile", patch);
    const stored = loadStored();
    if (stored) persist(stored.session, res.user);
    set({ user: res.user });
  },

  logout: () => {
    localStorage.removeItem(STORAGE_KEY);
    setAccessToken(null);
    set({ user: null });
    useChat.getState().syncOwner(null);
    stopRealtimeSync();
  },

  refresh: () => {
    // Supabase refresh tokens are single-use. Several requests can 401 at once (e.g. a burst of
    // deletes fired in parallel right as the access token expires) and each independently calling
    // this would race the same refresh token — only the first succeeds, and every loser used to
    // treat its own failure as "session dead" and log the user out, even though a sibling call had
    // just refreshed it successfully. Share one in-flight attempt across all concurrent callers.
    if (!inFlightRefresh) inFlightRefresh = doRefresh().finally(() => { inFlightRefresh = null; });
    return inFlightRefresh;
  },
}));

async function doRefresh(): Promise<boolean> {
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
    useAuthStore.setState({ user: body.user });
    setRealtimeAuth(body.session.access_token);
    return true;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    setAccessToken(null);
    useAuthStore.setState({ user: null });
    stopRealtimeSync();
    return false;
  }
}

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
