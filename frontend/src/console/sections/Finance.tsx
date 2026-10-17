import { useMemo, useState } from "react";
import { AlertTriangle, IndianRupee, Plus, RefreshCw, Receipt, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCan } from "../access";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Segmented, Select, Stat, Textarea, Toggle, act, useResource } from "../ui";
import { FinanceSummary } from "./FinanceSummary";

/**
 * Finance (Team Console): what every model costs us vs what we charge (per 1M tokens, ₹ and %),
 * the P&L for any date range (real revenue − AI cost − other expenses), and expense tracking.
 * All money math is server-side (backend services/finance) so this page only displays numbers.
 */

type Settings = {
  usd_to_inr: number;
  default_markup_pct: number;
  blended_cost_per_m_inr: number;
  target_cost_share_pct: number;
  free_cost_budget_inr: number;
  e2b_cost_per_hour_inr: number;
  updated_at?: string;
};

type PriceRow = {
  id: string;
  provider_slug: string;
  model_id: string;
  display_name: string | null;
  cost_currency: "USD" | "INR";
  cost_input_per_m: number | null;
  cost_output_per_m: number | null;
  cost_cache_read_per_m: number | null;
  cost_cache_write_per_m: number | null;
  cost_per_image: number | null;
  cost_source: string;
  sell_input_per_m_inr: number | null;
  sell_output_per_m_inr: number | null;
  sell_per_image_inr: number | null;
  is_public: boolean;
  cost_override?: boolean;
  notes: string;
  updated_at: string;
  effective: {
    costInputPerMInr: number;
    costOutputPerMInr: number;
    sellInputPerMInr: number;
    sellOutputPerMInr: number;
    sellIsDefault: boolean;
    inputMarginPct: number | null;
    outputMarginPct: number | null;
  } | null;
};

type PricingData = { settings: Settings; pricing: PriceRow[]; missing: { slug: string; model_id: string; display_name: string }[] };

type ModelLine = {
  provider: string;
  model: string;
  name: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costInr: number;
  valueInr: number;
  marginInr: number;
  marginPct: number | null;
  pricing: "exact" | "current" | "estimated";
  costPerM: { input: number; output: number } | null;
  sellPerM: { input: number; output: number } | null;
};

type Expense = {
  id: string;
  category: string;
  vendor: string;
  description: string;
  amount: number;
  currency: "INR" | "USD";
  amount_inr: number;
  incurred_on: string;
  recurrence: "none" | "monthly" | "yearly";
  payment_method: string;
  reference: string;
  is_model_credits: boolean;
};

type Report = {
  window: { from: string; to: string };
  settings: Settings;
  models: ModelLine[];
  images: { count: number; costInr: number | null; valuePerImageInr: number | null; priced: boolean };
  expenses: (Expense & { occurrences: number; totalInr: number })[];
  expensesByCategory: { category: string; label: string; amountInr: number }[];
  totals: {
    revenueInr: number;
    aiCostInr: number;
    sandboxHours?: number;
    sandboxCostInr?: number;
    usageValueInr: number;
    usageMarginPct: number | null;
    grossProfitInr: number;
    grossMarginPct: number | null;
    otherExpensesInr: number;
    netProfitInr: number;
    netMarginPct: number | null;
    modelCreditsBoughtInr: number;
    unpricedModels: string[];
  };
};

const inr = (n: number | null | undefined, digits = 2) =>
  n == null ? "—" : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const pct = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)}%`);
const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const profitTone = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-danger" : "text-foreground");
const today = () => new Date().toISOString().slice(0, 10);

export default function Finance() {
  const [tab, setTab] = useState<"summary" | "pnl" | "live" | "pricing" | "expenses">("summary");
  return (
    <>
      <PageHeader title="Finance" description="Model cost vs price per 1M tokens, profit by model, the company P&L and expenses — all in ₹." />
      <div className="mb-5">
        <Segmented value={tab} onChange={setTab} options={[{ value: "summary", label: "Summary" }, { value: "pnl", label: "Profit & loss" }, { value: "live", label: "Live usage" }, { value: "pricing", label: "Model pricing" }, { value: "expenses", label: "Expenses" }]} />
      </div>
      {tab === "summary" && <FinanceSummary />}
      {tab === "pnl" && <PnL />}
      {tab === "live" && <LiveUsage />}
      {tab === "pricing" && <Pricing />}
      {tab === "expenses" && <Expenses />}
    </>
  );
}

// ── Profit & loss ────────────────────────────────────────────────────────────────────────────

function PnL() {
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const report = useResource<Report>(`/console/finance/report?from=${from}&to=${to}`);
  const r = report.data;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="flex gap-1.5 pb-0.5">
          {[
            { label: "This month", f: `${today().slice(0, 7)}-01` },
            { label: "Last 30 days", f: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10) },
            { label: "This year", f: `${today().slice(0, 4)}-01-01` },
          ].map((p) => (
            <Button key={p.label} size="sm" onClick={() => { setFrom(p.f); setTo(today()); }}>{p.label}</Button>
          ))}
        </div>
      </div>
      <ErrorNote error={report.error} />
      {report.loading && !r ? (
        <Loading />
      ) : r ? (
        <>
          {r.totals.unpricedModels.length > 0 && (
            <Card className="flex items-start gap-3 border-amber-500/30">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
              <div className="text-sm">
                <span className="font-medium">No price set for {r.totals.unpricedModels.length} model{r.totals.unpricedModels.length === 1 ? "" : "s"}</span>{" "}
                <span className="text-muted">— their cost below is a rough estimate. Set them in Model pricing: {r.totals.unpricedModels.join(", ")}</span>
              </div>
            </Card>
          )}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Revenue" value={inr(r.totals.revenueInr, 0)} hint="Captured payments (Razorpay)" accent="#4f8cff" />
            <Stat label="AI cost" value={inr(r.totals.aiCostInr, 0)} hint={`${pct(r.totals.aiCostInr && r.totals.revenueInr ? (r.totals.aiCostInr / r.totals.revenueInr) * 100 : null)} of revenue`} accent="#ff6b6b" />
            <Stat label="Other expenses" value={inr(r.totals.otherExpensesInr, 0)} hint={r.totals.modelCreditsBoughtInr ? `+ ${inr(r.totals.modelCreditsBoughtInr, 0)} provider credits bought (not double-counted)` : "Servers, salaries, tools…"} accent="#ffb547" />
            <Stat
              label="Net profit"
              value={<span className={profitTone(r.totals.netProfitInr)}>{inr(r.totals.netProfitInr, 0)}</span>}
              hint={`Net margin ${pct(r.totals.netMarginPct)} · gross ${pct(r.totals.grossMarginPct)}`}
              accent="#34d399"
            />
          </div>

          <Card pad={false}>
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="text-sm font-semibold">Profit by model</div>
              <div className="text-xs text-muted">
                Usage value at our prices {inr(r.totals.usageValueInr, 0)} · margin {pct(r.totals.usageMarginPct)} · FX ₹{r.settings.usd_to_inr}/$
              </div>
            </div>
            {r.models.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No model usage in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-subtle">
                    <tr className="border-b border-border">
                      <th className="px-5 py-2 font-medium">Model</th>
                      <th className="px-3 py-2 text-right font-medium">Calls</th>
                      <th className="px-3 py-2 text-right font-medium">Input / output</th>
                      <th className="px-3 py-2 text-right font-medium">Cost / 1M in·out</th>
                      <th className="px-3 py-2 text-right font-medium">Our price / 1M in·out</th>
                      <th className="px-3 py-2 text-right font-medium">Cost</th>
                      <th className="px-3 py-2 text-right font-medium">Value</th>
                      <th className="px-5 py-2 text-right font-medium">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.models.map((m) => (
                      <tr key={`${m.provider}/${m.model}`} className="border-b border-border/60 last:border-0">
                        <td className="px-5 py-2.5">
                          <div className="font-medium">{m.name}</div>
                          <div className="flex items-center gap-1.5 text-xs text-subtle">
                            {m.provider} · {m.model}
                            {m.pricing !== "exact" && <Badge tone={m.pricing === "estimated" ? "amber" : "neutral"}>{m.pricing === "estimated" ? "no price" : "today's price"}</Badge>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{m.calls.toLocaleString("en-IN")}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                          {tokens(m.inputTokens)} / {tokens(m.outputTokens)}
                          {m.cachedTokens > 0 && <div className="text-[11px] text-subtle">{tokens(m.cachedTokens)} cached</div>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted">{m.costPerM ? `${inr(m.costPerM.input)} · ${inr(m.costPerM.output)}` : "—"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted">{m.sellPerM ? `${inr(m.sellPerM.input)} · ${inr(m.sellPerM.output)}` : "—"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{inr(m.costInr)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{inr(m.valueInr)}</td>
                        <td className={cn("px-5 py-2.5 text-right tabular-nums", profitTone(m.marginInr))}>
                          {inr(m.marginInr)}
                          <div className="text-[11px]">{pct(m.marginPct)}</div>
                        </td>
                      </tr>
                    ))}
                    {r.images.count > 0 && (
                      <tr>
                        <td className="px-5 py-2.5">
                          <div className="font-medium">Image generation</div>
                          <div className="text-xs text-subtle">{r.images.priced ? "per image" : "set a per-image cost in Model pricing"}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{r.images.count}</td>
                        <td colSpan={3} />
                        <td className="px-3 py-2.5 text-right tabular-nums">{inr(r.images.costInr)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{r.images.valuePerImageInr != null ? inr(r.images.valuePerImageInr * r.images.count) : "—"}</td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <div className="mb-3 text-sm font-semibold">Statement</div>
              <dl className="grid gap-1.5 text-sm">
                {[
                  ["Revenue", r.totals.revenueInr],
                  ["− AI model cost", -r.totals.aiCostInr],
                  [`− E2B sandboxes (${r.totals.sandboxHours ?? 0} h)`, -(r.totals.sandboxCostInr ?? 0)],
                  ["= Gross profit", r.totals.grossProfitInr],
                  ...r.expensesByCategory.map((c) => [`− ${c.label}`, -c.amountInr] as [string, number]),
                  ["= Net profit", r.totals.netProfitInr],
                ].map(([label, value]) => (
                  <div key={label as string} className={cn("flex justify-between", String(label).startsWith("=") && "border-t border-border pt-1.5 font-semibold")}>
                    <dt className="text-muted">{label}</dt>
                    <dd className={cn("tabular-nums", String(label).startsWith("=") && profitTone(value as number))}>{inr(value as number)}</dd>
                  </div>
                ))}
              </dl>
            </Card>
            <Card>
              <div className="mb-3 text-sm font-semibold">How these numbers are made</div>
              <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted">
                <li>Every model call is priced when it happens at that model's cost per 1M tokens (input, output, cache read, cache write) — later price edits don't rewrite history.</li>
                <li>"Value" is what the usage would bill at our per-1M prices; profit uses real revenue, never value.</li>
                <li>USD costs convert at the books' rate (₹{r.settings.usd_to_inr}/$), set in Model pricing.</li>
                <li>Provider credit top-ups are cash out but not a P&L line — their usage is already the AI cost.</li>
                <li>Recurring expenses count once per month/year they fall inside the dates.</li>
              </ul>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Model pricing ────────────────────────────────────────────────────────────────────────────

function Pricing() {
  const data = useResource<PricingData>("/console/finance/pricing");
  const canManage = useCan("finance.manage");
  const [editing, setEditing] = useState<Partial<PriceRow> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const s = settings ?? data.data?.settings ?? null;

  async function sync(force: boolean) {
    setSyncing(true);
    try {
      const res = await api.post<{ updated: number; unmatched: string[]; skipped: string[] }>("/console/finance/pricing/sync", { force });
      await act(async () => undefined, `Updated ${res.updated} model price${res.updated === 1 ? "" : "s"}${res.unmatched.length ? ` · ${res.unmatched.length} not on the list (set by hand)` : ""}${res.skipped.length ? ` · ${res.skipped.length} kept (your own prices)` : ""}`);
      void data.reload();
    } catch (err) {
      await act(() => Promise.reject(err));
    } finally {
      setSyncing(false);
    }
  }

  if (data.loading && !data.data) return <Loading />;
  return (
    <div className="flex flex-col gap-5">
      <ErrorNote error={data.error} />
      {s && (
        <Card className="flex flex-wrap items-end gap-4">
          <Field label="USD → INR (books' rate)" hint="From your bank / forex statement">
            <Input type="number" step="0.01" disabled={!canManage} value={s.usd_to_inr} onChange={(e) => setSettings({ ...s, usd_to_inr: Number(e.target.value) })} />
          </Field>
          <Field label="Default markup %" hint="Used when a model has no sell price">
            <Input type="number" step="1" disabled={!canManage} value={s.default_markup_pct} onChange={(e) => setSettings({ ...s, default_markup_pct: Number(e.target.value) })} />
          </Field>
          <Field label="Blended cost ₹ / 1M tokens" hint="Flat supplier rate for every model (0 = use each model's own price)">
            <Input type="number" step="0.5" min={0} disabled={!canManage} value={s.blended_cost_per_m_inr} onChange={(e) => setSettings({ ...s, blended_cost_per_m_inr: Number(e.target.value) })} />
          </Field>
          <Field label="Target usage cost % of plan price" hint="Drives the suggested limits in Plans → Profit">
            <Input type="number" step="1" min={1} max={100} disabled={!canManage} value={s.target_cost_share_pct} onChange={(e) => setSettings({ ...s, target_cost_share_pct: Number(e.target.value) })} />
          </Field>
          <Field label="Free user budget ₹ / month" hint="Most one Free user may cost us">
            <Input type="number" step="1" min={0} disabled={!canManage} value={s.free_cost_budget_inr} onChange={(e) => setSettings({ ...s, free_cost_budget_inr: Number(e.target.value) })} />
          </Field>
          <Field label="E2B sandbox ₹ / hour" hint="Build time is billed to profit at this rate">
            <Input type="number" step="0.1" min={0} disabled={!canManage} value={s.e2b_cost_per_hour_inr} onChange={(e) => setSettings({ ...s, e2b_cost_per_hour_inr: Number(e.target.value) })} />
          </Field>
          {canManage && (
            <Button
              variant="primary"
              disabled={!settings}
              onClick={async () => {
                if (await act(() => api.post("/console/finance/settings", { usd_to_inr: s.usd_to_inr, default_markup_pct: s.default_markup_pct, blended_cost_per_m_inr: s.blended_cost_per_m_inr, target_cost_share_pct: s.target_cost_share_pct, free_cost_budget_inr: s.free_cost_budget_inr, e2b_cost_per_hour_inr: s.e2b_cost_per_hour_inr }), "Saved")) {
                  setSettings(null);
                  void data.reload();
                }
              }}
            >
              Save
            </Button>
          )}
          <span className="flex-1" />
          {canManage && (
            <>
              <Button loading={syncing} onClick={() => void sync(false)} title="Fills cost prices from OpenRouter's public list; keeps prices you entered yourself">
                <RefreshCw className="size-3.5" /> Sync list prices
              </Button>
              <Button variant="primary" onClick={() => setEditing({ cost_currency: "USD", is_public: false })}><Plus className="size-4" /> Add model price</Button>
            </>
          )}
        </Card>
      )}
      {data.data && data.data.missing.length > 0 && (
        <Card className="flex items-start gap-3 border-amber-500/30">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div className="text-sm">
            <span className="font-medium">{data.data.missing.length} enabled model{data.data.missing.length === 1 ? " has" : "s have"} no price yet.</span>{" "}
            <span className="text-muted">Their usage can't be costed exactly. Sync list prices or add them:</span>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.data.missing.map((m) => (
                <button key={`${m.slug}/${m.model_id}`} type="button" disabled={!canManage} onClick={() => setEditing({ provider_slug: m.slug, model_id: m.model_id, display_name: m.display_name, cost_currency: "USD", is_public: false })} className="rounded-full bg-chip px-2.5 py-1 text-xs hover:bg-chip-on">
                  {m.slug}/{m.model_id}
                </button>
              ))}
            </div>
          </div>
        </Card>
      )}
      <Card pad={false}>
        {!data.data?.pricing.length ? (
          <EmptyState icon={IndianRupee} title="No model prices yet" text="Sync list prices to fill what each model costs, then set what you charge." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-subtle">
                <tr className="border-b border-border">
                  <th className="px-5 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 text-right font-medium">We pay / 1M in · out</th>
                  <th className="px-3 py-2 text-right font-medium">≈ in ₹</th>
                  <th className="px-3 py-2 text-right font-medium">We charge / 1M in · out</th>
                  <th className="px-3 py-2 text-right font-medium">Margin in · out</th>
                  <th className="px-5 py-2 font-medium">Bought from</th>
                </tr>
              </thead>
              <tbody>
                {data.data.pricing.map((p) => {
                  const sym = p.cost_currency === "USD" ? "$" : "₹";
                  return (
                    <tr key={p.id} onClick={() => canManage && setEditing(p)} className={cn("border-b border-border/60 last:border-0", canManage && "cursor-pointer hover:bg-chip/40")}>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-1.5 font-medium">
                          {p.display_name ?? p.model_id}
                          {p.is_public && <Badge tone="blue">public</Badge>}
                        </div>
                        <div className="text-xs text-subtle">{p.provider_slug} · {p.model_id}</div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {p.cost_input_per_m != null ? `${sym}${p.cost_input_per_m} · ${sym}${p.cost_output_per_m}` : p.cost_per_image != null ? `${sym}${p.cost_per_image} / image` : <Badge tone="amber">not set</Badge>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted">{p.effective ? `${inr(p.effective.costInputPerMInr)} · ${inr(p.effective.costOutputPerMInr)}` : "—"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {p.effective ? `${inr(p.effective.sellInputPerMInr)} · ${inr(p.effective.sellOutputPerMInr)}` : p.sell_per_image_inr != null ? `${inr(p.sell_per_image_inr)} / image` : "—"}
                        {p.effective?.sellIsDefault && <div className="text-[11px] text-subtle">default markup</div>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {p.effective ? (
                          <span className={profitTone(Math.min(p.effective.inputMarginPct ?? 0, p.effective.outputMarginPct ?? 0))}>
                            {pct(p.effective.inputMarginPct)} · {pct(p.effective.outputMarginPct)}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="max-w-56 truncate px-5 py-2.5 text-xs text-muted" title={p.cost_source}>{p.cost_source || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <PriceDrawer row={editing} settings={s} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void data.reload(); }} />
    </div>
  );
}

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

function PriceDrawer({ row, settings, onClose, onSaved }: { row: Partial<PriceRow> | null; settings: Settings | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Partial<PriceRow>>({});
  const [busy, setBusy] = useState(false);
  const key = row ? `${row.id ?? ""}${row.provider_slug ?? ""}${row.model_id ?? ""}` : "";
  const current = useMemo(() => (row ? { ...row } : {}), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = { ...current, ...form };
  const set = (patch: Partial<PriceRow>) => setForm((x) => ({ ...x, ...patch }));
  const fx = settings?.usd_to_inr ?? 88;
  const toInr = (v: number | null | undefined) => (v == null ? null : f.cost_currency === "INR" ? v : v * fx);
  const sellIn = f.sell_input_per_m_inr ?? (toInr(f.cost_input_per_m) != null ? toInr(f.cost_input_per_m)! * (1 + (settings?.default_markup_pct ?? 40) / 100) : null);
  const sellOut = f.sell_output_per_m_inr ?? (toInr(f.cost_output_per_m) != null ? toInr(f.cost_output_per_m)! * (1 + (settings?.default_markup_pct ?? 40) / 100) : null);
  const margin = (sell: number | null, cost: number | null) => (sell && cost != null ? ((sell - cost) / sell) * 100 : null);
  const close = () => { setForm({}); onClose(); };
  const field = (k: keyof PriceRow) => ({
    value: f[k] == null ? "" : String(f[k]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set({ [k]: numOrNull(e.target.value) } as Partial<PriceRow>),
    type: "number",
    step: "any",
    min: 0,
  });
  return (
    <Drawer
      open={Boolean(row)}
      onClose={close}
      title={row?.id ? (row.display_name ?? row.model_id) : "Model price"}
      subtitle="Prices are per 1 million tokens"
      footer={
        <>
          {row?.id && (
            <Button variant="danger" onClick={async () => { if (await act(() => api.delete(`/console/finance/pricing/${row.id}`), "Price removed")) { setForm({}); onSaved(); } }}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <span className="flex-1" />
          <Button
            variant="primary"
            loading={busy}
            disabled={!f.provider_slug || !f.model_id}
            onClick={async () => {
              setBusy(true);
              const ok = await act(
                () =>
                  api.post("/console/finance/pricing", {
                    provider_slug: f.provider_slug, model_id: f.model_id, display_name: f.display_name ?? null, cost_currency: f.cost_currency ?? "USD",
                    cost_input_per_m: f.cost_input_per_m ?? null, cost_output_per_m: f.cost_output_per_m ?? null,
                    cost_cache_read_per_m: f.cost_cache_read_per_m ?? null, cost_cache_write_per_m: f.cost_cache_write_per_m ?? null,
                    cost_per_image: f.cost_per_image ?? null, cost_source: f.cost_source ?? "",
                    sell_input_per_m_inr: f.sell_input_per_m_inr ?? null, sell_output_per_m_inr: f.sell_output_per_m_inr ?? null,
                    sell_per_image_inr: f.sell_per_image_inr ?? null, is_public: Boolean(f.is_public), cost_override: Boolean(f.cost_override), notes: f.notes ?? "",
                  }),
                "Price saved",
              );
              setBusy(false);
              if (ok) { setForm({}); onSaved(); }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Provider"><Input value={f.provider_slug ?? ""} disabled={Boolean(row?.id)} onChange={(e) => set({ provider_slug: e.target.value.trim() })} placeholder="anthropic" /></Field>
          <Field label="Model id"><Input value={f.model_id ?? ""} disabled={Boolean(row?.id)} onChange={(e) => set({ model_id: e.target.value.trim() })} placeholder="claude-sonnet-4-5" /></Field>
        </div>
        <Field label="Display name"><Input value={f.display_name ?? ""} onChange={(e) => set({ display_name: e.target.value })} /></Field>
        <div className="mt-2 text-xs font-semibold tracking-wide text-subtle uppercase">What we pay</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Currency"><Select value={f.cost_currency ?? "USD"} onChange={(e) => set({ cost_currency: e.target.value as "USD" | "INR" })} options={[{ value: "USD", label: "USD ($)" }, { value: "INR", label: "INR (₹)" }]} /></Field>
          <Field label="Bought from / source"><Input value={f.cost_source ?? ""} onChange={(e) => set({ cost_source: e.target.value })} placeholder="ScaleMax invoice Sep 2026" /></Field>
          <Field label="Input / 1M"><Input {...field("cost_input_per_m")} /></Field>
          <Field label="Output / 1M"><Input {...field("cost_output_per_m")} /></Field>
          <Field label="Cache read / 1M" hint="Empty = provider's standard ratio"><Input {...field("cost_cache_read_per_m")} /></Field>
          <Field label="Cache write / 1M"><Input {...field("cost_cache_write_per_m")} /></Field>
          <Field label="Per image" hint="Image models only"><Input {...field("cost_per_image")} /></Field>
        </div>
        <div className="mt-2 text-xs font-semibold tracking-wide text-subtle uppercase">What we charge (₹)</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Input / 1M" hint={f.sell_input_per_m_inr == null && sellIn != null ? `Default: ₹${sellIn.toFixed(2)}` : undefined}><Input {...field("sell_input_per_m_inr")} /></Field>
          <Field label="Output / 1M" hint={f.sell_output_per_m_inr == null && sellOut != null ? `Default: ₹${sellOut.toFixed(2)}` : undefined}><Input {...field("sell_output_per_m_inr")} /></Field>
          <Field label="Per image"><Input {...field("sell_per_image_inr")} /></Field>
        </div>
        <Card className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-muted">Margin on input</div>
          <div className={cn("text-right tabular-nums", profitTone(margin(sellIn, toInr(f.cost_input_per_m)) ?? 0))}>{pct(margin(sellIn, toInr(f.cost_input_per_m)))}</div>
          <div className="text-muted">Margin on output</div>
          <div className={cn("text-right tabular-nums", profitTone(margin(sellOut, toInr(f.cost_output_per_m)) ?? 0))}>{pct(margin(sellOut, toInr(f.cost_output_per_m)))}</div>
        </Card>
        <Toggle checked={Boolean(f.cost_override)} onChange={(v) => set({ cost_override: v })} label="Use this model's own cost (ignore the blended supplier rate)" />
        <Toggle checked={Boolean(f.is_public)} onChange={(v) => set({ is_public: v })} label="Show this price publicly (Plans page)" />
        <Field label="Notes"><Textarea value={f.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
    </Drawer>
  );
}

// ── Expenses ─────────────────────────────────────────────────────────────────────────────────

function Expenses() {
  const list = useResource<{ expenses: Expense[]; categories: { id: string; label: string }[] }>("/console/finance/expenses");
  const canManage = useCan("finance.manage");
  const [editing, setEditing] = useState<Partial<Expense> | null>(null);
  const cats = list.data?.categories ?? [];
  const label = (id: string) => cats.find((c) => c.id === id)?.label ?? id;
  const monthly = (list.data?.expenses ?? []).filter((e) => e.recurrence === "monthly").reduce((n, e) => n + e.amount_inr, 0);
  const yearly = (list.data?.expenses ?? []).filter((e) => e.recurrence === "yearly").reduce((n, e) => n + e.amount_inr, 0);
  return (
    <div className="flex flex-col gap-5">
      <ErrorNote error={list.error} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat label="Recurring / month" value={inr(monthly + yearly / 12, 0)} hint={`${inr(monthly, 0)} monthly + ${inr(yearly, 0)}/yr`} accent="#ffb547" />
        <Stat label="Expenses on file" value={(list.data?.expenses.length ?? 0).toLocaleString("en-IN")} accent="#4f8cff" />
        <div className="flex items-end justify-end">
          {canManage && <Button variant="primary" onClick={() => setEditing({ currency: "INR", recurrence: "none", category: "infrastructure", incurred_on: today() })}><Plus className="size-4" /> Add expense</Button>}
        </div>
      </div>
      <Card pad={false}>
        {list.loading && !list.data ? (
          <Loading />
        ) : !list.data?.expenses.length ? (
          <EmptyState icon={Receipt} title="No expenses yet" text="Add servers, tools, salaries and provider top-ups to see real net profit." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-subtle">
              <tr className="border-b border-border">
                <th className="px-5 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Vendor · description</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Repeats</th>
                <th className="px-5 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {list.data.expenses.map((e) => (
                <tr key={e.id} onClick={() => canManage && setEditing(e)} className={cn("border-b border-border/60 last:border-0", canManage && "cursor-pointer hover:bg-chip/40")}>
                  <td className="px-5 py-2.5 text-muted tabular-nums">{new Date(`${e.incurred_on}T00:00:00`).toLocaleDateString("en-IN")}</td>
                  <td className="px-3 py-2.5"><div className="font-medium">{e.vendor || "—"}</div><div className="text-xs text-subtle">{e.description}</div></td>
                  <td className="px-3 py-2.5"><Badge tone={e.is_model_credits ? "purple" : "neutral"}>{label(e.category)}</Badge></td>
                  <td className="px-3 py-2.5 text-muted">{e.recurrence === "none" ? "Once" : e.recurrence === "monthly" ? "Monthly" : "Yearly"}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums">
                    {inr(e.amount_inr)}
                    {e.currency === "USD" && <div className="text-[11px] text-subtle">${e.amount.toLocaleString("en-US")}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <ExpenseDrawer expense={editing} categories={cats} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />
    </div>
  );
}

function ExpenseDrawer({ expense, categories, onClose, onSaved }: { expense: Partial<Expense> | null; categories: { id: string; label: string }[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const base = expense
    ? {
        category: expense.category ?? "other", vendor: expense.vendor ?? "", description: expense.description ?? "", amount: expense.amount != null ? String(expense.amount) : "",
        currency: expense.currency ?? "INR", amountInr: expense.id && expense.currency === "USD" ? String(expense.amount_inr ?? "") : "", incurredOn: expense.incurred_on ?? today(),
        recurrence: expense.recurrence ?? "none", paymentMethod: expense.payment_method ?? "", reference: expense.reference ?? "",
      }
    : null;
  const f = { ...(base ?? {}), ...form } as Record<string, string>;
  const set = (k: string, v: string) => setForm((x) => ({ ...x, [k]: v }));
  const close = () => { setForm({}); onClose(); };
  return (
    <Drawer
      open={Boolean(expense)}
      onClose={close}
      title={expense?.id ? "Expense" : "Add expense"}
      footer={
        <>
          {expense?.id && (
            <Button variant="danger" onClick={async () => { if (await act(() => api.delete(`/console/finance/expenses/${expense.id}`), "Expense deleted")) { setForm({}); onSaved(); } }}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <span className="flex-1" />
          <Button
            variant="primary"
            loading={busy}
            disabled={!f.amount || Number(f.amount) < 0}
            onClick={async () => {
              setBusy(true);
              const payload = {
                category: f.category, vendor: f.vendor, description: f.description, amount: Number(f.amount), currency: f.currency,
                amountInr: f.currency === "USD" && f.amountInr ? Number(f.amountInr) : null, incurredOn: f.incurredOn, recurrence: f.recurrence,
                paymentMethod: f.paymentMethod, reference: f.reference,
              };
              const ok = await act(() => (expense?.id ? api.patch(`/console/finance/expenses/${expense.id}`, payload) : api.post("/console/finance/expenses", payload)), "Saved");
              setBusy(false);
              if (ok) { setForm({}); onSaved(); }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category"><Select value={f.category} onChange={(e) => set("category", e.target.value)} options={categories.map((c) => ({ value: c.id, label: c.label }))} /></Field>
          <Field label="Date"><Input type="date" value={f.incurredOn} onChange={(e) => set("incurredOn", e.target.value)} /></Field>
        </div>
        <Field label="Vendor"><Input value={f.vendor} onChange={(e) => set("vendor", e.target.value)} placeholder="Railway, AWS, Google Ads…" /></Field>
        <Field label="Description"><Textarea value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Amount"><Input type="number" step="0.01" min={0} value={f.amount} onChange={(e) => set("amount", e.target.value)} /></Field>
          <Field label="Currency"><Select value={f.currency} onChange={(e) => set("currency", e.target.value)} options={[{ value: "INR", label: "₹ INR" }, { value: "USD", label: "$ USD" }]} /></Field>
          <Field label="Repeats"><Select value={f.recurrence} onChange={(e) => set("recurrence", e.target.value)} options={[{ value: "none", label: "Once" }, { value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }]} /></Field>
        </div>
        {f.currency === "USD" && (
          <Field label="Charged in ₹ (optional)" hint="What the bank actually debited — otherwise converted at the books' rate">
            <Input type="number" step="0.01" min={0} value={f.amountInr} onChange={(e) => set("amountInr", e.target.value)} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paid with"><Input value={f.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)} placeholder="HDFC card, UPI…" /></Field>
          <Field label="Invoice / reference"><Input value={f.reference} onChange={(e) => set("reference", e.target.value)} /></Field>
        </div>
        {f.category === "model_credits" && (
          <p className="text-xs text-muted">Provider credits are tracked as cash out but left out of profit — the usage they pay for is already counted as AI cost.</p>
        )}
      </div>
    </Drawer>
  );
}

type Live = {
  windowHours: number;
  totalCostInr: number;
  previousCostInr: number;
  spikes: number;
  hourly: { hour: string; costInr: number }[];
  byFeature: { feature: string; costInr: number }[];
  byModel: { provider: string; model: string; costInr: number }[];
  topUsers: { userId: string; name: string | null; plan: string; costInr: number; calls: number; monthlyAllowanceInr: number; shareOfMonthlyPct: number | null; spike: boolean }[];
};

/** What the platform is spending on models in the last 24 hours, who is spending it, and who looks abnormal. */
function LiveUsage() {
  const live = useResource<Live>("/console/finance/live");
  const d = live.data;
  if (live.loading && !d) return <Loading />;
  if (!d) return <ErrorNote error={live.error} />;
  const peak = Math.max(1, ...d.hourly.map((h) => h.costInr));
  const trend = d.previousCostInr > 0 ? ((d.totalCostInr - d.previousCostInr) / d.previousCostInr) * 100 : null;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Stat label={`Model cost, last ${d.windowHours} h`} value={inr(d.totalCostInr, 0)} hint={trend == null ? "no earlier data" : `${trend >= 0 ? "+" : ""}${trend.toFixed(0)}% vs the 24 h before`} accent="#ff6b6b" />
        <Stat label="Burn rate" value={`${inr(d.totalCostInr / d.windowHours, 1)}/h`} hint="average over the window" accent="#4dabf7" />
        <Stat label="Users flagged" value={String(d.spikes)} hint="a day's usage ≥ 25% of their monthly allowance" accent={d.spikes ? "#f59f00" : "#51cf66"} />
      </div>
      <Card>
        <div className="mb-3 flex items-center justify-between text-sm font-semibold">
          <span>Cost per hour</span>
          <Button size="sm" variant="ghost" onClick={() => void live.reload()}>Refresh</Button>
        </div>
        <div className="flex h-28 items-end gap-1" role="img" aria-label="Model cost per hour for the last 24 hours">
          {d.hourly.map((h) => (
            <div key={h.hour} title={`${new Date(h.hour).toLocaleTimeString([], { hour: "numeric" })}: ${inr(h.costInr, 1)}`} className="flex-1 rounded-t bg-search" style={{ height: `${Math.max(2, (h.costInr / peak) * 100)}%` }} />
          ))}
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="mb-2 text-sm font-semibold">By feature</div>
          <ul className="grid gap-1 text-sm">{d.byFeature.map((f) => <li key={f.feature} className="flex justify-between"><span className="capitalize">{f.feature}</span><span>{inr(f.costInr, 1)}</span></li>)}</ul>
        </Card>
        <Card>
          <div className="mb-2 text-sm font-semibold">By model</div>
          <ul className="grid gap-1 text-sm">{d.byModel.map((m) => <li key={`${m.provider}/${m.model}`} className="flex justify-between"><span>{m.provider} / {m.model}</span><span>{inr(m.costInr, 1)}</span></li>)}</ul>
        </Card>
      </div>
      <Card>
        <div className="mb-2 text-sm font-semibold">Top consumers</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted"><tr><th className="py-1 pr-3">User</th><th className="pr-3">Plan</th><th className="pr-3 text-right">Cost</th><th className="pr-3 text-right">Calls</th><th className="text-right">Of monthly allowance</th></tr></thead>
            <tbody>
              {d.topUsers.map((u) => (
                <tr key={u.userId} className="border-t border-border">
                  <td className="py-1.5 pr-3">{u.name ?? u.userId.slice(0, 8)}{u.spike && <Badge tone="amber" className="ml-2">spike</Badge>}</td>
                  <td className="pr-3 capitalize">{u.plan}</td>
                  <td className="pr-3 text-right">{inr(u.costInr, 1)}</td>
                  <td className="pr-3 text-right">{u.calls}</td>
                  <td className="text-right">{u.shareOfMonthlyPct == null ? "—" : `${u.shareOfMonthlyPct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
