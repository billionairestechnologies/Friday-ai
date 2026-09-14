import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setAccessToken } from "../lib/api";
import type { AuthUser, Session } from "../lib/types";

const STORAGE_KEY = "friday-ai-session";

interface StoredAuth {
  session: Session;
  user: AuthUser;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signup: (name: string, email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadStored(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = loadStored();
    if (stored) {
      setAccessToken(stored.session.access_token);
      setUser(stored.user);
      // Confirm the token is still valid and refresh the role/name.
      api
        .get<{ user: AuthUser }>("/auth/me")
        .then((res) => setUser(res.user))
        .catch(() => {
          localStorage.removeItem(STORAGE_KEY);
          setAccessToken(null);
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  function persist(session: Session, user: AuthUser) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ session, user }));
    setAccessToken(session.access_token);
    setUser(user);
  }

  async function signup(name: string, email: string, password: string) {
    const res = await api.post<{ user: AuthUser; session: Session | null; requiresEmailConfirmation: boolean }>(
      "/auth/signup",
      { name, email, password },
    );
    if (res.session && res.user) {
      persist(res.session, res.user);
    } else {
      throw new Error("Check your email to confirm your account, then log in.");
    }
  }

  async function login(email: string, password: string) {
    const res = await api.post<{ user: AuthUser; session: Session }>("/auth/login", { email, password });
    persist(res.session, res.user);
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setAccessToken(null);
    setUser(null);
  }

  const value = useMemo(() => ({ user, loading, signup, login, logout }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
