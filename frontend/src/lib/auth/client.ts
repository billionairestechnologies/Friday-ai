import { create } from "zustand";
import { api, setAccessToken } from "@/lib/api";
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
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
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
    const res = await api.post<{ user: AuthUser; session: Session }>("/auth/login", { email, password });
    persist(res.session, res.user);
    set({ user: res.user, isPending: false });
  },

  signup: async (name, email, password) => {
    const res = await api.post<{ user: AuthUser; session: Session | null }>("/auth/signup", {
      name,
      email,
      password,
    });
    if (res.session && res.user) {
      persist(res.session, res.user);
      set({ user: res.user, isPending: false });
    } else {
      throw new Error("Check your email to confirm your account, then log in.");
    }
  },

  logout: () => {
    localStorage.removeItem(STORAGE_KEY);
    setAccessToken(null);
    set({ user: null });
  },
}));

export async function signOut(): Promise<void> {
  useAuthStore.getState().logout();
}
