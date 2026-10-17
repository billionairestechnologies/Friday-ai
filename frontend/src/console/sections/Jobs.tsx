import { RotateCcw, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCan } from "../access";
import { Badge, Button, Card, EmptyState, ErrorNote, Loading, PageHeader, Stat, act, timeAgo, useResource } from "../ui";

/** Console → Jobs: the background queue (supabase 0066) — what's waiting, running, failed; retry or cancel. */
type Job = { id: string; kind: string; status: "queued" | "running" | "dead"; tenant: string | null; attempts: number; max_attempts: number; last_error: string | null; run_after: string; updated_at: string; created_at: string };
type Overview = { last24h: Record<string, number>; oldestQueuedSec: number; jobs: Job[] };
const LABEL: Record<string, string> = { credit_bulk_grant: "Bulk credit grant", notification_email: "Notification email" };
const TONE = { queued: "blue", running: "amber", dead: "red" } as const;

export default function Jobs() {
  const canManage = useCan("status.manage");
  const data = useResource<Overview>("/console/jobs");
  if (data.loading && !data.data) return <Loading label="Loading jobs" />;
  if (data.error && !data.data) return <ErrorNote error={data.error} />;
  const d = data.data!;
  const act_ = async (id: string, action: "retry" | "cancel") => {
    if (await act(() => api.post(`/console/jobs/${id}`, { action }), action === "retry" ? "Queued again" : "Cancelled")) void data.reload();
  };
  return (
    <>
      <PageHeader title="Jobs" description="Background work that survives restarts: retried with backoff, and set aside after repeated failures so someone can look." actions={<Button onClick={() => void data.reload()}>Refresh</Button>} />
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Done · 24 h" value={(d.last24h.succeeded ?? 0).toLocaleString()} />
          <Stat label="Waiting" value={(d.last24h.queued ?? 0).toLocaleString()} hint={d.oldestQueuedSec ? `oldest ${Math.round(d.oldestQueuedSec / 60)} min` : undefined} />
          <Stat label="Running" value={(d.last24h.running ?? 0).toLocaleString()} />
          <Stat label="Failed (needs a look)" value={(d.last24h.dead ?? 0).toLocaleString()} />
        </div>
        <Card>
          {d.jobs.length === 0 ? (
            <EmptyState icon={RotateCcw} title="Nothing waiting or failed" text="Every job has finished." />
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {d.jobs.map((j) => (
                <li key={j.id} className="flex flex-col gap-1 py-2.5 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{LABEL[j.kind] ?? j.kind}</span>
                      <Badge tone={TONE[j.status]}>{j.status === "dead" ? "failed" : j.status}</Badge>
                      <span className="text-xs text-muted">attempt {j.attempts}/{j.max_attempts} · {timeAgo(j.updated_at)}</span>
                    </div>
                    {j.last_error && <div className="mt-0.5 truncate text-xs text-danger" title={j.last_error}>{j.last_error}</div>}
                  </div>
                  {canManage && j.status === "dead" && (
                    <Button size="sm" onClick={() => void act_(j.id, "retry")}><RotateCcw className="size-3.5" /> Retry</Button>
                  )}
                  {canManage && j.status === "queued" && (
                    <Button size="sm" onClick={() => void act_(j.id, "cancel")}><X className="size-3.5" /> Cancel</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
