import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import type { ProviderModelRow, ProviderWithStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

// There is exactly one admin account now (consolidated from two — see git history) at an
// address Resend can actually deliver the login OTP to (its sandbox mode otherwise only
// delivers to the account it was signed up with). Typing the bare username still works; typing
// any other full email also works unchanged.
const USERNAME_LOGIN_EMAILS: Record<string, string> = {
  admin: "admin.billionairestechnologies@gmail.com",
};

function resolveLoginEmail(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed;
  return USERNAME_LOGIN_EMAILS[trimmed.toLowerCase()] ?? trimmed;
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

export function AdminLoginPage({ deniedMessage }: { deniedMessage?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otpEmail, setOtpEmail] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const adminLogin = useAuthStore((s) => s.adminLogin);
  const verifyOtp = useAuthStore((s) => s.verifyOtp);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (otpEmail) {
        await verifyOtp(otpEmail, otp);
      } else {
        const result = await adminLogin(resolveLoginEmail(username), password);
        setOtpEmail(result.email);
      }
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
          {otpEmail ? (
            <label className="flex flex-col gap-1 text-sm text-muted">
              Verification code sent to {otpEmail}
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                required
                minLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="h-10 rounded-xl border border-border bg-background px-3 font-mono text-sm tracking-[0.3em] text-foreground outline-none"
              />
            </label>
          ) : (
            <>
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
            </>
          )}

          {(error || deniedMessage) && <p className="text-sm text-danger">{error ?? deniedMessage}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 h-10 rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Checking…" : otpEmail ? "Verify and enter" : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}

/** The original admin panel. `embedded` renders one pane inside the Team Console (no page chrome). */
export function AdminPage({ onLogout, embedded }: { onLogout?: () => void; embedded?: "providers" | "plans" }) {
  const [section, setSection] = useState<"providers" | "plans">(embedded ?? "providers");
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

  async function setModelTier(modelId: string, slug: string, minTier: string) {
    await api.patch(`/admin/providers/models/${modelId}/tier`, { minTier });
    loadModels(slug);
  }

  return (
    <div className={embedded ? "text-foreground" : "min-h-dvh bg-background px-4 py-8 text-foreground md:px-8"}>
      <div className={cn("mx-auto flex flex-col gap-6", !embedded && "max-w-4xl")}>
        {embedded ? (
          section === "providers" && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={checkAll}
                disabled={busy}
                className="h-8 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip disabled:opacity-60"
              >
                Check all keys
              </button>
            </div>
          )
        ) : (
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold">Admin panel</h1>
            <div className="flex items-center rounded-full bg-chip p-0.5">
              <button
                type="button"
                onClick={() => setSection("providers")}
                className={cn(
                  "h-7 rounded-full px-3 text-xs font-medium",
                  section === "providers" ? "bg-background text-foreground" : "text-muted",
                )}
              >
                Providers
              </button>
              <button
                type="button"
                onClick={() => setSection("plans")}
                className={cn(
                  "h-7 rounded-full px-3 text-xs font-medium",
                  section === "plans" ? "bg-background text-foreground" : "text-muted",
                )}
              >
                Plans & Usage
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {section === "providers" && (
              <button
                type="button"
                onClick={checkAll}
                disabled={busy}
                className="h-8 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip disabled:opacity-60"
              >
                Check all keys
              </button>
            )}
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
        )}

        {notice && (
          <div className="rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm text-muted">{notice}</div>
        )}

        {section === "plans" && <PlansPane />}

        <div className={cn("flex flex-col gap-3", section !== "providers" && "hidden")}>
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
                        <select
                          value={m.min_tier}
                          onChange={(e) => setModelTier(m.id, p.slug, e.target.value)}
                          className="ml-auto h-7 rounded-full border border-border bg-background px-2 text-xs"
                        >
                          <option value="free">Free</option>
                          <option value="pro">Pro</option>
                          <option value="premium">Premium</option>
                        </select>
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

type AdminUserRow = {
  id: string;
  fullName: string | null;
  role: string;
  plan: "free" | "pro" | "premium";
  planRenewsAt: string | null;
  customMonthlyCap: number | null;
  organizationId: string | null;
  organizationName: string | null;
};

type AdminOrganizationRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  seatCount: number;
  pooledMonthlyTokens: number;
  memberCount: number;
};

type Profitability = {
  sinceDays: number;
  revenuePaise: number;
  costUsdCents: number;
  costPaiseApprox: number;
  profitPaiseApprox: number;
  totalTokens: number;
  completions: number;
};

function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * The admin panel's "master control": every user's plan/personal cap, every enterprise
 * org's seats/pooled tokens, and a real-money profitability card (Razorpay revenue vs.
 * estimated provider cost from token_ledger — see adminUserService.profitabilitySummary).
 */
function PlansPane() {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [orgs, setOrgs] = useState<AdminOrganizationRow[]>([]);
  const [profit, setProfit] = useState<Profitability | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function refresh() {
    api.get<{ users: AdminUserRow[] }>("/admin/quota/users").then((res) => setUsers(res.users));
    api.get<{ organizations: AdminOrganizationRow[] }>("/admin/quota/organizations").then((res) => setOrgs(res.organizations));
    api.get<Profitability>("/admin/quota/profitability?sinceDays=30").then(setProfit);
  }

  useEffect(refresh, []);

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    setNotice(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {notice && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">{notice}</div>}

      {profit && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-border bg-surface p-3">
            <p className="text-xs text-muted">Revenue (30d)</p>
            <p className="mt-1 text-lg font-semibold">{formatInr(profit.revenuePaise)}</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-3">
            <p className="text-xs text-muted">Est. cost (30d)</p>
            <p className="mt-1 text-lg font-semibold">{formatInr(profit.costPaiseApprox)}</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-3">
            <p className="text-xs text-muted">Profit (30d, approx.)</p>
            <p className={cn("mt-1 text-lg font-semibold", profit.profitPaiseApprox < 0 && "text-danger")}>
              {formatInr(profit.profitPaiseApprox)}
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-3">
            <p className="text-xs text-muted">Completions (30d)</p>
            <p className="mt-1 text-lg font-semibold">{profit.completions}</p>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        <h3 className="border-b border-border px-4 py-3 text-sm font-semibold">Users</h3>
        <div className="flex flex-col divide-y divide-border">
          {users.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{u.fullName ?? u.id}</span>
              {u.organizationName && (
                <span className="rounded-full bg-chip px-2 py-0.5 text-xs text-muted">{u.organizationName}</span>
              )}
              <select
                value={u.plan}
                disabled={busyId === u.id}
                onChange={(e) =>
                  void withBusy(u.id, () => api.patch(`/admin/quota/users/${u.id}/plan`, { plan: e.target.value }))
                }
                className="h-7 rounded-full border border-border bg-background px-2 text-xs"
              >
                <option value="free">Free</option>
                <option value="pro">Pro</option>
                <option value="premium">Premium</option>
              </select>
              <input
                type="number"
                placeholder="Custom cap"
                defaultValue={u.customMonthlyCap ?? ""}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  void withBusy(u.id, () =>
                    api.patch(`/admin/quota/users/${u.id}/custom-cap`, {
                      customMonthlyCap: value ? Number(value) : null,
                    }),
                  );
                }}
                className="h-7 w-28 rounded-full border border-border bg-background px-2 text-xs"
              />
              <button
                type="button"
                disabled={busyId === u.id}
                onClick={() =>
                  void withBusy(u.id, () => api.post(`/admin/quota/users/${u.id}/bonus-tokens`, { tokens: 1_000_000 }))
                }
                className="h-7 rounded-full border border-border px-2.5 text-xs hover:bg-chip"
              >
                +1M bonus
              </button>
              <button
                type="button"
                disabled={busyId === u.id}
                onClick={() => void withBusy(u.id, () => api.post(`/admin/quota/users/${u.id}/reset-quota`))}
                className="h-7 rounded-full border border-border px-2.5 text-xs hover:bg-chip"
              >
                Reset now
              </button>
            </div>
          ))}
          {users.length === 0 && <p className="px-4 py-3 text-sm text-subtle">No users yet.</p>}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        <h3 className="border-b border-border px-4 py-3 text-sm font-semibold">Organizations</h3>
        <div className="flex flex-col divide-y divide-border">
          {orgs.map((org) => (
            <div key={org.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {org.name} <span className="text-xs text-subtle">({org.memberCount} members)</span>
              </span>
              <select
                value={org.plan}
                disabled={busyId === org.id}
                onChange={(e) =>
                  void withBusy(org.id, () => api.patch(`/admin/quota/organizations/${org.id}/plan`, { plan: e.target.value }))
                }
                className="h-7 rounded-full border border-border bg-background px-2 text-xs"
              >
                <option value="free">Free</option>
                <option value="pro">Pro</option>
                <option value="business">Business</option>
                <option value="enterprise">Enterprise</option>
              </select>
              <input
                type="number"
                defaultValue={org.seatCount}
                title="Seats"
                onBlur={(e) => {
                  const seatCount = Number(e.target.value);
                  if (seatCount) void withBusy(org.id, () => api.patch(`/admin/quota/organizations/${org.id}/seats`, { seatCount }));
                }}
                className="h-7 w-20 rounded-full border border-border bg-background px-2 text-xs"
              />
              <span className="text-xs text-muted">seats</span>
              <input
                type="number"
                defaultValue={org.pooledMonthlyTokens}
                title="Pooled monthly tokens"
                onBlur={(e) => {
                  const pooledMonthlyTokens = Number(e.target.value);
                  if (pooledMonthlyTokens >= 0)
                    void withBusy(org.id, () =>
                      api.patch(`/admin/quota/organizations/${org.id}/pooled-tokens`, { pooledMonthlyTokens }),
                    );
                }}
                className="h-7 w-32 rounded-full border border-border bg-background px-2 text-xs"
              />
              <span className="text-xs text-muted">pooled tokens/mo</span>
            </div>
          ))}
          {orgs.length === 0 && <p className="px-4 py-3 text-sm text-subtle">No organizations yet.</p>}
        </div>
      </div>
    </div>
  );
}
