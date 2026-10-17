import { useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, History, Search, SlidersHorizontal, Undo2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCan } from "../access";
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Loading,
  Segmented,
  Stat,
  Textarea,
  act,
  formatDate,
  formatNumber,
  fromLocalInput,
  timeAgo,
  useResource,
} from "../ui";

/**
 * Console → Models & keys → Usage multipliers. How much of a plan's monthly allowance each model's
 * tokens cost (backend: services/quota/multipliers.ts, supabase 0059). Changes are versions, never
 * edits: they apply to calls from their start time on, past usage keeps what it was charged.
 */

type Kind = "base" | "promo";
type Row = {
  id: string;
  provider_slug: string;
  model_id: string;
  multiplier: number;
  kind: Kind;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  created_by: string | null;
  created_at: string;
  cancelled_at: string | null;
};
type Usage = { calls: number; users: number; base_billable: number; billable: number; cost_usd: number };
type ModelInfo = {
  provider_slug: string;
  model_id: string;
  display_name: string;
  enabled: boolean;
  min_tier: string | null;
  current: { multiplier: number; id: string | null; kind: Kind | null; until: string | null };
  scheduled: Row[];
  latest_id: string | null;
  usage30d: Usage | null;
};
type Overview = { models: ModelInfo[]; history: Row[]; maxMultiplier: number; since: string };
type Staff = { staff: Array<{ userId: string; name: string }> };

const QUICK = [0, 0.5, 1, 2, 4, 10];
const keyOf = (m: { provider_slug: string; model_id: string }) => `${m.provider_slug}/${m.model_id}`;
const fmtX = (n: number) => `${Number(n.toFixed(4))}×`;

function rowState(r: Row, now: number): { label: string; tone: string } {
  if (r.cancelled_at) return { label: "Withdrawn", tone: "neutral" };
  if (Date.parse(r.effective_from) > now) return { label: "Scheduled", tone: "blue" };
  if (r.effective_to && Date.parse(r.effective_to) <= now) return { label: "Ended", tone: "neutral" };
  return { label: r.kind === "promo" ? "Promo live" : "In effect", tone: "green" };
}

export default function ModelMultipliers() {
  const canEdit = useCan("models.multipliers");
  const data = useResource<Overview>("/console/models/multipliers");
  const staff = useResource<Staff>("/console/staff");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "custom" | "used">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ModelInfo[] | null>(null);
  const now = Date.now();

  const who = useMemo(() => new Map((staff.data?.staff ?? []).map((s) => [s.userId, s.name])), [staff.data]);
  const models = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data.data?.models ?? []).filter((m) => {
      if (q && !`${m.display_name} ${m.model_id} ${m.provider_slug}`.toLowerCase().includes(q)) return false;
      if (filter === "custom") return m.current.multiplier !== 1 || m.scheduled.length > 0;
      if (filter === "used") return (m.usage30d?.calls ?? 0) > 0;
      return true;
    });
  }, [data.data, query, filter]);

  if (data.loading && !data.data) return <Loading label="Loading multipliers" />;
  if (data.error && !data.data) return <ErrorNote error={data.error} />;
  const all = data.data!.models;
  const custom = all.filter((m) => m.current.multiplier !== 1).length;
  const promos = all.filter((m) => m.current.kind === "promo").length;
  const scheduled = all.reduce((n, m) => n + m.scheduled.length, 0);
  const byKey = new Map(all.map((m) => [keyOf(m), m]));

  const toggle = (k: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const cancel = async (r: Row) => {
    const ok = await act(() => api.post(`/console/models/multipliers/${r.id}/cancel`, {}), r.kind === "promo" && Date.parse(r.effective_from) <= now ? "Promotion ended" : "Scheduled change withdrawn");
    if (ok) void data.reload();
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Models" value={formatNumber(all.length)} hint="Known to the router" />
        <Stat label="Not at 1×" value={formatNumber(custom)} hint="Cost more or less of the allowance" />
        <Stat label="Promotions live" value={formatNumber(promos)} />
        <Stat label="Scheduled changes" value={formatNumber(scheduled)} />
      </div>

      <Card>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative w-full md:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input aria-label="Search models" placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "custom", label: "Customised" },
                { value: "used", label: "Used in 30 days" },
              ]}
            />
            {canEdit && (
              <Button variant="primary" disabled={selected.size === 0} onClick={() => setEditing([...selected].map((k) => byKey.get(k)!).filter(Boolean))}>
                <SlidersHorizontal className="size-4" /> Change {selected.size || ""} selected
              </Button>
            )}
          </div>
        </div>

        {models.length === 0 ? (
          <div className="mt-4">
            <EmptyState icon={Search} title="No models match" text="Try another search or filter." />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  {canEdit && (
                    <th className="w-8 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all shown models"
                        checked={models.length > 0 && models.every((m) => selected.has(keyOf(m)))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(models.map(keyOf)) : new Set())}
                      />
                    </th>
                  )}
                  <th className="py-2 pr-3">Model</th>
                  <th className="py-2 pr-3">Now</th>
                  <th className="py-2 pr-3">Coming up</th>
                  <th className="py-2 pr-3 text-right">Calls · 30 d</th>
                  <th className="py-2 pr-3 text-right">Tokens · 30 d</th>
                  {canEdit && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={keyOf(m)} className="border-b border-border/60 last:border-0">
                    {canEdit && (
                      <td className="py-2.5">
                        <input type="checkbox" aria-label={`Select ${m.display_name}`} checked={selected.has(keyOf(m))} onChange={() => toggle(keyOf(m))} />
                      </td>
                    )}
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{m.display_name}</div>
                      <div className="text-xs text-muted">
                        {m.provider_slug} · {m.model_id}
                        {!m.enabled && " · hidden from users"}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={m.current.multiplier === 1 ? "neutral" : m.current.multiplier < 1 ? "green" : "amber"}>{fmtX(m.current.multiplier)}</Badge>
                      {m.current.kind === "promo" && m.current.until && <div className="mt-1 text-xs text-muted">Promo until {formatDate(m.current.until)}</div>}
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted">
                      {m.scheduled.length === 0
                        ? "—"
                        : m.scheduled.map((s) => (
                            <div key={s.id}>
                              {fmtX(s.multiplier)} {s.kind === "promo" ? "promo" : ""} from {formatDate(s.effective_from)}
                            </div>
                          ))}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{formatNumber(m.usage30d?.calls ?? 0)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{formatNumber(m.usage30d?.billable ?? 0)}</td>
                    {canEdit && (
                      <td className="py-2.5 text-right">
                        <Button size="sm" onClick={() => setEditing([m])}>
                          Change
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2 font-medium">
          <History className="size-4" /> Change history
        </div>
        {data.data!.history.length === 0 ? (
          <p className="text-sm text-muted">No changes yet — every model is charged at 1×.</p>
        ) : (
          <ul className="divide-y divide-border/60 text-sm">
            {data.data!.history.map((r) => {
              const st = rowState(r, now);
              const name = byKey.get(keyOf(r))?.display_name ?? r.model_id;
              const cancellable = canEdit && !r.cancelled_at && (Date.parse(r.effective_from) > now || (r.kind === "promo" && r.effective_to && Date.parse(r.effective_to) > now));
              return (
                <li key={r.id} className="flex flex-col gap-1 py-2.5 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.provider_slug === "*" ? `${name} (every provider)` : name}</span>
                      <Badge tone="neutral">{fmtX(r.multiplier)}</Badge>
                      {r.kind === "promo" && <Badge tone="blue">Promotion</Badge>}
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {r.reason} · from {formatDate(r.effective_from)}
                      {r.effective_to && ` to ${formatDate(r.effective_to)}`} · {who.get(r.created_by ?? "") ?? "a teammate"} {timeAgo(r.created_at)}
                    </div>
                  </div>
                  {cancellable && (
                    <Button size="sm" onClick={() => void cancel(r)}>
                      <Undo2 className="size-4" /> {Date.parse(r.effective_from) > now ? "Withdraw" : "End now"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {editing && (
        <ChangeDrawer
          models={editing}
          max={data.data!.maxMultiplier}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            setSelected(new Set());
            void data.reload();
          }}
        />
      )}
    </div>
  );
}

function ChangeDrawer({ models, max, onClose, onDone }: { models: ModelInfo[]; max: number; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState(String(models.length === 1 ? models[0]!.current.multiplier : 1));
  const [kind, setKind] = useState<Kind>("base");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const n = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= max && Math.round(n * 10_000) === n * 10_000;
  const fromIso = when === "later" ? fromLocalInput(from) : null;
  const toIso = kind === "promo" ? fromLocalInput(to) : null;
  const timesOk = (when === "now" || Boolean(fromIso)) && (kind === "base" || (Boolean(toIso) && Date.parse(toIso!) > (fromIso ? Date.parse(fromIso) : Date.now())));
  const ready = valid && timesOk && reason.trim().length >= 3;

  const totals = models.reduce(
    (t, m) => {
      const base = m.usage30d?.base_billable ?? 0;
      t.users += m.usage30d?.users ?? 0;
      t.charged += m.usage30d?.billable ?? 0;
      t.projected += valid ? Math.ceil(base * n) : 0;
      t.cost += m.usage30d?.cost_usd ?? 0;
      return t;
    },
    { users: 0, charged: 0, projected: 0, cost: 0 },
  );

  const publish = async () => {
    setBusy(true);
    const ok = await act(
      () =>
        api.post("/console/models/multipliers", {
          models: models.map((m) => ({ provider_slug: m.provider_slug, model_id: m.model_id, expected_latest: m.latest_id })),
          multiplier: n,
          kind,
          effective_from: fromIso,
          effective_to: toIso,
          reason: reason.trim(),
        }),
      when === "later" ? "Change scheduled" : kind === "promo" ? "Promotion is live" : "Multiplier updated",
    );
    setBusy(false);
    if (ok) onDone();
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={models.length === 1 ? `Change ${models[0]!.display_name}` : `Change ${models.length} models`}
      subtitle="Applies to calls from the start time on. Past usage keeps the multiplier it was charged at."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void publish()}>
            {when === "later" ? "Schedule change" : "Publish"}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Multiplier" hint={`0 to ${max}. 2× means each token costs twice as much of the allowance.`}>
          <div className="flex flex-wrap gap-2">
            {QUICK.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setValue(String(q))}
                className={cn("rounded-lg border px-3 py-1.5 text-sm transition-colors", n === q && valid ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-chip")}
              >
                {fmtX(q)}
              </button>
            ))}
            <Input aria-label="Custom multiplier" inputMode="decimal" className="w-28" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          {!valid && value !== "" && <p className="mt-1 text-xs text-danger">Use a number from 0 to {max}, at most 4 decimals.</p>}
        </Field>

        <Field label="Type">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "base", label: "Standing value" },
              { value: "promo", label: "Temporary promotion" },
            ]}
          />
        </Field>

        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Starts">
            <Segmented
              value={when}
              onChange={setWhen}
              options={[
                { value: "now", label: "Now" },
                { value: "later", label: "Schedule" },
              ]}
            />
            {when === "later" && <Input type="datetime-local" className="mt-2" aria-label="Start time" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          {kind === "promo" && (
            <Field label="Ends" hint="The standing value comes back automatically.">
              <Input type="datetime-local" aria-label="End time" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          )}
        </div>

        <Field label="Reason" hint="Goes in the history and the audit log.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Opus costs us 5× Sonnet; launch week promotion" />
        </Field>

        <Card className="bg-chip">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <CalendarClock className="size-4" /> Impact on the last 30 days of real usage
          </div>
          <ul className="space-y-1 text-sm">
            {models.map((m) => (
              <li key={keyOf(m)} className="flex justify-between gap-3">
                <span className="truncate">{m.display_name}</span>
                <span className="tabular-nums text-muted">
                  {fmtX(m.current.multiplier)} → <span className="font-medium text-foreground">{valid ? fmtX(n) : "?"}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              <div className="text-xs text-muted">Charged to customers</div>
              <div className="tabular-nums">{formatNumber(totals.charged)} tokens</div>
            </div>
            <div>
              <div className="text-xs text-muted">At the new value</div>
              <div className="tabular-nums font-medium">{valid ? `${formatNumber(totals.projected)} tokens` : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Customers who used them</div>
              <div className="tabular-nums">{formatNumber(totals.users)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">Our provider cost (unchanged)</div>
              <div className="tabular-nums">${totals.cost.toFixed(2)}</div>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">A replay of past traffic at the new value — not a forecast.</p>
        </Card>

        {valid && n === 0 && (
          <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>At 0× customers use {models.length === 1 ? "this model" : "these models"} without touching their allowance. We still pay the provider for every call.</span>
          </div>
        )}
      </div>
    </Drawer>
  );
}
