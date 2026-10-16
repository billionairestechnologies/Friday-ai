import { useState } from "react";
import { AlertTriangle, Download, Gauge, RefreshCw, Search } from "lucide-react";
import { api, API_BASE_URL, getAccessToken } from "@/lib/api";
import { useCan } from "../access";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Segmented, Select, Stat, act, formatDate, formatNumber, timeAgo, toast, useResource } from "../ui";

type Account = {
  id: string;
  kind: "individual" | "organization";
  userId: string | null;
  organizationId: string | null;
  name: string;
  email: string | null;
  plan: string;
  allowance: number;
  used: number;
  adjustments: number;
  reserved: number;
  remaining: number;
  percent: number;
  periodStart: string;
  periodEnd: string;
  renewsAt: string | null;
  pendingPlan: string | null;
  status: "active" | "suspended";
  updatedAt: string;
};

type Overview = {
  accounts: number;
  suspended: number;
  exhausted: number;
  near: number;
  usedThisPeriod: number;
  reservedNow: number;
  activeReservations: number;
  stuckReservations: Array<{ id: string; name: string; feature: string; hold: number; heartbeat_at: string }>;
  discrepancies: Array<{ account_id: string; field: string; stored: number; computed: number }>;
  estimatedChargeableLast24h: number;
  failedCallsLast24h: number;
  events: Array<{ id: string; name: string | null; kind: string; plan: string | null; order_id: string | null; created_at: string; details: Record<string, unknown> }>;
};

type Report = {
  totals: { calls: number; billable: number; input: number; output: number; cached: number; reasoning: number; estimatedBillable: number };
  byModel: Array<{ model: string; vendor: string; calls: number; billable: number; input: number; output: number; estimatedBillable: number }>;
  byFeature: Array<{ feature: string; calls: number; billable: number }>;
  recent: Array<{ at: string; model: string; feature: string; input: number; output: number; billable: number; source: string; status: string }>;
};

type Detail = {
  account: Account;
  report: Report;
  reservations: Array<{ id: string; feature: string; hold: number; consumed: number; status: string; created_at: string; heartbeat_at: string }>;
  adjustments: Array<{ id: string; tokens: number; kind: string; reason: string; actor: string; created_at: string; period_start: string }>;
  events: Array<{ id: string; kind: string; plan: string | null; order_id: string | null; created_at: string }>;
};

type FlaggedCall = { id: string; created_at: string; name: string; provider_slug: string; model_id: string; feature: string; input_tokens: number; output_tokens: number; billable_tokens: number; usage_source: string; call_status: string; latency_ms: number | null };

const EVENT_TONE: Record<string, string> = { payment_failed: "red", expired: "amber", refund: "amber", suspended: "red", upgrade: "green", subscribe: "green", renewal: "blue", payment: "blue" };

const tokens = (n: number) => (Math.abs(n) >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : Math.abs(n) >= 1_000 ? `${+(n / 1_000).toFixed(1)}K` : String(n));

/**
 * Usage ledger: every account's monthly balance straight from the ledger, holds still in flight,
 * calls that failed or had to be estimated, plan events, and the reconciliation result. Admin
 * changes are append-only adjustments (bonus, refund, correction, debit) — past usage is never edited.
 */
export default function UsageLedger() {
  const canManage = useCan("users.manage");
  const overview = useResource<Overview>("/console/usage/overview");
  const [filter, setFilter] = useState<"all" | "near" | "exhausted" | "suspended">("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const accounts = useResource<{ accounts: Account[] }>(`/console/usage/accounts?filter=${filter}${query ? `&q=${encodeURIComponent(query)}` : ""}`);
  const [tab, setTab] = useState<"accounts" | "failed" | "estimated" | "events">("accounts");
  const calls = useResource<{ calls: FlaggedCall[] }>(tab === "failed" || tab === "estimated" ? `/console/usage/calls?kind=${tab}` : null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const o = overview.data;

  async function reconcile() {
    setReconciling(true);
    const ok = await act(() => api.post("/console/usage/reconcile", {}), "Reconciliation finished");
    setReconciling(false);
    if (ok) void overview.reload();
  }

  async function exportCsv() {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(`${API_BASE_URL}/console/usage/export.csv?from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${getAccessToken() ?? ""}` } });
    if (!res.ok) return toast.error("Export failed");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `friday-usage-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Usage ledger"
        description="Monthly token balances, in-flight holds, flagged calls and plan events — all from the server ledger. Every change here is an append-only adjustment."
        actions={
          <>
            <Button size="sm" onClick={() => void exportCsv()}><Download className="size-3.5" /> Export 31 days</Button>
            {canManage && <Button size="sm" loading={reconciling} onClick={() => void reconcile()}><RefreshCw className="size-3.5" /> Reconcile now</Button>}
          </>
        }
      />
      {overview.error && <ErrorNote error={overview.error} />}
      {!o ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Accounts" value={formatNumber(o.accounts)} hint={`${o.suspended} suspended`} />
            <Stat label="Used this period" value={tokens(o.usedThisPeriod)} hint={`${tokens(o.reservedNow)} held by ${o.activeReservations} running request${o.activeReservations === 1 ? "" : "s"}`} />
            <Stat label="Out of tokens" value={formatNumber(o.exhausted)} hint={`${o.near} at 80% or more`} accent={o.exhausted ? "#ff6b6b" : undefined} />
            <Stat label="Last 24 h" value={formatNumber(o.failedCallsLast24h)} hint={`failed/partial calls · ${o.estimatedChargeableLast24h} charged on estimates`} />
          </div>
          {(o.discrepancies.length > 0 || o.stuckReservations.length > 0) && (
            <Card className="mt-3 border-amber-500/40">
              <div className="flex items-center gap-2 text-sm font-medium"><AlertTriangle className="size-4 text-amber-300" /> Needs a look</div>
              {o.discrepancies.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {o.discrepancies.map((d, i) => (
                    <li key={i}>Account <button type="button" className="underline" onClick={() => setOpenId(d.account_id)}>{d.account_id.slice(0, 8)}</button>: stored {d.field} {formatNumber(d.stored)} ≠ ledger {formatNumber(d.computed)}</li>
                  ))}
                </ul>
              )}
              {o.stuckReservations.length > 0 && (
                <p className="mt-2 text-sm text-muted">
                  {o.stuckReservations.length} hold{o.stuckReservations.length === 1 ? "" : "s"} silent for 30+ minutes ({o.stuckReservations.map((r) => `${r.name} · ${tokens(r.hold)}`).join(", ")}). They are released automatically after 2 hours without activity.
                </p>
              )}
            </Card>
          )}
        </>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Segmented value={tab} onChange={setTab} options={[{ value: "accounts", label: "Accounts" }, { value: "failed", label: "Failed calls" }, { value: "estimated", label: "Estimated usage" }, { value: "events", label: "Plan events" }]} />
        {tab === "accounts" && (
          <>
            <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} options={[{ value: "all", label: "All" }, { value: "near", label: "80%+" }, { value: "exhausted", label: "Out of tokens" }, { value: "suspended", label: "Suspended" }]} />
            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
              <Input placeholder="Name, org or id" value={q} onChange={(e) => setQ(e.target.value)} />
              <Button size="sm" type="submit"><Search className="size-3.5" /></Button>
            </form>
          </>
        )}
      </div>

      <Card className="mt-3 overflow-x-auto" pad={false}>
        {tab === "accounts" &&
          (accounts.loading && !accounts.data ? (
            <Loading />
          ) : !accounts.data?.accounts.length ? (
            <EmptyState icon={Gauge} title="No accounts" text="Accounts appear after a person's first request since the monthly allowance went live." />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-subtle">
                <tr><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Plan</th><th className="px-3 py-2">Used</th><th className="px-3 py-2">Remaining</th><th className="px-3 py-2">Held</th><th className="px-3 py-2">Period</th><th className="px-3 py-2">Status</th></tr>
              </thead>
              <tbody>
                {accounts.data.accounts.map((a) => (
                  <tr key={a.id} className="cursor-pointer border-t border-border hover:bg-chip/40" onClick={() => setOpenId(a.id)}>
                    <td className="px-3 py-2.5"><div className="font-medium">{a.name}</div><div className="text-xs text-muted">{a.email ?? (a.kind === "organization" ? "Organization pool" : "")}</div></td>
                    <td className="px-3 py-2.5 capitalize">{a.plan}</td>
                    <td className="px-3 py-2.5 tabular-nums">{tokens(a.used + a.adjustments)} / {tokens(a.allowance)} <span className="text-xs text-muted">({a.percent}%)</span></td>
                    <td className="px-3 py-2.5 tabular-nums">{tokens(Math.max(0, a.remaining))}</td>
                    <td className="px-3 py-2.5 tabular-nums">{a.reserved ? tokens(a.reserved) : "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted">{formatDate(a.periodStart)} → {formatDate(a.periodEnd)}</td>
                    <td className="px-3 py-2.5">{a.status === "suspended" ? <Badge tone="red">suspended</Badge> : a.remaining <= 0 ? <Badge tone="amber">out of tokens</Badge> : <Badge tone="green">active</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        {(tab === "failed" || tab === "estimated") &&
          (calls.loading && !calls.data ? (
            <Loading />
          ) : !calls.data?.calls.length ? (
            <EmptyState icon={Gauge} title="Nothing flagged" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-subtle">
                <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Model</th><th className="px-3 py-2">In / out</th><th className="px-3 py-2">Charged</th><th className="px-3 py-2">Status</th></tr>
              </thead>
              <tbody>
                {calls.data.calls.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-3 py-2 text-xs text-muted">{timeAgo(c.created_at)}</td>
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 text-xs">{c.provider_slug}/{c.model_id} · {c.feature}</td>
                    <td className="px-3 py-2 tabular-nums">{tokens(c.input_tokens)} / {tokens(c.output_tokens)}</td>
                    <td className="px-3 py-2 tabular-nums">{tokens(c.billable_tokens)}</td>
                    <td className="px-3 py-2"><Badge tone={c.call_status === "ok" ? "neutral" : "amber"}>{c.call_status}</Badge> {c.usage_source !== "provider" && <Badge>{c.usage_source}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        {tab === "events" &&
          (!o ? (
            <Loading />
          ) : !o.events.length ? (
            <EmptyState icon={Gauge} title="No plan events yet" />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {o.events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <Badge tone={EVENT_TONE[e.kind] ?? "neutral"}>{e.kind.replace(/_/g, " ")}</Badge>
                  <span>{e.name ?? "—"}</span>
                  {e.plan && <span className="capitalize text-muted">{e.plan}</span>}
                  {e.order_id && <span className="text-xs text-subtle">{e.order_id}</span>}
                  <span className="ml-auto text-xs text-muted">{timeAgo(e.created_at)}</span>
                </li>
              ))}
            </ul>
          ))}
      </Card>

      <AccountDrawer
        id={openId}
        canManage={canManage}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          void accounts.reload();
          void overview.reload();
        }}
      />
    </>
  );
}

function AccountDrawer({ id, canManage, onClose, onChanged }: { id: string | null; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const detail = useResource<Detail>(id ? `/console/usage/accounts/${id}` : null);
  const [adj, setAdj] = useState({ tokens: "", kind: "bonus", reason: "" });
  const [busy, setBusy] = useState(false);
  const d = detail.data;
  if (!id) return null;

  async function adjust() {
    const amount = Math.round(Number(adj.tokens));
    if (!amount || adj.reason.trim().length < 3) return toast.error("Enter tokens and a reason");
    // Bonus / refund give tokens back (negative adjustment); debit consumes. Correction takes the sign as typed.
    const signed = adj.kind === "bonus" || adj.kind === "refund" ? -Math.abs(amount) : adj.kind === "debit" ? Math.abs(amount) : amount;
    setBusy(true);
    const ok = await act(() => api.post(`/console/usage/accounts/${id}/adjust`, { tokens: signed, kind: adj.kind, reason: adj.reason.trim() }), "Adjustment recorded");
    setBusy(false);
    if (ok) {
      setAdj({ tokens: "", kind: "bonus", reason: "" });
      void detail.reload();
      onChanged();
    }
  }

  async function toggleSuspend() {
    if (!d) return;
    const reason = window.prompt(d.account.status === "suspended" ? "Reason for restoring access" : "Reason for suspending usage");
    if (!reason || reason.trim().length < 3) return;
    const ok = await act(() => api.post(`/console/usage/accounts/${id}/status`, { suspended: d.account.status !== "suspended", reason: reason.trim() }), "Status updated");
    if (ok) {
      void detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer open onClose={onClose} title={d?.account.name ?? "Account"} subtitle={d && <span className="text-xs text-muted capitalize">{d.account.plan} · {d.account.email ?? d.account.kind}</span>} width={680}>
      {!d ? (
        detail.error ? <ErrorNote error={detail.error} /> : <Loading />
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <Card>
            <div className="text-2xl font-semibold tabular-nums">{tokens(d.account.used + d.account.adjustments)} <span className="text-base font-normal text-muted">/ {tokens(d.account.allowance)} tokens</span></div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <div><dt className="text-muted">Ledger usage</dt><dd>{formatNumber(d.account.used)}</dd></div>
              <div><dt className="text-muted">Adjustments</dt><dd>{formatNumber(d.account.adjustments)}</dd></div>
              <div><dt className="text-muted">Held now</dt><dd>{formatNumber(d.account.reserved)}</dd></div>
              <div><dt className="text-muted">Remaining</dt><dd>{formatNumber(d.account.remaining)}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-muted">
              Period {formatDate(d.account.periodStart)} → {formatDate(d.account.periodEnd)}
              {d.account.renewsAt ? ` · paid through ${formatDate(d.account.renewsAt)}` : ""}
              {d.account.pendingPlan ? ` · ${d.account.pendingPlan} queued` : ""}
            </p>
            <p className="mt-1 text-xs text-muted">
              {formatNumber(d.report.totals.calls)} calls · {tokens(d.report.totals.input)} in · {tokens(d.report.totals.output)} out · {tokens(d.report.totals.cached)} cached
              {d.report.totals.estimatedBillable ? ` · ${tokens(d.report.totals.estimatedBillable)} estimated` : ""}
            </p>
          </Card>

          <div>
            <p className="mb-1 font-medium">By model</p>
            <ul className="space-y-1 text-xs">
              {d.report.byModel.map((m, i) => (
                <li key={i} className="flex justify-between gap-3"><span>{m.model} <span className="text-muted">· {m.vendor} · {m.calls} calls</span></span><span className="tabular-nums">{tokens(m.billable)}</span></li>
              ))}
            </ul>
          </div>

          {canManage && (
            <Card>
              <p className="mb-2 font-medium">Adjust this period</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label="Kind"><Select value={adj.kind} onChange={(e) => setAdj({ ...adj, kind: e.target.value })} options={[{ value: "bonus", label: "Bonus (add tokens)" }, { value: "refund", label: "Refund (add back)" }, { value: "debit", label: "Debit (remove)" }, { value: "correction", label: "Correction (± as typed)" }]} /></Field>
                <Field label="Tokens"><Input type="number" value={adj.tokens} onChange={(e) => setAdj({ ...adj, tokens: e.target.value })} /></Field>
                <Field label="Reason"><Input value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} placeholder="Ticket #, why" /></Field>
              </div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="primary" loading={busy} onClick={() => void adjust()}>Record adjustment</Button>
                <Button size="sm" onClick={() => void toggleSuspend()}>{d.account.status === "suspended" ? "Restore access" : "Suspend usage"}</Button>
              </div>
            </Card>
          )}

          <div>
            <p className="mb-1 font-medium">Adjustments</p>
            {d.adjustments.length === 0 ? <p className="text-xs text-muted">None.</p> : (
              <ul className="space-y-1 text-xs">
                {d.adjustments.map((a) => (
                  <li key={a.id} className="flex justify-between gap-3"><span>{formatDate(a.created_at)} · {a.kind} · {a.reason} <span className="text-muted">by {a.actor}</span></span><span className="tabular-nums">{a.tokens > 0 ? "−" : "+"}{tokens(Math.abs(a.tokens))}</span></li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-1 font-medium">Reservations</p>
            <ul className="space-y-1 text-xs">
              {d.reservations.map((r) => (
                <li key={r.id} className="flex justify-between gap-3"><span>{timeAgo(r.created_at)} · {r.feature} · <Badge tone={r.status === "active" ? "blue" : r.status === "expired" ? "amber" : "neutral"}>{r.status}</Badge></span><span className="tabular-nums">held {tokens(r.hold)} · used {tokens(r.consumed)}</span></li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-1 font-medium">Recent calls</p>
            <ul className="space-y-1 text-xs">
              {d.report.recent.map((r, i) => (
                <li key={i} className="flex justify-between gap-3"><span>{timeAgo(r.at)} · {r.model} · {r.feature}{r.status !== "ok" ? ` · ${r.status}` : ""}{r.source !== "provider" ? ` · ${r.source}` : ""}</span><span className="tabular-nums">{tokens(r.input)} in / {tokens(r.output)} out → {tokens(r.billable)}</span></li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-1 font-medium">Plan events</p>
            <ul className="space-y-1 text-xs">
              {d.events.map((e) => (
                <li key={e.id} className="flex justify-between gap-3"><span><Badge tone={EVENT_TONE[e.kind] ?? "neutral"}>{e.kind.replace(/_/g, " ")}</Badge> {e.plan ?? ""} {e.order_id ?? ""}</span><span className="text-muted">{formatDate(e.created_at)}</span></li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Drawer>
  );
}
