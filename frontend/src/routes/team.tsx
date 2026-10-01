import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { openCheckout, type CheckoutResponse } from "@/lib/billing/checkout";
import { formatTokens } from "@/lib/usage/quota";
import type { QuotaResponse, QuotaStatus } from "@/lib/usage/quota";
import { percentUsed } from "@/lib/usage/quota";

type Organization = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  monthlyBudgetCents: number;
  role: string;
};

type Member = {
  userId: string;
  role: string;
  fullName: string | null;
  customMonthlyCap: number | null;
  joinedAt: string;
};

function QuotaBar({ title, bucket }: { title: string; bucket: { used: number; limit: number } }) {
  const pct = percentUsed(bucket);
  return (
    <div className="rounded-2xl border border-border bg-elevated p-4">
      <p className="mb-2 text-sm font-medium text-foreground">{title}</p>
      <div className="h-2 w-full overflow-hidden rounded-full bg-chip">
        <div
          className={pct >= 100 ? "h-full rounded-full bg-danger" : pct >= 80 ? "h-full rounded-full bg-canvas" : "h-full rounded-full bg-search"}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        {formatTokens(Math.max(0, bucket.used))} / {formatTokens(bucket.limit)} tokens ({pct}%)
      </p>
    </div>
  );
}

export function TeamPage() {
  const navigate = useNavigate();
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [name, setName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteAcceptToken, setInviteAcceptToken] = useState("");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [budget, setBudget] = useState("0");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [sso, setSso] = useState<{ enabled: boolean; entryUrl: string | null; providerLabel: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [orgQuota, setOrgQuota] = useState<QuotaStatus | null>(null);
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({});
  const [addSeats, setAddSeats] = useState(1);

  function refresh() {
    if (!signedIn) return;
    api
      .get<{ organizations: Organization[] }>("/organizations")
      .then((res) => {
        setOrganizations(res.organizations);
        if (!selectedOrgId && res.organizations[0]) {
          setSelectedOrgId(res.organizations[0].id);
          setBudget(String(res.organizations[0].monthlyBudgetCents));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load teams"));
    api
      .get<{ enabled: boolean; entryUrl: string | null; providerLabel: string }>("/organizations/sso")
      .then(setSso)
      .catch(() => setSso(null));
    api
      .get<QuotaResponse>("/usage/quota")
      .then((res) => setOrgQuota(res.status.org ? res.status : null))
      .catch(() => setOrgQuota(null));
  }

  useEffect(refresh, [signedIn]);

  const selected = organizations.find((org) => org.id === selectedOrgId) ?? null;

  useEffect(() => {
    if (!selected) {
      setMembers([]);
      return;
    }
    api
      .get<{ members: Member[] }>(`/organizations/${selected.id}/members`)
      .then((res) => setMembers(res.members))
      .catch(() => setMembers([]));
  }, [selected?.id]);

  if (!signedIn) {
    return (
      <div className="min-h-dvh bg-background px-4 py-8 text-foreground md:px-8">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <p className="text-sm text-muted">Sign in to manage your team.</p>
          <button
            type="button"
            aria-label="Close"
            onClick={() => void navigate({ to: "/" })}
            className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </div>
      </div>
    );
  }

  const canManageMembers = selected?.role === "owner" || selected?.role === "admin";
  const seatCount = orgQuota?.org?.seatCount ?? 0;

  async function saveMemberCap(userId: string) {
    if (!selected) return;
    const raw = capDrafts[userId]?.trim();
    const customMonthlyCap = raw ? Number(raw) : null;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/organizations/${selected.id}/members/${userId}/cap`, { customMonthlyCap });
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, customMonthlyCap } : m)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't set that member's cap");
    } finally {
      setBusy(false);
    }
  }

  async function createOrg() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ organization: Organization }>("/organizations", { name });
      setOrganizations((current) => [res.organization, ...current]);
      setSelectedOrgId(res.organization.id);
      setBudget(String(res.organization.monthlyBudgetCents));
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create team");
    } finally {
      setBusy(false);
    }
  }

  async function saveBudget() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.patch<{ organization: Organization }>(`/organizations/${selected.id}/budget`, {
        monthlyBudgetCents: Number(budget) || 0,
      });
      setOrganizations((current) => current.map((org) => (org.id === res.organization.id ? { ...org, ...res.organization } : org)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update budget");
    } finally {
      setBusy(false);
    }
  }

  async function inviteMember() {
    if (!selected || !inviteEmail.trim()) return;
    setBusy(true);
    setError(null);
    setInviteToken(null);
    try {
      const res = await api.post<{ invite: { inviteToken: string } }>(`/organizations/${selected.id}/invites`, {
        email: inviteEmail,
        role: "member",
      });
      setInviteToken(res.invite.inviteToken);
      setInviteEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create invite");
    } finally {
      setBusy(false);
    }
  }

  async function acceptInvite() {
    if (!inviteAcceptToken.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/organizations/invites/accept", { token: inviteAcceptToken.trim() });
      setInviteAcceptToken("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't accept invite");
    } finally {
      setBusy(false);
    }
  }

  /** Buys more seats for an already-Enterprise org — same checkout as /upgrade's Business tab,
   *  just re-run with the new total seat count (seat_count is set, not incremented, on payment). */
  async function buyMoreSeats() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<CheckoutResponse>("/billing/orders", {
        planId: "enterprise",
        billingCycle: "monthly",
        seats: seatCount + addSeats,
        organizationId: selected.id,
      });
      const failMsg = await openCheckout(res);
      if (failMsg) setError(failMsg);
      else refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start checkout for more seats");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background px-4 py-8 text-foreground md:px-8">
      <div className="mx-auto flex max-w-2xl flex-col">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Team</h1>
            <p className="mt-1 text-sm text-muted">Manage your organization, seats, members, and usage.</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => void navigate({ to: "/" })}
            className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </div>

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
        {sso?.enabled && sso.entryUrl && (
          <p className="mt-4 rounded-xl border border-border bg-elevated px-3 py-2 text-sm text-muted">
            {sso.providerLabel} is enabled for this workspace. Members can enter through the sign-in SSO button.
          </p>
        )}

        <div className="mt-5 flex flex-col gap-2 rounded-2xl border border-border bg-elevated p-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Organization name"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none"
          />
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void createOrg()}
            className="h-10 rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Working…" : "Create organization"}
          </button>
          <div className="mt-1 flex gap-2">
            <input
              value={inviteAcceptToken}
              onChange={(e) => setInviteAcceptToken(e.target.value)}
              placeholder="Accept invite token"
              className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none"
            />
            <button
              type="button"
              disabled={busy || !inviteAcceptToken.trim()}
              onClick={() => void acceptInvite()}
              className="h-10 rounded-full border border-border px-3 text-sm disabled:opacity-50"
            >
              Join
            </button>
          </div>
        </div>

        {organizations.length > 0 && (
          <div className="mt-5 flex flex-col gap-3">
            <select
              value={selectedOrgId ?? ""}
              onChange={(e) => {
                const next = organizations.find((org) => org.id === e.target.value);
                setSelectedOrgId(e.target.value);
                if (next) setBudget(String(next.monthlyBudgetCents));
              }}
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none"
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name} ({org.role}) — {org.plan}
                </option>
              ))}
            </select>

            {selected && selected.plan !== "enterprise" && (
              <p className="rounded-2xl border border-border bg-elevated px-4 py-3 text-sm text-muted">
                This team isn't on Enterprise yet.{" "}
                <button
                  type="button"
                  onClick={() => void navigate({ to: "/upgrade" })}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Buy Enterprise seats
                </button>{" "}
                to pool tokens, add members, and set per-member caps.
              </p>
            )}

            {selected && selected.plan === "enterprise" && (
              <>
                {orgQuota?.org && <QuotaBar title={`Pooled tokens (${orgQuota.org.seatCount} seats)`} bucket={orgQuota.org} />}

                {canManageMembers && (
                  <div className="flex items-center gap-2 rounded-2xl border border-border bg-elevated p-4">
                    <span className="text-sm text-muted">Add seats</span>
                    <input
                      type="number"
                      min={1}
                      value={addSeats}
                      onChange={(e) => setAddSeats(Math.max(1, Number(e.target.value) || 1))}
                      className="h-9 w-20 rounded-lg border border-border bg-background px-2 text-sm outline-none"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void buyMoreSeats()}
                      className="ml-auto h-9 rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                    >
                      {busy ? "Starting…" : `Buy ${addSeats} more (${seatCount + addSeats} total)`}
                    </button>
                  </div>
                )}

                {canManageMembers && (
                  <div className="flex gap-2 rounded-2xl border border-border bg-elevated p-4">
                    <input
                      value={budget}
                      onChange={(e) => setBudget(e.target.value)}
                      inputMode="numeric"
                      placeholder="Monthly budget (cents)"
                      className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void saveBudget()}
                      className="h-9 rounded-full border border-border px-3 text-sm disabled:opacity-50"
                    >
                      Save budget
                    </button>
                  </div>
                )}

                {canManageMembers && (
                  <div className="flex gap-2 rounded-2xl border border-border bg-elevated p-4">
                    <input
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="Invite email"
                      className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none"
                    />
                    <button
                      type="button"
                      disabled={busy || !inviteEmail.trim()}
                      onClick={() => void inviteMember()}
                      className="h-9 rounded-full border border-border px-3 text-sm disabled:opacity-50"
                    >
                      Invite
                    </button>
                  </div>
                )}
                {inviteToken && (
                  <p className="rounded-xl border border-border bg-elevated px-3 py-2 text-xs text-muted">
                    Invite token (share once): <span className="font-mono text-foreground">{inviteToken}</span>
                  </p>
                )}

                {members.length > 0 && (
                  <div className="overflow-hidden rounded-2xl border border-border bg-elevated">
                    <p className="border-b border-border px-4 py-2 text-xs font-medium tracking-wide text-muted uppercase">
                      Members ({members.length}/{seatCount} seats)
                    </p>
                    <div className="flex flex-col divide-y divide-border">
                      {members.map((m) => (
                        <div key={m.userId} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                          <span className="min-w-0 flex-1 truncate">{m.fullName ?? m.userId}</span>
                          <span className="rounded-full bg-chip px-2 py-0.5 text-xs text-muted">{m.role}</span>
                          {canManageMembers && (
                            <>
                              <input
                                type="number"
                                placeholder="No cap"
                                defaultValue={m.customMonthlyCap ?? ""}
                                onChange={(e) => setCapDrafts((prev) => ({ ...prev, [m.userId]: e.target.value }))}
                                className="h-7 w-28 rounded-full border border-border bg-background px-2 text-xs outline-none"
                              />
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void saveMemberCap(m.userId)}
                                className="h-7 rounded-full border border-border px-2.5 text-xs hover:bg-chip"
                              >
                                Set cap
                              </button>
                            </>
                          )}
                          {!canManageMembers && m.customMonthlyCap != null && (
                            <span className="text-xs text-muted">Cap: {formatTokens(m.customMonthlyCap)} tokens/mo</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
