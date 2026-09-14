import { useState } from "react";
import { useAuth } from "../../context/AuthContext";

// Hidden admin gate — not linked from anywhere in the regular app (auth page, chat sidebar).
// Only reachable by knowing the /admin URL directly. Accepts a bare username (e.g. "admin"),
// mapped to an internal email under the hood since auth is Supabase email/password underneath.
const USERNAME_LOGIN_DOMAIN = "fridayai.com";

function resolveLoginEmail(input: string): string {
  const trimmed = input.trim();
  return trimmed.includes("@") ? trimmed : `${trimmed}@${USERNAME_LOGIN_DOMAIN}`;
}

export function AdminLoginPage({ deniedMessage }: { deniedMessage?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(resolveLoginEmail(username), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Admin</h1>
        <p className="auth-subtitle">Restricted area.</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="admin"
              autoFocus
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {(error || deniedMessage) && <div className="form-error">{error ?? deniedMessage}</div>}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
