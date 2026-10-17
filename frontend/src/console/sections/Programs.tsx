import { useState } from "react";
import { Briefcase, Building2, FileText, GraduationCap, Rocket, Settings2 } from "lucide-react";
import { api } from "@/lib/api";
import { useCan } from "../access";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Segmented, Select, Textarea, Toggle, act, formatDate, timeAgo, useResource } from "../ui";

/**
 * Console → Programmes: student / startup / company applications (supabase 0061,
 * services/console/programService.ts). A decision happens once; approval grants the programme's
 * benefit (or a per-application override for company deals) and is valid until re-verification.
 */

type Program = "student" | "startup" | "company";
type Settings = {
  id: Program;
  enabled: boolean;
  title: string;
  description: string;
  benefit_kind: "plan_grant" | "package" | "credits";
  plan: "pro" | "premium" | null;
  package_id: string | null;
  duration_days: number | null;
  credit_tokens: number | null;
  credit_days: number | null;
  valid_days: number;
};
type Application = {
  id: string;
  program: Program;
  status: "submitted" | "needs_info" | "approved" | "rejected" | "withdrawn" | "expired";
  details: Record<string, unknown>;
  evidence: Array<{ id: string; name: string; mime: string; size: number }>;
  info_request: string | null;
  decision_note: string | null;
  benefit: Record<string, unknown>;
  valid_until: string | null;
  created_at: string;
  user: { name: string; email: string | null } | null;
};
type Pkg = { id: string; name: string; target: string; active: boolean };

const ICON: Record<Program, typeof GraduationCap> = { student: GraduationCap, startup: Rocket, company: Building2 };
const TONE: Record<Application["status"], string> = { submitted: "blue", needs_info: "amber", approved: "green", rejected: "red", withdrawn: "neutral", expired: "neutral" };
const LABEL: Record<string, string> = {
  institution: "Institution", course: "Course", graduationYear: "Graduates", studentId: "Student ID", country: "Country",
  companyName: "Company", website: "Website", description: "What they build", teamSize: "Team size", stage: "Stage", contactRole: "Role", founded: "Founded",
  seatsNeeded: "Seats needed", useCase: "Use case", phone: "Phone",
};

function benefitText(s: Settings, packages: Pkg[]): string {
  if (s.benefit_kind === "plan_grant") return `${s.plan === "premium" ? "Premium" : "Pro"}${s.duration_days ? ` for ${s.duration_days} days` : ""}`;
  if (s.benefit_kind === "credits") return `${(s.credit_tokens ?? 0).toLocaleString()} bonus tokens${s.credit_days ? ` (${s.credit_days} days)` : ""}`;
  return s.package_id ? `Package: ${packages.find((p) => p.id === s.package_id)?.name ?? "—"}` : "Chosen per application";
}

export default function Programs() {
  const canReview = useCan("plans.review");
  const canManage = useCan("plans.manage");
  const [status, setStatus] = useState<"open" | Application["status"]>("open");
  const data = useResource<{ settings: Settings[]; applications: Application[] }>(`/console/programs${status === "open" || status === "submitted" ? "" : `?status=${status}`}`);
  const plans = useResource<{ packages: Pkg[] }>("/console/plans");
  const [open, setOpen] = useState<Application | null>(null);
  const [editing, setEditing] = useState<Settings | null>(null);
  const packages = plans.data?.packages ?? [];

  if (data.loading && !data.data) return <Loading label="Loading programmes" />;
  if (data.error && !data.data) return <ErrorNote error={data.error} />;
  const { settings, applications } = data.data!;
  const shown = status === "open" ? applications.filter((a) => a.status === "submitted" || a.status === "needs_info") : applications.filter((a) => a.status === status);

  return (
    <>
      <PageHeader title="Programmes" description="Student, startup and company applications. Approving grants the programme's benefit until its re-verification date." />
      <div className="space-y-5">
        <div className="grid gap-3 md:grid-cols-3">
          {settings.map((s) => {
            const Icon = ICON[s.id];
            const waiting = applications.filter((a) => a.program === s.id && a.status === "submitted").length;
            return (
              <Card key={s.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-chip">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{s.title}</div>
                    <div className="text-xs text-muted">{benefitText(s, packages)} · valid {s.valid_days} days</div>
                  </div>
                  <Badge tone={s.enabled ? "green" : "neutral"}>{s.enabled ? "open" : "closed"}</Badge>
                </div>
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>{waiting} waiting</span>
                  {canManage && (
                    <Button size="sm" onClick={() => setEditing(s)}>
                      <Settings2 className="size-3.5" /> Settings
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>

        <Card>
          <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="font-medium">Applications</div>
            <Segmented
              value={status}
              onChange={setStatus}
              options={[
                { value: "open", label: "To review" },
                { value: "approved", label: "Approved" },
                { value: "rejected", label: "Rejected" },
                { value: "expired", label: "Expired" },
                { value: "withdrawn", label: "Withdrawn" },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={Briefcase} title="Nothing here" text={status === "open" ? "No applications waiting. Open a programme in its settings to start receiving them." : undefined} />
          ) : (
            <ul className="divide-y divide-border/60">
              {shown.map((a) => {
                const Icon = ICON[a.program];
                const headline = String(a.details.companyName ?? a.details.institution ?? "");
                return (
                  <li key={a.id}>
                    <button type="button" onClick={() => setOpen(a)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-chip/40">
                      <Icon className="size-4 shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">
                          {a.user?.name ?? "Unknown"} <span className="text-xs font-normal text-muted">{a.user?.email}</span>
                        </div>
                        <div className="truncate text-xs text-muted">
                          {headline}
                          {a.evidence.length ? ` · ${a.evidence.length} file${a.evidence.length > 1 ? "s" : ""}` : ""} · {timeAgo(a.created_at)}
                        </div>
                      </div>
                      <Badge tone={TONE[a.status]}>{a.status.replace("_", " ")}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
      {open && <ApplicationDrawer app={open} settings={settings.find((s) => s.id === open.program)!} packages={packages} canReview={canReview} onClose={() => setOpen(null)} onDone={() => (setOpen(null), void data.reload())} />}
      {editing && <SettingsDrawer s={editing} packages={packages} onClose={() => setEditing(null)} onDone={() => (setEditing(null), void data.reload())} />}
    </>
  );
}

function ApplicationDrawer({ app, settings, packages, canReview, onClose, onDone }: { app: Application; settings: Settings; packages: Pkg[]; canReview: boolean; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [kind, setKind] = useState<"plan_grant" | "package" | "credits">(settings.benefit_kind);
  const [plan, setPlan] = useState<"pro" | "premium">(settings.plan ?? "pro");
  const [days, setDays] = useState(String(settings.duration_days ?? settings.credit_days ?? ""));
  const [tokens, setTokens] = useState(String(settings.credit_tokens ?? 10_000_000));
  const [packageId, setPackageId] = useState(settings.package_id ?? "");
  const open = app.status === "submitted" || app.status === "needs_info";
  const needsChoice = settings.benefit_kind === "package" && !settings.package_id;

  const override = () => {
    if (!custom && !needsChoice) return null;
    if (kind === "plan_grant") return { kind, plan, durationDays: days ? Number(days) : null };
    if (kind === "package") return { kind, packageId };
    return { kind, tokens: Number(tokens), days: days ? Number(days) : null };
  };
  const decide = async (decision: "approved" | "rejected" | "needs_info") => {
    setBusy(decision);
    const ok = await act(
      () => api.post(`/console/programs/applications/${app.id}/decide`, { decision, note, override: decision === "approved" ? override() : null }),
      decision === "approved" ? "Approved — benefits are active" : decision === "rejected" ? "Rejected" : "Asked for more information",
    );
    setBusy(null);
    if (ok) onDone();
  };
  const viewFile = async (fileId: string) => {
    try {
      const { url } = await api.get<{ url: string }>(`/console/programs/applications/${app.id}/evidence/${fileId}`);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      await act(() => Promise.reject(err));
    }
  };
  const failed = app.status === "approved" && typeof app.benefit?.error === "string";

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${settings.title} · ${app.user?.name ?? "Unknown"}`}
      subtitle={`${app.user?.email ?? ""} · applied ${formatDate(app.created_at)}`}
      width={620}
      footer={
        canReview && open ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="danger" loading={busy === "rejected"} onClick={() => void decide("rejected")}>
              Reject
            </Button>
            <Button loading={busy === "needs_info"} disabled={note.trim().length < 5} onClick={() => void decide("needs_info")}>
              Ask for more info
            </Button>
            <Button variant="primary" loading={busy === "approved"} disabled={needsChoice && kind === "package" && !packageId} onClick={() => void decide("approved")}>
              Approve
            </Button>
          </div>
        ) : failed && canReview ? (
          <div className="flex justify-end">
            <Button variant="primary" loading={busy === "retry"} onClick={async () => { setBusy("retry"); const ok = await act(() => api.post(`/console/programs/applications/${app.id}/retry`, {}), "Benefit applied"); setBusy(null); if (ok) onDone(); }}>
              Apply benefit again
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-5">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm md:grid-cols-2">
          {Object.entries(app.details).map(([k, v]) => (
            <div key={k} className={k === "description" || k === "useCase" ? "md:col-span-2" : undefined}>
              <dt className="text-xs text-muted">{LABEL[k] ?? k}</dt>
              <dd className="whitespace-pre-wrap break-words">
                {k === "website" && typeof v === "string" && /^https?:\/\//i.test(v) ? (
                  <a href={v} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline">
                    {v}
                  </a>
                ) : (
                  String(v)
                )}
              </dd>
            </div>
          ))}
        </dl>

        {app.evidence.length > 0 && (
          <Field label="Evidence" hint="Opens a private link that expires in 5 minutes.">
            <div className="flex flex-wrap gap-2">
              {app.evidence.map((e) => (
                <Button key={e.id} size="sm" onClick={() => void viewFile(e.id)}>
                  <FileText className="size-3.5" /> {e.name} <span className="text-muted">{Math.ceil(e.size / 1024)} KB</span>
                </Button>
              ))}
            </div>
          </Field>
        )}

        {app.info_request && <div className="rounded-xl bg-chip px-3 py-2 text-sm">We asked: {app.info_request}</div>}
        {app.decision_note && <div className="rounded-xl bg-chip px-3 py-2 text-sm">Decision note: {app.decision_note}</div>}
        {app.status === "approved" && (
          <div className="rounded-xl bg-chip px-3 py-2 text-sm">
            {failed ? <span className="text-danger">Approved, but the benefit failed: {String(app.benefit.error)}</span> : <>Benefit active{app.valid_until ? ` · valid until ${formatDate(app.valid_until)}` : ""}</>}
          </div>
        )}

        {canReview && open && (
          <>
            <Field label="Message to the applicant" hint="Required when asking for more information; optional otherwise.">
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Please upload your student ID card" />
            </Field>
            <Card className="bg-chip">
              <div className="text-sm">
                Approval grants: <span className="font-medium">{needsChoice ? "choose below" : benefitText(settings, packages)}</span>
              </div>
              {!needsChoice && (
                <div className="mt-2">
                  <Toggle checked={custom} onChange={setCustom} label="Grant something different for this application" />
                </div>
              )}
              {(custom || needsChoice) && (
                <div className="mt-3 space-y-3">
                  <Segmented value={kind} onChange={setKind} options={[{ value: "plan_grant", label: "Plan" }, { value: "credits", label: "Credits" }, { value: "package", label: "Package" }]} />
                  {kind === "plan_grant" && (
                    <div className="grid grid-cols-2 gap-3">
                      <Select value={plan} onChange={(e) => setPlan(e.target.value as "pro" | "premium")} options={[{ value: "pro", label: "Pro" }, { value: "premium", label: "Premium" }]} />
                      <Input aria-label="Days" type="number" min={1} placeholder="Days (empty = no end)" value={days} onChange={(e) => setDays(e.target.value)} />
                    </div>
                  )}
                  {kind === "credits" && (
                    <div className="grid grid-cols-2 gap-3">
                      <Input aria-label="Tokens" type="number" min={1} value={tokens} onChange={(e) => setTokens(e.target.value)} />
                      <Input aria-label="Valid days" type="number" min={1} placeholder="Days (empty = no expiry)" value={days} onChange={(e) => setDays(e.target.value)} />
                    </div>
                  )}
                  {kind === "package" && (
                    <Select value={packageId} onChange={(e) => setPackageId(e.target.value)} options={[{ value: "", label: "Choose a package…" }, ...packages.filter((p) => p.active && p.target === "individual").map((p) => ({ value: p.id, label: p.name }))]} />
                  )}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </Drawer>
  );
}

function SettingsDrawer({ s, packages, onClose, onDone }: { s: Settings; packages: Pkg[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ ...s, plan: s.plan ?? "pro", package_id: s.package_id ?? "", duration_days: s.duration_days ? String(s.duration_days) : "", credit_tokens: String(s.credit_tokens ?? ""), credit_days: s.credit_days ? String(s.credit_days) : "", valid_days: String(s.valid_days) });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const ok = await act(
      () =>
        api.post(`/console/programs/settings/${s.id}`, {
          enabled: f.enabled,
          title: f.title,
          description: f.description,
          benefit_kind: f.benefit_kind,
          plan: f.benefit_kind === "plan_grant" ? f.plan : null,
          package_id: f.benefit_kind === "package" && f.package_id ? f.package_id : null,
          duration_days: f.benefit_kind === "plan_grant" && f.duration_days ? Number(f.duration_days) : null,
          credit_tokens: f.benefit_kind === "credits" ? Number(f.credit_tokens) : null,
          credit_days: f.benefit_kind === "credits" && f.credit_days ? Number(f.credit_days) : null,
          valid_days: Number(f.valid_days),
        }),
      "Programme saved",
    );
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={`${s.title} settings`}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Open for applications" />
        <Field label="Title">
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Description" hint="Shown to people before they apply">
          <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Approval grants">
          <Segmented value={f.benefit_kind} onChange={(benefit_kind) => setF({ ...f, benefit_kind })} options={[{ value: "plan_grant", label: "A plan" }, { value: "credits", label: "Bonus credits" }, { value: "package", label: "A package" }]} />
        </Field>
        {f.benefit_kind === "plan_grant" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Plan">
              <Select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value as "pro" | "premium" })} options={[{ value: "pro", label: "Pro" }, { value: "premium", label: "Premium" }]} />
            </Field>
            <Field label="For (days)">
              <Input type="number" min={1} value={f.duration_days} onChange={(e) => setF({ ...f, duration_days: e.target.value })} />
            </Field>
          </div>
        )}
        {f.benefit_kind === "credits" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bonus tokens">
              <Input type="number" min={1} value={f.credit_tokens} onChange={(e) => setF({ ...f, credit_tokens: e.target.value })} />
            </Field>
            <Field label="Valid (days)">
              <Input type="number" min={1} value={f.credit_days} onChange={(e) => setF({ ...f, credit_days: e.target.value })} />
            </Field>
          </div>
        )}
        {f.benefit_kind === "package" && (
          <Field label="Package" hint={s.id === "company" ? "Optional — leave empty to choose per company" : undefined}>
            <Select value={f.package_id} onChange={(e) => setF({ ...f, package_id: e.target.value })} options={[{ value: "", label: "Choose per application" }, ...packages.filter((p) => p.active && p.target === "individual").map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
        )}
        <Field label="Membership valid for (days)" hint="Then the person re-verifies by applying again">
          <Input type="number" min={1} value={f.valid_days} onChange={(e) => setF({ ...f, valid_days: e.target.value })} />
        </Field>
      </div>
    </Drawer>
  );
}
