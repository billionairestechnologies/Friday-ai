import { motion } from "framer-motion";
import { LifeBuoy, Megaphone, Send, TrendingUp } from "lucide-react";
import { Badge, Card, ErrorNote, Loading, PageHeader, Stat, formatMoney, formatNumber, statusTone, useResource } from "../ui";
import { useConsole } from "../access";

type OverviewData = {
  users: { total: number; new7d: number; active24h: number; plans: Record<string, number> };
  activity: { messages24h: number; messages7d: number };
  signups: { date: string; count: number }[];
  support: Record<string, number> | null;
  pipeline: { stageId: string; name: string; color: string; outcome: string; count: number; value: number }[];
  campaigns: { id: string; name: string; status: string; sent_count: number; total_recipients: number; sent_at: string | null }[];
  liveUpdates: number;
};

function SignupChart({ data }: { data: OverviewData["signups"] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex h-36 items-end gap-1.5">
      {data.map((d, i) => (
        <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end">
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: `${Math.max(3, (d.count / max) * 100)}%` }}
            transition={{ duration: 0.6, delay: i * 0.025, ease: [0.22, 1, 0.36, 1] }}
            className="rounded-md bg-gradient-to-t from-[#4f8cff]/50 to-[#a855f7]/80"
          />
          <div className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 rounded-md bg-elevated px-2 py-0.5 text-[11px] whitespace-nowrap text-foreground shadow group-hover:block">
            {d.count} · {new Date(d.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Overview() {
  const { data, error, loading } = useResource<OverviewData>("/console/overview");
  const me = useConsole((s) => s.me);
  const first = me?.staff.name?.split(/\s+/)[0];
  if (loading && !data) return <Loading />;
  const paid = data ? (data.users.plans.pro ?? 0) + (data.users.plans.premium ?? 0) : 0;
  const openPipeline = data?.pipeline.filter((p) => p.outcome === "open") ?? [];
  return (
    <>
      <PageHeader title={`Welcome back${first ? `, ${first}` : ""}`} description="How Friday is doing right now." />
      <ErrorNote error={error} />
      {data && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Users" value={formatNumber(data.users.total)} hint={`+${formatNumber(data.users.new7d)} this week`} accent="#4f8cff" />
            <Stat label="Active today" value={formatNumber(data.users.active24h)} hint={`${formatNumber(data.activity.messages24h)} messages in 24h`} accent="#34d399" />
            <Stat label="Paying" value={formatNumber(paid)} hint={`${data.users.plans.pro ?? 0} Pro · ${data.users.plans.premium ?? 0} Premium`} accent="#ffb547" />
            <Stat label="Open tickets" value={formatNumber((data.support?.open ?? 0) + (data.support?.pending ?? 0))} hint={`${data.support?.unassigned ?? 0} unassigned`} accent="#ff6b6b" />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <TrendingUp className="size-4 text-muted" /> Signups · last 14 days
                </div>
                <span className="text-xs text-muted">{formatNumber(data.activity.messages7d)} messages this week</span>
              </div>
              <SignupChart data={data.signups} />
            </Card>
            <Card>
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
                <LifeBuoy className="size-4 text-muted" /> Support queue
              </div>
              <div className="grid grid-cols-2 gap-3">
                {(["open", "pending", "resolved", "closed"] as const).map((s) => (
                  <div key={s} className="rounded-2xl bg-chip px-3 py-2.5">
                    <div className="text-[11px] font-medium text-subtle capitalize">{s}</div>
                    <div className="text-xl font-semibold tabular-nums">{data.support?.[s] ?? 0}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <div className="mb-4 text-sm font-semibold">Sales pipeline</div>
              {openPipeline.length === 0 ? (
                <p className="text-sm text-muted">No open deals yet.</p>
              ) : (
                <div className="space-y-3">
                  {data.pipeline.map((p) => {
                    const max = Math.max(1, ...data.pipeline.map((x) => x.count));
                    return (
                      <div key={p.stageId} className="flex items-center gap-3 text-sm">
                        <span className="w-24 shrink-0 text-muted">{p.name}</span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-chip">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${(p.count / max) * 100}%` }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="h-full rounded-full" style={{ background: p.color }} />
                        </div>
                        <span className="w-8 text-right tabular-nums">{p.count}</span>
                        <span className="hidden w-24 text-right text-xs text-subtle tabular-nums sm:block">{formatMoney(p.value)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
            <Card>
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
                <Send className="size-4 text-muted" /> Recent campaigns
              </div>
              {data.campaigns.length === 0 ? (
                <p className="text-sm text-muted">No campaigns yet.</p>
              ) : (
                <ul className="space-y-2.5">
                  {data.campaigns.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex items-center gap-2 border-t border-border pt-3 text-xs text-muted">
                <Megaphone className="size-3.5" /> {data.liveUpdates} product update{data.liveUpdates === 1 ? "" : "s"} live
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
