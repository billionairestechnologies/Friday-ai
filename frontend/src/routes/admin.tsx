import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import type { ProviderModelRow, ProviderWithStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const USERNAME_LOGIN_DOMAIN = "fridayai.com";

function resolveLoginEmail(input: string): string {
  const trimmed = input.trim();
  return trimmed.includes("@") ? trimmed : `${trimmed}@${USERNAME_LOGIN_DOMAIN}`;
}

// /admin is intentionally not part of the regular sign-in flow and isn't linked from
// anywhere in the app — a standalone hidden gate with its own login.
export function AdminGate() {
  const { user, isPending } = useCurrentUserState();
  const rawUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  if (isPending) {
    return <div className="grid h-dvh place-items-center bg-background text-sm text-muted">Loading…</div>;
  }
  if (!user) return <AdminLoginPage />;
  if (rawUser?.role !== "admin") {
    return <AdminLoginPage deniedMessage="This account doesn't have admin access." />;
  }
  return <AdminPage onLogout={logout} />;
}

function AdminLoginPage({ deniedMessage }: { deniedMessage?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const adminLogin = useAuthStore((s) => s.adminLogin);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminLogin(resolveLoginEmail(username), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-elevated p-6 shadow-[var(--shadow-composer)]">
        <h1 className="text-lg font-semibold text-foreground">Admin</h1>
        <p className="mt-1 text-sm text-muted">Restricted area.</p>

        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted">
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="admin"
              autoFocus
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none"
            />
          </label>

          {(error || deniedMessage) && <p className="text-sm text-danger">{error ?? deniedMessage}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 h-10 rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}

function AdminPage({ onLogout }: { onLogout: () => void }) {
  const [providers, setProviders] = useState<ProviderWithStatus[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, ProviderModelRow[]>>({});
  const [keyLabel, setKeyLabel] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function refreshProviders() {
    api.get<{ providers: ProviderWithStatus[] }>("/admin/providers").then((res) => setProviders(res.providers));
  }

  useEffect(refreshProviders, []);

  function loadModels(slug: string) {
    api
      .get<{ models: ProviderModelRow[] }>(`/admin/providers/${slug}/models`)
      .then((res) => setModels((prev) => ({ ...prev, [slug]: res.models })));
  }

  async function addKey(slug: string) {
    if (!keyValue.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.post<{ discoveredModels: number; health: { ok: boolean; error?: string } }>(
        `/admin/providers/${slug}/keys`,
        { label: keyLabel || "default", apiKey: keyValue },
      );
      setNotice(
        res.health.ok
          ? `Key added and verified — found ${res.discoveredModels} models.`
          : `Key added but the health check failed: ${res.health.error}`,
      );
      setKeyLabel("");
      setKeyValue("");
      refreshProviders();
      loadModels(slug);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to add key");
    } finally {
      setBusy(false);
    }
  }

  async function deleteKey(keyId: string, slug: string) {
    await api.delete(`/admin/providers/keys/${keyId}`);
    refreshProviders();
    loadModels(slug);
  }

  async function checkKey(keyId: string) {
    setBusy(true);
    try {
      await api.post(`/admin/providers/keys/${keyId}/check`);
      refreshProviders();
    } finally {
      setBusy(false);
    }
  }

  async function checkAll() {
    setBusy(true);
    setNotice("Checking all keys…");
    try {
      await api.post("/admin/providers/keys/check-all");
      setNotice("Health check complete.");
      refreshProviders();
    } finally {
      setBusy(false);
    }
  }

  async function syncModels(slug: string) {
    setBusy(true);
    try {
      const res = await api.post<{ discoveredModels: number }>(`/admin/providers/${slug}/sync`);
      setNotice(`Synced ${res.discoveredModels} models for ${slug}.`);
      refreshProviders();
      loadModels(slug);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleModel(modelId: string, slug: string, enabled: boolean) {
    await api.patch(`/admin/providers/models/${modelId}`, { enabled });
    loadModels(slug);
    refreshProviders();
  }

  return (
    <div className="min-h-dvh bg-background px-4 py-8 text-foreground md:px-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <header className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Admin panel</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={checkAll}
              disabled={busy}
              className="h-8 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip disabled:opacity-60"
            >
              Check all keys
            </button>
            <a
              href="/"
              className="flex h-8 items-center rounded-full border border-border px-3 text-xs font-medium hover:bg-chip"
            >
              Chat
            </a>
            <button
              type="button"
              onClick={onLogout}
              className="h-8 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip"
            >
              Log out
            </button>
          </div>
        </header>

        {notice && (
          <div className="rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm text-muted">{notice}</div>
        )}

        <div className="flex flex-col gap-3">
          {providers.map((p) => (
            <div key={p.id} className="overflow-hidden rounded-2xl border border-border bg-surface">
              <button
                type="button"
                onClick={() => {
                  setExpanded(expanded === p.slug ? null : p.slug);
                  if (!models[p.slug]) loadModels(p.slug);
                }}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <div>
                  <strong className="text-sm font-semibold">{p.display_name}</strong>
                  <span className="ml-2 text-xs text-muted">
                    {p.enabledModelCount}/{p.modelCount} models shown to users
                  </span>
                </div>
                <span className="text-muted">{expanded === p.slug ? "▲" : "▼"}</span>
              </button>

              {expanded === p.slug && (
                <div className="border-t border-border px-4 py-4">
                  <h4 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">API keys</h4>
                  {p.keys.length === 0 && <p className="mb-3 text-sm text-subtle">No key added yet.</p>}
                  <div className="mb-3 flex flex-col gap-2">
                    {p.keys.map((k) => (
                      <div key={k.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-mono text-xs text-muted">{k.masked_preview}</span>
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            k.is_working ? "bg-emerald-500" : k.is_working === false ? "bg-danger" : "bg-subtle",
                          )}
                        />
                        <span className="text-xs text-muted">
                          {k.is_working === null ? "Not checked" : k.is_working ? "Working" : "Not working"}
                        </span>
                        <button
                          type="button"
                          onClick={() => checkKey(k.id)}
                          disabled={busy}
                          className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
                        >
                          Re-check
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteKey(k.id, p.slug)}
                          className="text-xs text-danger underline-offset-2 hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <input
                      placeholder="Label (optional)"
                      value={keyLabel}
                      onChange={(e) => setKeyLabel(e.target.value)}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-sm outline-none"
                    />
                    <input
                      placeholder={p.slug === "ollama" ? "Server URL (e.g. http://localhost:11434)" : "API key"}
                      value={keyValue}
                      onChange={(e) => setKeyValue(e.target.value)}
                      type={p.slug === "ollama" ? "text" : "password"}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-sm outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => addKey(p.slug)}
                      disabled={busy}
                      className="h-9 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                    >
                      Add
                    </button>
                  </div>

                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-xs font-medium tracking-wide text-muted uppercase">Models</h4>
                    <button
                      type="button"
                      onClick={() => syncModels(p.slug)}
                      disabled={busy}
                      className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
                    >
                      Re-sync from API
                    </button>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {(models[p.slug] ?? []).map((m) => (
                      <label key={m.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={m.is_enabled_for_users}
                          onChange={(e) => toggleModel(m.id, p.slug, e.target.checked)}
                        />
                        {m.display_name}
                        <span className="text-xs text-subtle">{m.model_id}</span>
                      </label>
                    ))}
                    {(models[p.slug] ?? []).length === 0 && (
                      <p className="text-sm text-subtle">No models discovered yet — add a working key first.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
