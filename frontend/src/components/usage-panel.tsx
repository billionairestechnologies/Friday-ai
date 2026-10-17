import { useEffect, useState } from "react";
import { Gift, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useQuota } from "@/lib/usage/quotaStore";
import {
  formatDay,
  formatResetAt,
  formatTokens,
  formatUsedOf,
  labelForEventType,
  mainBucket,
  percentUsed,
  type QuotaResponse,
  type UsageReport,
} from "@/lib/usage/quota";

const PLAN_LABEL: Record<string, string> = { free: "Free", pro: "Pro", premium: "Premium" };
const BAR_COLORS = ["bg-search", "bg-think", "bg-canvas", "bg-accent", "bg-muted"];

/**
 * Settings → Usage: the month's token balance exactly as the server's ledger has it, and where the
 * tokens went. Everything shown is read from GET /usage/quota — the client never computes or
 * enforces a limit, it only displays the server's numbers.
 */
export function UsagePanel({ onUpgrade }: { onUpgrade: () => void }) {
  const { data, error, load } = useQuota();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void load(15_000);
    // Live while open: requests in other tabs/devices settle too.
    const timer = setInterval(() => void load(), 30_000);
    const onFocus = () => void load(5_000);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (!data) return <p className="text-sm text-muted">{error ?? "Loading current usage…"}</p>;

  const { status } = data;
  const period = status.period;
  const bucket = mainBucket(status);
  const pct = percentUsed(bucket);
  const planName = status.isEnterprise ? "Enterprise" : (PLAN_LABEL[status.plan] ?? status.plan);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-chip px-2.5 py-1 text-xs font-medium text-foreground">{planName} plan</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void refresh()} className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted hover:bg-chip hover:text-foreground" aria-label="Refresh usage">
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} /> Refresh
          </button>
          {!status.isEnterprise && status.plan !== "premium" && (
            <button type="button" onClick={onUpgrade} className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90">
              Upgrade
            </button>
          )}
        </div>
      </div>

      {bucket && <BalanceCard data={data} pct={pct} />}

      <CreditsCard balance={period?.credits ?? 0} />

      {status.memberCap && (
        <div className="rounded-2xl border border-border bg-background p-4">
          <p className="text-sm font-medium text-foreground">Your cap inside the team pool</p>
          <p className="mt-1 text-sm text-muted">{formatUsedOf(status.memberCap.used, status.memberCap.limit)} · set by your organization admin</p>
          <Bar pct={percentUsed(status.memberCap)} />
        </div>
      )}

      {data.report && <Breakdown report={data.report} isEnterprise={status.isEnterprise} />}

      {period?.pendingPlan && (
        <p className="rounded-2xl border border-border bg-background p-4 text-sm text-muted">
          Your {PLAN_LABEL[period.pendingPlan] ?? period.pendingPlan} plan starts when the current one ends{period.renewsAt ? ` on ${formatDay(period.renewsAt)}` : ""}.
        </p>
      )}
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-chip" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width] duration-300", pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-canvas" : "bg-search")} style={{ width: `${pct}%` }} />
    </div>
  );
}

function BalanceCard({ data, pct }: { data: QuotaResponse; pct: number }) {
  const { status } = data;
  const period = status.period;
  const bucket = mainBucket(status)!;
  const remaining = period ? period.remaining : Math.max(0, bucket.limit - bucket.used);
  const credits = period?.credits ?? 0;
  const notice =
    period?.status === "suspended"
      ? { danger: true, text: "Usage on this account is paused. Please contact support." }
      : pct >= 100 && credits > 0
        ? { danger: false, text: `You've used this period's allowance — you're now using your bonus credits (${formatTokens(credits)} left).` }
      : pct >= 100
        ? { danger: true, text: `You've used all of this period's tokens. New requests are paused until your allowance renews on ${formatResetAt(bucket.resetAt)}${status.isEnterprise ? "" : ", or upgrade to continue now"}.` }
        : pct >= 95
          ? { danger: false, text: `You've used ${pct}% of this period's tokens.` }
          : pct >= 80
            ? { danger: false, text: `You've used ${pct}% of this period's tokens.` }
            : null;

  return (
    <div className="rounded-2xl border border-border bg-background p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{status.isEnterprise ? `Team pool${status.org ? ` · ${status.org.seatCount} seats` : ""}` : "This month"}</p>
        {period && (
          <p className="text-xs text-muted">
            {formatDay(period.start)} – {formatDay(period.end)}
          </p>
        )}
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground">
        {formatTokens(bucket.used)} <span className="text-base font-normal text-muted">/ {formatTokens(bucket.limit)} tokens</span>
      </p>
      <Bar pct={pct} />
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Used</dt>
          <dd className="font-medium text-foreground">{pct}%</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Remaining</dt>
          <dd className="font-medium text-foreground" title={`${remaining.toLocaleString()} tokens`}>{formatTokens(remaining)}</dd>
        </div>
        {period && period.reserved > 0 && (
          <div>
            <dt className="text-xs text-muted">In progress</dt>
            <dd className="font-medium text-foreground" title="Held for requests that are still running; released or counted when they finish.">{formatTokens(period.reserved)}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs text-muted">Renews</dt>
          <dd className="font-medium text-foreground">{formatDay(bucket.resetAt)}</dd>
        </div>
      </dl>
      {period && <SubscriptionLine period={period} />}
      {notice && <p className={cn("mt-3 rounded-xl px-3 py-2 text-sm", notice.danger ? "border border-border text-danger" : "bg-chip text-foreground")}>{notice.text}</p>}
    </div>
  );
}

type MyCredits = { balance: number; grants: Array<{ id: string; tokens: number; remaining: number; kind: string; expiresAt: string | null; grantedAt: string }> };

/** Bonus credits: on top of the monthly allowance, used after it, soonest-expiring first (GET /usage/credits). */
function CreditsCard({ balance }: { balance: number }) {
  const [mine, setMine] = useState<MyCredits | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<MyCredits>("/usage/credits")
      .then((r) => live && setMine(r))
      .catch(() => live && setMine(null));
    return () => {
      live = false;
    };
  }, [balance]);
  const grants = mine?.grants ?? [];
  if (balance <= 0 && grants.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border bg-background p-4">
      <div className="flex items-center gap-2">
        <Gift className="size-4 text-search" />
        <p className="text-sm font-medium text-foreground">Bonus credits</p>
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground">
        {formatTokens(Math.max(balance, mine?.balance ?? 0))} <span className="text-base font-normal text-muted">tokens</span>
      </p>
      <p className="mt-1 text-xs text-muted">Used after your monthly tokens run out, the soonest-expiring first. They carry over from month to month.</p>
      {grants.length > 0 && (
        <ul className="mt-3 divide-y divide-border text-sm">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 py-2">
              <span className="text-foreground">
                {formatTokens(g.remaining)} <span className="text-muted">of {formatTokens(g.tokens)}</span>
              </span>
              <span className="text-xs text-muted">{g.expiresAt ? `Expires ${formatDay(g.expiresAt)}` : "No expiry"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SubscriptionLine({ period }: { period: NonNullable<QuotaResponse["status"]["period"]> }) {
  const text =
    period.subscription === "expired"
      ? "Your paid plan has ended — you're on Free now."
      : period.subscription === "active" && period.renewsAt
        ? `Plan paid through ${formatDay(period.renewsAt)}. Your tokens renew every month on the day your plan started.`
        : period.subscription === "free"
          ? "Free plan — your tokens renew every month."
          : null;
  return text ? <p className="mt-3 text-xs text-muted">{text}</p> : null;
}

function Breakdown({ report, isEnterprise }: { report: UsageReport; isEnterprise: boolean }) {
  const [tab, setTab] = useState<"models" | "features" | "activity">("models");
  const total = Math.max(1, report.totals.billable);
  if (report.totals.calls === 0 && report.adjustments.length === 0) {
    return <p className="rounded-2xl border border-border bg-background p-4 text-sm text-muted">No usage yet this period.</p>;
  }
  return (
    <div className="rounded-2xl border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{isEnterprise ? "Your usage in the pool" : "Where your tokens went"}</p>
        <div className="flex gap-1 rounded-full bg-chip p-0.5 text-xs">
          {(["models", "features", "activity"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={cn("rounded-full px-2.5 py-1 capitalize", tab === t ? "bg-background font-medium text-foreground" : "text-muted hover:text-foreground")}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div><dt className="text-muted">Input</dt><dd className="text-foreground">{formatTokens(report.totals.input)}</dd></div>
        <div><dt className="text-muted">Output</dt><dd className="text-foreground">{formatTokens(report.totals.output)}</dd></div>
        <div><dt className="text-muted" title="Re-read from the model's prompt cache — counted at 10%">From cache</dt><dd className="text-foreground">{formatTokens(report.totals.cached)}</dd></div>
        <div><dt className="text-muted">Requests</dt><dd className="text-foreground">{report.totals.calls.toLocaleString()}</dd></div>
      </dl>

      {tab === "models" && (
        <ul className="mt-3 space-y-2">
          {report.byModel.map((m, i) => (
            <li key={`${m.model}-${i}`}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-foreground">{m.model} <span className="text-xs text-muted">· {m.vendor}</span></span>
                <span className="shrink-0 text-foreground">{formatTokens(m.billable)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-chip">
                <div className={cn("h-full rounded-full", BAR_COLORS[i % BAR_COLORS.length])} style={{ width: `${Math.min(100, (m.billable / total) * 100)}%` }} />
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {formatTokens(m.input)} in · {formatTokens(m.output)} out{m.reasoning ? ` (${formatTokens(m.reasoning)} thinking)` : ""} · {m.calls} request{m.calls === 1 ? "" : "s"}
              </p>
            </li>
          ))}
        </ul>
      )}

      {tab === "features" && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {report.byFeature.map((f, i) => (
            <li key={f.feature} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-foreground"><span className={cn("size-2 rounded-full", BAR_COLORS[i % BAR_COLORS.length])} />{labelForEventType(f.feature)}</span>
              <span className="text-muted">{formatTokens(f.billable)} · {Math.round((f.billable / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      )}

      {tab === "activity" && (
        <ul className="mt-3 divide-y divide-border text-xs">
          {report.recent.map((r, i) => (
            <li key={`${r.at}-${i}`} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate text-foreground">
                {new Date(r.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {r.model} · {labelForEventType(r.feature)}
                {r.status !== "ok" && <span className="ml-1 text-muted">({r.status})</span>}
              </span>
              <span className="shrink-0 text-muted">
                {formatTokens(r.billable)}
                {r.source === "estimated" && <span title="The model didn't report its usage; this is an estimate" className="ml-1">≈</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {report.totals.estimatedBillable > 0 && (
        <p className="mt-3 text-xs text-muted">≈ {formatTokens(report.totals.estimatedBillable)} of these tokens are estimates — a few models don't report their exact usage.</p>
      )}
      {report.adjustments.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs font-medium text-foreground">Adjustments</p>
          <ul className="mt-1 space-y-1 text-xs text-muted">
            {report.adjustments.map((a, i) => (
              <li key={`${a.at}-${i}`} className="flex justify-between gap-3">
                <span>{formatDay(a.at)} · {a.reason || a.kind}</span>
                <span className="text-foreground">{a.tokens < 0 ? `+${formatTokens(-a.tokens)} added` : `−${formatTokens(a.tokens)}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-xs text-subtle">Cached prompt tokens count at 10%; output includes thinking. Every model draws on the same monthly tokens.</p>
    </div>
  );
}
