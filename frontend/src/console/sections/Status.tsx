import { useEffect, useState } from "react";
import { Activity, Bug, Check, ExternalLink, Plug, Plus, RefreshCw, Siren, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCan } from "../access";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Textarea, Toggle, act, formatNumber, timeAgo, useResource } from "../ui";

/**
 * Status (console): what /status shows the world, plus the tools behind it — open and update
 * incidents (each update appears on the public timeline), run the health checks on demand, and
 * see app crashes grouped by fingerprint. Problem reports from /status arrive in Support.
 */

type CStatus = "operational" | "degraded" | "outage" | "unknown";
type Component = { id: string; name: string; group: string; status: CStatus; latencyMs: number | null; uptime90: number | null };
type Incident = { id: string; title: string; status: string; impact: string; components: string[]; auto: boolean; startedAt: string; resolvedAt: string | null; updates: { id: string; status: string; body: string; createdAt: string }[] };
type CrashGroup = { fingerprint: string; platform: string; message: string; occurrences: number; users: number; first_seen: string; last_seen: string; sample_id: string };
type ProviderIssue = { id: string; provider: string; kind: string; sample: string; occurrences: number; first_seen: string; last_seen: string; resolved_at: string | null };
type Data = { status: { overall: CStatus; updatedAt: string | null; components: Component[] }; incidents: Incident[]; crashes: CrashGroup[]; providerIssues?: ProviderIssue[] };

const ISSUE_KIND: Record<string, { label: string; tone: string; hint: string }> = {
  quota: { label: "Out of credit", tone: "red", hint: "Top up or renew the provider plan." },
  gateway: { label: "Gateway / timeout", tone: "amber", hint: "Provider is down or slow; usually clears on its own." },
  rate_limit: { label: "Rate limited", tone: "amber", hint: "Too many requests; raise the provider limit or add another key." },
  auth: { label: "Key rejected", tone: "red", hint: "Replace the API key in Models & keys." },
  too_large: { label: "Request too large", tone: "neutral", hint: "A very long chat or paste; users were told to shorten it." },
  other: { label: "Error", tone: "neutral", hint: "See the sample below." },
};

const DOT: Record<CStatus, string> = { operational: "bg-emerald-500", degraded: "bg-amber-500", outage: "bg-red-500", unknown: "bg-zinc-400" };
const IMPACT_TONE: Record<string, string> = { none: "neutral", minor: "amber", major: "red", critical: "red" };
const STATUSES = [
  { value: "investigating", label: "Investigating" },
  { value: "identified", label: "Identified" },
  { value: "monitoring", label: "Monitoring" },
  { value: "resolved", label: "Resolved" },
];

export default function Status() {
  const data = useResource<Data>("/console/status");
  const [tab, setTab] = useState<"incidents" | "crashes" | "providers">("incidents");
  const [editing, setEditing] = useState<Incident | "new" | null>(null);
  const [crash, setCrash] = useState<CrashGroup | null>(null);
  const [checking, setChecking] = useState(false);
  const canManage = useCan("status.manage");
  const d = data.data;
  const reload = () => void data.reload();
  const active = d?.incidents.filter((i) => i.status !== "resolved") ?? [];
  const issues = d?.providerIssues ?? [];
  const openIssues = issues.filter((i) => !i.resolved_at);

  return (
    <>
      <PageHeader
        title="Status"
        description="Live health of every component and model, the incidents shown on the public status page, and crashes reported by the apps."
        actions={
          <>
            <a href="/status" target="_blank" rel="noreferrer"><Button><ExternalLink className="size-4" /> Public page</Button></a>
            {canManage && (
              <Button
                loading={checking}
                onClick={async () => {
                  setChecking(true);
                  if (await act(() => api.post("/console/status/checks"), "Health checks finished")) reload();
                  setChecking(false);
                }}
              >
                <RefreshCw className="size-4" /> Run checks
              </Button>
            )}
            {canManage && <Button variant="primary" onClick={() => setEditing("new")}><Plus className="size-4" /> New incident</Button>}
          </>
        }
      />
      <ErrorNote error={data.error} />
      {data.loading && !d ? (
        <Loading />
      ) : !d ? null : (
        <>
          <Card className="mb-6 flex items-center gap-3">
            <span className={cn("size-3 rounded-full", DOT[d.status.overall])} />
            <span className="font-semibold capitalize">{d.status.overall === "operational" ? "All systems operational" : d.status.overall}</span>
            {active.length > 0 && <Badge tone="red">{active.length} open incident{active.length > 1 ? "s" : ""}</Badge>}
            <span className="ml-auto text-xs text-muted">{d.status.updatedAt ? `Checked ${timeAgo(d.status.updatedAt)}` : "No checks yet — run them now"}</span>
          </Card>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {d.status.components.map((c) => (
              <Card key={c.id} className="flex items-center gap-3">
                <span className={cn("size-2.5 shrink-0 rounded-full", DOT[c.status])} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-muted">{c.group} · {c.uptime90 == null ? "no history" : `${c.uptime90}% (90d)`}</div>
                </div>
                {c.latencyMs != null && <span className="text-xs text-subtle">{c.latencyMs} ms</span>}
              </Card>
            ))}
          </div>
          <div className="mb-4">
            <Segmented value={tab} onChange={setTab} options={[{ value: "incidents", label: "Incidents", count: active.length }, { value: "providers", label: "Provider issues", count: openIssues.length }, { value: "crashes", label: "Crashes (14 days)", count: d.crashes.length }]} />
          </div>
          {tab === "incidents" ? (
            d.incidents.length === 0 ? (
              <EmptyState icon={Siren} title="No incidents" text="Incidents open automatically when a component fails two checks in a row, or post one yourself to keep users informed." />
            ) : (
              <div className="grid gap-3">
                {d.incidents.map((i) => (
                  <button key={i.id} type="button" onClick={() => setEditing(i)} className="text-left">
                    <Card className="transition-colors hover:bg-chip/30">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{i.title}</span>
                        <Badge tone={i.status === "resolved" ? "green" : "amber"}>{i.status}</Badge>
                        <Badge tone={IMPACT_TONE[i.impact] ?? "neutral"}>{i.impact}</Badge>
                        {i.auto && <Badge tone="purple">auto</Badge>}
                        <span className="ml-auto text-xs text-muted">{timeAgo(i.startedAt)}</span>
                      </div>
                      {i.updates[0] && <p className="mt-2 line-clamp-2 text-sm text-muted">{i.updates[0].body}</p>}
                    </Card>
                  </button>
                ))}
              </div>
            )
          ) : tab === "providers" ? (
            issues.length === 0 ? (
              <EmptyState icon={Plug} title="No provider issues" text="When a model, image or search provider fails (out of credit, gateway errors, rejected keys), it is logged here with the real reason — users only see a friendly message — and the team is emailed." />
            ) : (
              <div className="grid gap-3">
                {issues.map((i) => {
                  const kind = ISSUE_KIND[i.kind] ?? ISSUE_KIND.other!;
                  return (
                    <Card key={i.id} className={cn(i.resolved_at && "opacity-60")}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold capitalize">{i.provider}</span>
                        <Badge tone={kind.tone}>{kind.label}</Badge>
                        {i.resolved_at ? <Badge tone="green">resolved</Badge> : <Badge tone="amber">open</Badge>}
                        <span className="text-xs text-muted">{formatNumber(Number(i.occurrences))} failures · first {timeAgo(i.first_seen)} · last {timeAgo(i.last_seen)}</span>
                        {canManage && !i.resolved_at && (
                          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void act(() => api.post(`/console/status/provider-issues/${i.id}/resolve`, {}), "Marked resolved").then(reload)}>
                            <Check className="size-3.5" /> Mark resolved
                          </Button>
                        )}
                      </div>
                      <p className="mt-2 text-sm">{kind.hint}</p>
                      <p className="mt-2 rounded-lg bg-chip/40 px-3 py-2 font-mono text-xs break-words text-muted">{i.sample}</p>
                    </Card>
                  );
                })}
              </div>
            )
          ) : d.crashes.length === 0 ? (
            <EmptyState icon={Bug} title="No crashes reported" text="Crashes from the web app's error screen and uncaught errors show up here, grouped so one bug is one row." />
          ) : (
            <Card pad={false} className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b border-border text-left text-xs text-subtle">
                  <tr>
                    <th className="px-4 py-3 font-medium">Error</th>
                    <th className="px-4 py-3 font-medium">Platform</th>
                    <th className="px-4 py-3 text-right font-medium">Events</th>
                    <th className="px-4 py-3 text-right font-medium">Users</th>
                    <th className="px-4 py-3 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {d.crashes.map((c) => (
                    <tr key={c.fingerprint} onClick={() => setCrash(c)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-chip/30">
                      <td className="max-w-[420px] truncate px-4 py-2.5 font-mono text-xs">{c.message}</td>
                      <td className="px-4 py-2.5 capitalize">{c.platform}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(Number(c.occurrences))}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(Number(c.users))}</td>
                      <td className="px-4 py-2.5 text-muted">{timeAgo(c.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
      <IncidentDrawer incident={editing} components={d?.status.components ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      <CrashModal crash={crash} onClose={() => setCrash(null)} />
    </>
  );
}

function IncidentDrawer({ incident, components, onClose, onSaved }: { incident: Incident | "new" | null; components: Component[]; onClose: () => void; onSaved: () => void }) {
  const canManage = useCan("status.manage");
  const existing = incident && incident !== "new" ? incident : null;
  const [f, setF] = useState({ title: "", impact: "minor", status: "investigating", components: [] as string[], body: "", notify: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (incident === "new") setF({ title: "", impact: "minor", status: "investigating", components: [], body: "", notify: false });
    else if (incident) setF({ title: incident.title, impact: incident.impact, status: incident.status === "resolved" ? "resolved" : incident.status, components: incident.components, body: "", notify: false });
  }, [incident]);

  const save = async () => {
    setBusy(true);
    const ok = existing
      ? await act(() => api.post(`/console/status/incidents/${existing.id}/updates`, { status: f.status, body: f.body, title: f.title, impact: f.impact }), "Update posted to the status page")
      : await act(() => api.post("/console/status/incidents", f), "Incident is live on the status page");
    setBusy(false);
    if (ok) onSaved();
  };

  return (
    <Drawer
      open={Boolean(incident)}
      onClose={onClose}
      width={640}
      title={existing ? existing.title : "New incident"}
      subtitle={existing ? <span className="text-xs text-muted">Started {timeAgo(existing.startedAt)}{existing.auto ? " · opened by monitoring" : ""}</span> : <span className="text-xs text-muted">Shown on /status the moment you post it</span>}
      footer={
        canManage && (
          <>
            {existing && (
              <Button variant="danger" onClick={async () => { if (window.confirm("Delete this incident from the status page?") && (await act(() => api.delete(`/console/status/incidents/${existing.id}`), "Incident deleted"))) onSaved(); }}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="primary" loading={busy} disabled={f.title.trim().length < 3 || f.body.trim().length < 3} onClick={() => void save()}>
              {existing ? (f.status === "resolved" ? "Resolve" : "Post update") : "Publish incident"}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-3">
        <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Slow responses from some models" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={STATUSES} /></Field>
          <Field label="Impact">
            <Select value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })} options={[{ value: "none", label: "None (notice)" }, { value: "minor", label: "Minor" }, { value: "major", label: "Major" }, { value: "critical", label: "Critical" }]} />
          </Field>
        </div>
        {!existing && (
          <Field label="Affected components">
            <div className="flex flex-wrap gap-2">
              {components.map((c) => {
                const on = f.components.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setF({ ...f, components: on ? f.components.filter((x) => x !== c.id) : [...f.components, c.id] })}
                    className={cn("h-8 rounded-full border px-3 text-xs transition-colors", on ? "border-foreground bg-foreground text-background" : "border-border text-muted hover:text-foreground")}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        <Field label={existing ? "Update" : "Message"} hint="Plain words — this is public."><Textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className="min-h-[110px]" placeholder="We're seeing elevated errors from one provider and are routing around it." /></Field>
        {!existing && <Toggle checked={f.notify} onChange={(v) => setF({ ...f, notify: v })} label="Also email the team's alert list" />}
        {existing && existing.updates.length > 0 && (
          <div className="mt-2">
            <div className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">Timeline</div>
            <ol className="space-y-3 border-l border-border pl-4">
              {existing.updates.map((u) => (
                <li key={u.id} className="relative">
                  <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-border" />
                  <div className="text-xs font-semibold capitalize">{u.status} <span className="font-normal text-subtle">· {timeAgo(u.createdAt)}</span></div>
                  <p className="mt-0.5 text-sm whitespace-pre-wrap text-muted">{u.body}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function CrashModal({ crash, onClose }: { crash: CrashGroup | null; onClose: () => void }) {
  const [sample, setSample] = useState<{ stack: string | null; url: string | null; user_agent: string | null; release: string | null; created_at: string } | null>(null);
  useEffect(() => {
    setSample(null);
    if (crash) void api.get<{ crash: NonNullable<typeof sample> }>(`/console/status/crashes/${crash.sample_id}`).then((r) => setSample(r.crash)).catch(() => {});
  }, [crash]);
  return (
    <Modal open={Boolean(crash)} onClose={onClose} title={<span className="flex items-center gap-2"><Activity className="size-4" /> Crash details</span>}>
      {crash && (
        <div className="grid gap-3 text-sm">
          <p className="font-mono text-xs break-words">{crash.message}</p>
          <div className="flex flex-wrap gap-2 text-xs text-muted">
            <Badge>{crash.platform}</Badge>
            <span>{formatNumber(Number(crash.occurrences))} events · {formatNumber(Number(crash.users))} users</span>
            <span>first {timeAgo(crash.first_seen)}</span>
          </div>
          {!sample ? (
            <Loading />
          ) : (
            <>
              {sample.url && <div className="truncate text-xs text-muted">Page: {sample.url}</div>}
              {sample.user_agent && <div className="truncate text-xs text-muted">Browser: {sample.user_agent}</div>}
              {sample.release && <div className="text-xs text-muted">Release: {sample.release}</div>}
              <pre className="scroll-thin max-h-72 overflow-auto rounded-xl bg-chip p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{sample.stack || "No stack trace"}</pre>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
