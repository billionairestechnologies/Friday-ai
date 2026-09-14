import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ModelSelector } from "../components/ModelSelector";
import { useAuth } from "../context/AuthContext";

const PREFERRED_MODEL_KEY = "friday-ai-preferred-model";

export function AuthPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [preferredModel, setPreferredModel] = useState(localStorage.getItem(PREFERRED_MODEL_KEY) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { signup, login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (preferredModel) localStorage.setItem(PREFERRED_MODEL_KEY, preferredModel);
      if (mode === "signup") {
        await signup(name, email, password);
      } else {
        await login(email, password);
      }
      navigate("/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Friday AI</h1>
        <p className="auth-subtitle">Chat with any AI model — OpenAI, Claude, Gemini, and more, in one place.</p>

        <div className="auth-tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">
            Log in
          </button>
          <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")} type="button">
            Sign up
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {mode === "signup" && (
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Your name" />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              placeholder="At least 8 characters"
            />
          </label>

          <label>
            Preferred model <span className="hint">(you can change this anytime in chat)</span>
            <ModelSelector value={preferredModel} onChange={(v) => setPreferredModel(v)} />
          </label>

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
          </button>

          <button type="button" className="btn-google" disabled title="Google sign-in is coming soon">
            <span>Continue with Google</span>
            <span className="badge">Locked</span>
          </button>
        </form>
      </div>
    </div>
  );
}
