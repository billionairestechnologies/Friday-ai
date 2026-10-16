import { useEffect, useState } from "react";
import { BadgeCheck, Copy, Crown, Globe, GraduationCap, Package, Pencil, Plus, ShieldOff, Ticket, Trash2, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { useCan } from "../access";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Segmented, Select, Textarea, Toggle, act, formatDate, formatMoney, formatNumber, fromLocalInput, statusTone, timeAgo, toLocalInput, toast, useResource } from "../ui";

type Pkg = {
  id: string;
  name: string;
  description: string;
  target: "individual" | "organization";
  plan: string;
  monthly_token_cap: number | null;
  seats: number | null;
  pooled_monthly_tokens: number | null;
  duration_days: number | null;
  price_paise: number;
  currency: string;
  features: string[];
  active: boolean;
  public?: boolean;
  entitlements?: Record<string, boolean | number>;
  badge?: string | null;
  highlight?: boolean;
  sort_order?: number;
};
type EntitlementDef = { key: string; label: string; type: "boolean" | "number"; hint: string };
type CatalogPlan = {
  id: "free" | "pro" | "premium" | "enterprise";
  name: string;
  tagline: string;
  monthlyPricePaise: number;
  annualDiscountPercent: number;
  minSeats: number | null;
  features: string[];
  badge: string | null;
  highlight: boolean;
  /** monthly = tokens per subscription month; tokensPerSeat = enterprise pool per seat. */
  limits: { monthly: number | null; tokensPerSeat: number | null };
  entitlements: Record<string, boolean | number>;
  active: boolean;
  sortOrder: number;
};
type Offer = {
  id: string;
  code: string;
  name: string;
  description: string;
  kind: "plan_grant" | "package" | "discount";
  plan: string | null;
  package_id: string | null;
  duration_days: number | null;
  discount_percent: number | null;
  applies_to_plans: string[];
  eligibility: "anyone" | "new_users" | "email_domain" | "student";
  email_domains: string[];
  requires_approval: boolean;
  max_redemptions: number | null;
  redemption_count: number;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
};
type Grant = {
  id: string;
  user: { name: string; email: string | null } | null;
  organization: string | null;
  source: string;
  plan: string;
  monthly_token_cap: number | null;
  seats: number | null;
  ends_at: string | null;
  status: string;
  note: string;
  grantedBy: string | null;
  created_at: string;
};
type Redemption = { id: string; status: string; proof: string; created_at: string; user: { name: string; email: string | null } | null; offers: { code: string; name: string; eligibility: string } | null };
type Org = { id: string; name: string; plan: string; seat_count: number };
type PlansData = { catalog?: CatalogPlan[]; entitlementDefs?: EntitlementDef[]; packages: Pkg[]; offers: Offer[]; grants: Grant[]; pending: Redemption[]; organizations: Org[] };

type Tab = "plans" | "profit" | "offers" | "packages" | "review" | "grants";

export default function Plans() {
  const data = useResource<PlansData>("/console/plans");
  const [tab, setTab] = useState<Tab>("plans");
  const [editingPlan, setEditingPlan] = useState<CatalogPlan | null>(null);
  const [offer, setOffer] = useState<Offer | "new" | null>(null);
  const [pkg, setPkg] = useState<Pkg | "new" | null>(null);
  const [granting, setGranting] = useState(false);
  const canManage = useCan("plans.manage");
  const d = data.data;
  const reload = () => void data.reload();

  return (
    <>
      <PageHeader
        title="Plans & offers"
        description="Build custom packages for enterprises and power users, create offer codes and student passes, and grant or revoke access — every change is recorded with who did it and until when."
        actions={
          canManage && (
            <>
              <Button onClick={() => setGranting(true)}><UserPlus className="size-4" /> Grant access</Button>
              {tab === "plans" || tab === "profit" ? null : tab === "packages" ? (
                <Button variant="primary" onClick={() => setPkg("new")}><Plus className="size-4" /> New package</Button>
              ) : (
                <Button variant="primary" onClick={() => setOffer("new")}><Plus className="size-4" /> New offer</Button>
              )}
            </>
          )
        }
      />
      <ErrorNote error={data.error} />
      <div className="mb-4">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "plans", label: "Plans" },
            { value: "profit", label: "Profit" },
            { value: "offers", label: "Offers & codes", count: d?.offers.length },
            { value: "packages", label: "Packages", count: d?.packages.length },
            { value: "review", label: "Review queue", count: d?.pending.length },
            { value: "grants", label: "Access grants", count: d?.grants.filter((g) => g.status === "active").length },
          ]}
        />
      </div>
      {data.loading && !d ? (
        <Loading />
      ) : !d ? null : tab === "plans" ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(d.catalog ?? []).map((plan) => (
            <Card key={plan.id} className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                {plan.id === "enterprise" ? <Crown className="size-4 text-muted" /> : null}
                <span className="font-semibold">{plan.name}</span>
                {plan.badge && <Badge tone="purple">{plan.badge}</Badge>}
                {plan.highlight && <Badge tone="blue">featured</Badge>}
                {!plan.active && <Badge>hidden</Badge>}
                {canManage && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditingPlan(plan)}><Pencil className="size-3.5" /> Edit</Button>
                )}
              </div>
              <div className="font-[var(--font-heading)] text-2xl font-semibold">
                {plan.monthlyPricePaise ? formatMoney(plan.monthlyPricePaise / 100, "INR") : "Free"}
                <span className="text-sm font-normal text-muted">{plan.monthlyPricePaise ? (plan.id === "enterprise" ? " / seat / mo" : " / mo") : ""}</span>
              </div>
              <div className="text-xs text-muted">{plan.tagline}</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-chip/60 p-3 text-xs">
                {plan.id === "enterprise" ? (
                  <span className="col-span-2">{formatNumber(plan.limits.tokensPerSeat ?? 0)} pooled tokens / seat / month · min {plan.minSeats} seats</span>
                ) : (
                  <>
                    <span className="text-muted">Monthly tokens</span><span>{plan.limits.monthly ? formatNumber(plan.limits.monthly) : "—"}</span>
                    <span className="col-span-2 text-subtle">No 5-hour, daily or weekly caps</span>
                  </>
                )}
              </div>
              <ul className="space-y-1 text-xs text-muted">
                {(d.entitlementDefs ?? []).map((def) => (
                  <li key={def.key} className="flex justify-between gap-2">
                    <span>{def.label}</span>
                    <span className="text-foreground">{formatEntitlement(def, plan.entitlements[def.key])}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {!d.catalog?.length && <EmptyState icon={Crown} title="Plan catalog unavailable" text="Apply migration 0033 to edit plans from here." />}
        </div>
      ) : tab === "profit" ? (
        <ProfitPanel canManage={canManage} onApplied={reload} />
      ) : tab === "offers" ? (
        d.offers.length === 0 ? (
          <EmptyState icon={Ticket} title="No offers yet" text="Create a promo code, a partner deal, or a student pass (verified by college email or reviewed by your team)." action={canManage && <Button variant="primary" onClick={() => setOffer("new")}>Create an offer</Button>} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {d.offers.map((o) => (
              <Card key={o.id} className="flex flex-col gap-3 transition-colors hover:bg-chip/30">
                <div className="flex items-start gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-chip">{o.eligibility === "student" ? <GraduationCap className="size-4" /> : <Ticket className="size-4" />}</span>
                  <button type="button" onClick={() => setOffer(o)} className="min-w-0 flex-1 text-left">
                    <div className="truncate font-semibold">{o.name}</div>
                    <div className="text-xs text-muted">{describeOffer(o, d.packages)}</div>
                  </button>
                  <Badge tone={o.active ? "green" : "neutral"}>{o.active ? "active" : "off"}</Badge>
                </div>
                <button
                  type="button"
                  onClick={() => { void navigator.clipboard.writeText(o.code); toast.ok(`Copied ${o.code}`); }}
                  className="flex items-center justify-between rounded-xl border border-dashed border-border px-3 py-2 font-mono text-sm tracking-wider hover:bg-chip"
                >
                  {o.code} <Copy className="size-3.5 text-subtle" />
                </button>
                <div className="flex items-center gap-3 text-xs text-subtle">
                  <span>{formatNumber(o.redemption_count)}{o.max_redemptions ? ` / ${formatNumber(o.max_redemptions)}` : ""} used</span>
                  {o.requires_approval && <Badge tone="amber">reviewed</Badge>}
                  <span className="ml-auto">{o.expires_at ? `ends ${formatDate(o.expires_at)}` : "no end date"}</span>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : tab === "packages" ? (
        d.packages.length === 0 ? (
          <EmptyState icon={Package} title="No packages yet" text="A package bundles a plan, token limits, seats, duration and price — build one per enterprise deal or special customer." action={canManage && <Button variant="primary" onClick={() => setPkg("new")}>Build a package</Button>} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {d.packages.map((p) => (
              <button key={p.id} type="button" onClick={() => setPkg(p)} className="text-left">
                <Card className="h-full transition-colors hover:bg-chip/30">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{p.name}</span>
                    <Badge tone={p.target === "organization" ? "purple" : "blue"}>{p.target === "organization" ? "enterprise" : "individual"}</Badge>
                    {p.public && <Badge tone="green"><Globe className="mr-1 inline size-3" />on Plans page</Badge>}
                    {!p.active && <Badge>archived</Badge>}
                  </div>
                  <div className="mt-2 font-[var(--font-heading)] text-2xl font-semibold">
                    {p.price_paise ? formatMoney(p.price_paise / 100, p.currency) : "Free"}
                    <span className="text-sm font-normal text-muted">{p.duration_days ? ` / ${p.duration_days} days` : " · no end date"}</span>
                  </div>
                  <ul className="mt-3 space-y-1 text-sm text-muted">
                    <li>Plan: <span className="text-foreground capitalize">{p.plan}</span></li>
                    {p.monthly_token_cap && <li>{formatNumber(p.monthly_token_cap)} tokens / month</li>}
                    {p.seats && <li>{formatNumber(p.seats)} seats</li>}
                    {p.pooled_monthly_tokens && <li>{formatNumber(p.pooled_monthly_tokens)} pooled tokens / month</li>}
                    {p.features.slice(0, 4).map((f) => <li key={f}>• {f}</li>)}
                  </ul>
                </Card>
              </button>
            ))}
          </div>
        )
      ) : tab === "review" ? (
        d.pending.length === 0 ? (
          <EmptyState icon={BadgeCheck} title="Nothing to review" text="Student passes and other reviewed offers wait here for a teammate to approve." />
        ) : (
          <div className="grid gap-3">
            {d.pending.map((r) => <ReviewRow key={r.id} r={r} onDone={reload} />)}
          </div>
        )
      ) : d.grants.length === 0 ? (
        <EmptyState icon={UserPlus} title="No grants yet" text="Grant a person or an enterprise access for a period — it switches back automatically when it ends." />
      ) : (
        <Card pad={false} className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-border text-left text-xs text-subtle">
              <tr>
                <th className="px-4 py-3 font-medium">Who</th>
                <th className="px-4 py-3 font-medium">Access</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Until</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {d.grants.map((g) => (
                <tr key={g.id} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{g.organization ?? g.user?.name ?? "—"}</div>
                    <div className="text-xs text-muted">{g.organization ? "Organization" : g.user?.email}</div>
                  </td>
                  <td className="px-4 py-2.5 capitalize">{g.plan}{g.monthly_token_cap ? ` · ${formatNumber(g.monthly_token_cap)} tok` : ""}{g.seats ? ` · ${g.seats} seats` : ""}</td>
                  <td className="px-4 py-2.5 text-muted">{g.source}{g.grantedBy ? ` · by ${g.grantedBy}` : ""}{g.note ? <div className="truncate text-[11px] text-subtle">{g.note}</div> : null}</td>
                  <td className="px-4 py-2.5 text-muted">{g.ends_at ? formatDate(g.ends_at) : "No end"}</td>
                  <td className="px-4 py-2.5"><Badge tone={statusTone(g.status)}>{g.status}</Badge></td>
                  <td className="px-4 py-2.5 text-right">
                    {g.status === "active" && canManage && (
                      <Button size="sm" variant="ghost" onClick={async () => { if (window.confirm("Revoke this access now?") && (await act(() => api.post(`/console/plans/grants/${g.id}/revoke`), "Access revoked"))) reload(); }}>
                        <ShieldOff className="size-3.5" /> Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <OfferEditor offer={offer} packages={d?.packages ?? []} onClose={() => setOffer(null)} onSaved={() => { setOffer(null); reload(); }} />
      <PackageEditor pkg={pkg} defs={d?.entitlementDefs ?? []} catalog={d?.catalog ?? []} onClose={() => setPkg(null)} onSaved={() => { setPkg(null); reload(); }} />
      <CatalogEditor plan={editingPlan} defs={d?.entitlementDefs ?? []} onClose={() => setEditingPlan(null)} onSaved={() => { setEditingPlan(null); reload(); }} />
      <GrantDrawer open={granting} packages={d?.packages ?? []} orgs={d?.organizations ?? []} onClose={() => setGranting(false)} onSaved={() => { setGranting(false); setTab("grants"); reload(); }} />
    </>
  );
}

function describeOffer(o: Offer, packages: Pkg[]): string {
  const what =
    o.kind === "discount"
      ? `${o.discount_percent}% off ${o.applies_to_plans.join("/")}`
      : o.kind === "package"
        ? `Package: ${packages.find((p) => p.id === o.package_id)?.name ?? "—"}`
        : `${o.plan?.[0]?.toUpperCase()}${o.plan?.slice(1)} for ${o.duration_days ? `${o.duration_days} days` : "no end date"}`;
  const who = { anyone: "anyone", new_users: "new users", email_domain: `@${o.email_domains.join(", @")}`, student: "students" }[o.eligibility];
  return `${what} · ${who}`;
}

function ReviewRow({ r, onDone }: { r: Redemption; onDone: () => void }) {
  const [note, setNote] = useState("");
  const canReview = useCan("plans.review");
  const decide = async (approve: boolean) => {
    if (await act(() => api.post(`/console/plans/redemptions/${r.id}/review`, { approve, note }), approve ? "Approved — they've been emailed" : "Rejected")) onDone();
  };
  return (
    <Card className="grid gap-3 md:grid-cols-[1fr_320px]">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold">{r.user?.name ?? "Unknown"}</span>
          <span className="text-xs text-muted">{r.user?.email}</span>
          <span className="ml-auto text-xs text-subtle">{timeAgo(r.created_at)}</span>
        </div>
        <div className="mt-1 text-xs text-muted">
          {r.offers?.eligibility === "student" && <GraduationCap className="mr-1 inline size-3.5" />}
          {r.offers?.name} · <span className="font-mono">{r.offers?.code}</span>
        </div>
        <div className="mt-3 rounded-xl bg-chip px-3 py-2 text-sm whitespace-pre-wrap">{r.proof || "No details provided."}</div>
      </div>
      {canReview && (
        <div className="flex flex-col gap-2">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note to the user" className="min-h-[72px]" />
          <div className="flex gap-2">
            <Button variant="danger" className="flex-1" onClick={() => void decide(false)}>Reject</Button>
            <Button variant="primary" className="flex-1" onClick={() => void decide(true)}>Approve</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function OfferEditor({ offer, packages, onClose, onSaved }: { offer: Offer | "new" | null; packages: Pkg[]; onClose: () => void; onSaved: () => void }) {
  const blank = {
    code: "", name: "", description: "", kind: "plan_grant" as Offer["kind"], plan: "pro", packageId: "", durationDays: "30", discountPercent: "20",
    appliesToPlans: ["pro", "premium"], eligibility: "anyone" as Offer["eligibility"], emailDomains: "", requiresApproval: false, maxRedemptions: "", startsAt: "", expiresAt: "", active: true,
  };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const existing = offer && offer !== "new" ? offer : null;
  useEffect(() => {
    if (offer === "new") setF(blank);
    else if (offer)
      setF({
        code: offer.code, name: offer.name, description: offer.description, kind: offer.kind, plan: offer.plan ?? "pro", packageId: offer.package_id ?? "", durationDays: offer.duration_days ? String(offer.duration_days) : "",
        discountPercent: String(offer.discount_percent ?? 20), appliesToPlans: offer.applies_to_plans, eligibility: offer.eligibility, emailDomains: offer.email_domains.join(", "), requiresApproval: offer.requires_approval,
        maxRedemptions: offer.max_redemptions ? String(offer.max_redemptions) : "", startsAt: toLocalInput(offer.starts_at), expiresAt: toLocalInput(offer.expires_at), active: offer.active,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer]);
  const studentPreset = () => setF({ ...f, name: f.name || "Student pass", kind: "plan_grant", plan: "pro", durationDays: "180", eligibility: "student", emailDomains: f.emailDomains || "edu, ac.in, edu.in", requiresApproval: false });
  const save = async () => {
    setBusy(true);
    const ok = await act(
      () =>
        api.post("/console/plans/offers", {
          ...(existing ? { id: existing.id } : {}),
          code: f.code || undefined,
          name: f.name,
          description: f.description,
          kind: f.kind,
          plan: f.kind === "plan_grant" ? f.plan : null,
          packageId: f.kind === "package" ? f.packageId || null : null,
          durationDays: f.kind === "plan_grant" && f.durationDays ? Number(f.durationDays) : null,
          discountPercent: f.kind === "discount" ? Number(f.discountPercent) : null,
          appliesToPlans: f.appliesToPlans,
          eligibility: f.eligibility,
          emailDomains: f.emailDomains.split(",").map((s) => s.trim()).filter(Boolean),
          requiresApproval: f.requiresApproval,
          maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : null,
          startsAt: fromLocalInput(f.startsAt),
          expiresAt: fromLocalInput(f.expiresAt),
          active: f.active,
        }),
      existing ? "Offer saved" : "Offer created",
    );
    setBusy(false);
    if (ok) onSaved();
  };
  return (
    <Drawer
      open={Boolean(offer)}
      onClose={onClose}
      title={existing ? existing.name : "New offer"}
      subtitle={existing && <span className="font-mono">{existing.code}</span>}
      footer={
        <>
          {existing && (
            <Button variant="danger" onClick={async () => { if (window.confirm("Delete (or archive, if used) this offer?") && (await act(() => api.delete(`/console/plans/offers/${existing.id}`), "Removed"))) onSaved(); }}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={() => void save()}>{existing ? "Save" : "Create offer"}</Button>
        </>
      }
    >
      <div className="grid gap-3">
        {!existing && (
          <button type="button" onClick={studentPreset} className="flex items-center gap-3 rounded-2xl border border-dashed border-border p-3 text-left hover:bg-chip">
            <GraduationCap className="size-5 text-muted" />
            <span className="text-sm"><span className="font-semibold">Student pass preset</span><br /><span className="text-xs text-muted">Pro for 180 days; college emails get it instantly, anyone else is reviewed with proof.</span></span>
          </button>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Diwali 30% off" /></Field>
          <Field label="Code" hint="Empty = generated"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} className="font-mono" placeholder="DIWALI30" /></Field>
        </div>
        <Field label="Description" hint="Shown to the team"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="What it gives">
          <Segmented value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={[{ value: "plan_grant", label: "Plan access" }, { value: "package", label: "A package" }, { value: "discount", label: "Checkout discount" }]} />
        </Field>
        {f.kind === "plan_grant" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Plan"><Select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} options={[{ value: "pro", label: "Pro" }, { value: "premium", label: "Premium" }]} /></Field>
            <Field label="For (days)" hint="Empty = no end date"><Input type="number" min={1} value={f.durationDays} onChange={(e) => setF({ ...f, durationDays: e.target.value })} /></Field>
          </div>
        )}
        {f.kind === "package" && (
          <Field label="Package"><Select value={f.packageId} onChange={(e) => setF({ ...f, packageId: e.target.value })} options={[{ value: "", label: "Choose…" }, ...packages.filter((p) => p.target === "individual" && p.active).map((p) => ({ value: p.id, label: p.name }))]} /></Field>
        )}
        {f.kind === "discount" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Discount %"><Input type="number" min={1} max={100} value={f.discountPercent} onChange={(e) => setF({ ...f, discountPercent: e.target.value })} /></Field>
            <Field label="Applies to">
              <div className="flex h-10 items-center gap-3">
                {["pro", "premium", "enterprise", "packages"].map((p) => (
                  <label key={p} className="flex items-center gap-1.5 text-sm capitalize">
                    <input type="checkbox" checked={f.appliesToPlans.includes(p)} onChange={(e) => setF({ ...f, appliesToPlans: e.target.checked ? [...f.appliesToPlans, p] : f.appliesToPlans.filter((x) => x !== p) })} /> {p}
                  </label>
                ))}
              </div>
            </Field>
          </div>
        )}
        <Field label="Who can use it">
          <Select
            value={f.eligibility}
            onChange={(e) => setF({ ...f, eligibility: e.target.value as Offer["eligibility"] })}
            options={[{ value: "anyone", label: "Anyone with the code" }, { value: "new_users", label: "New accounts only (14 days)" }, { value: "email_domain", label: "Specific email domains (partners, companies)" }, { value: "student", label: "Students" }]}
          />
        </Field>
        {(f.eligibility === "email_domain" || f.eligibility === "student") && (
          <Field label="Email domains" hint={f.eligibility === "student" ? "Students with these email domains qualify instantly; everyone else goes to your review queue with proof." : "Comma separated, e.g. acme.com, partner.io"}>
            <Input value={f.emailDomains} onChange={(e) => setF({ ...f, emailDomains: e.target.value })} placeholder="edu, ac.in" />
          </Field>
        )}
        <Toggle checked={f.requiresApproval} onChange={(v) => setF({ ...f, requiresApproval: v })} label="A teammate must approve every request" />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Max uses" hint="Empty = unlimited"><Input type="number" min={1} value={f.maxRedemptions} onChange={(e) => setF({ ...f, maxRedemptions: e.target.value })} /></Field>
          <Field label="Starts"><Input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field>
          <Field label="Ends"><Input type="datetime-local" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
        </div>
        <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Active" />
      </div>
    </Drawer>
  );
}

function PackageEditor({ pkg, defs, catalog, onClose, onSaved }: { pkg: Pkg | "new" | null; defs: EntitlementDef[]; catalog: CatalogPlan[]; onClose: () => void; onSaved: () => void }) {
  const blank = {
    name: "", description: "", target: "individual" as Pkg["target"], plan: "pro", monthlyTokenCap: "", seats: "", pooledMonthlyTokens: "", durationDays: "30", price: "", currency: "INR", features: "", active: true,
    isPublic: false, badge: "", highlight: false, entitlements: {} as Record<string, boolean | number>,
  };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const existing = pkg && pkg !== "new" ? pkg : null;
  useEffect(() => {
    if (pkg === "new") setF(blank);
    else if (pkg)
      setF({
        name: pkg.name, description: pkg.description, target: pkg.target, plan: pkg.plan, monthlyTokenCap: pkg.monthly_token_cap ? String(pkg.monthly_token_cap) : "", seats: pkg.seats ? String(pkg.seats) : "",
        pooledMonthlyTokens: pkg.pooled_monthly_tokens ? String(pkg.pooled_monthly_tokens) : "", durationDays: pkg.duration_days ? String(pkg.duration_days) : "", price: pkg.price_paise ? String(pkg.price_paise / 100) : "",
        currency: pkg.currency, features: pkg.features.join("\n"), active: pkg.active,
        isPublic: Boolean(pkg.public), badge: pkg.badge ?? "", highlight: Boolean(pkg.highlight), entitlements: pkg.entitlements ?? {},
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg]);
  const org = f.target === "organization";
  const num = (v: string) => (v ? Number(v) : null);
  return (
    <Drawer
      open={Boolean(pkg)}
      onClose={onClose}
      title={existing ? existing.name : "New package"}
      footer={
        <>
          {existing && (
            <Button variant="danger" onClick={async () => { if (window.confirm("Delete (or archive, if in use) this package?") && (await act(() => api.delete(`/console/plans/packages/${existing.id}`), "Removed"))) onSaved(); }}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <span className="flex-1" />
          <Button
            variant="primary"
            loading={busy}
            disabled={!f.name.trim()}
            onClick={async () => {
              setBusy(true);
              const ok = await act(
                () =>
                  api.post("/console/plans/packages", {
                    ...(existing ? { id: existing.id } : {}),
                    name: f.name,
                    description: f.description,
                    target: f.target,
                    plan: org ? "enterprise" : f.plan,
                    monthlyTokenCap: org ? null : num(f.monthlyTokenCap),
                    seats: org ? num(f.seats) : null,
                    pooledMonthlyTokens: org ? num(f.pooledMonthlyTokens) : null,
                    durationDays: num(f.durationDays),
                    pricePaise: Math.round((Number(f.price) || 0) * 100),
                    currency: f.currency.toUpperCase(),
                    features: f.features.split("\n").map((s) => s.trim()).filter(Boolean),
                    active: f.active,
                    public: f.isPublic,
                    badge: f.badge.trim() || null,
                    highlight: f.highlight,
                    entitlements: f.entitlements,
                  }),
                existing ? "Package saved" : "Package created",
              );
              setBusy(false);
              if (ok) onSaved();
            }}
          >
            {existing ? "Save" : "Create package"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Who it's for">
          <Segmented value={f.target} onChange={(target) => setF({ ...f, target })} options={[{ value: "individual", label: "A person" }, { value: "organization", label: "An enterprise" }]} />
        </Field>
        <Field label="Package name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={org ? "Acme Corp — 50 seats" : "Creator Pro+"} /></Field>
        <Field label="Description"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {org ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Seats"><Input type="number" min={1} value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} /></Field>
            <Field label="Pooled tokens / month"  hint="Empty = seats × the plan's per-seat tokens"><Input type="number" min={1} value={f.pooledMonthlyTokens} onChange={(e) => setF({ ...f, pooledMonthlyTokens: e.target.value })} /></Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Plan"><Select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} options={[{ value: "pro", label: "Pro" }, { value: "premium", label: "Premium" }, { value: "free", label: "Free" }]} /></Field>
            <Field label="Tokens / month" hint="Empty = the plan's default"><Input type="number" min={1} value={f.monthlyTokenCap} onChange={(e) => setF({ ...f, monthlyTokenCap: e.target.value })} /></Field>
          </div>
        )}
        <div className="grid grid-cols-[1fr_1fr_90px] gap-3">
          <Field label="Duration (days)" hint="Empty = no end"><Input type="number" min={1} value={f.durationDays} onChange={(e) => setF({ ...f, durationDays: e.target.value })} /></Field>
          <Field label="Price" hint={f.isPublic ? "Charged at checkout" : "For your records / invoices"}><Input type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          <Field label="Currency"><Input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value })} /></Field>
        </div>
        <Field label="What's included" hint="One per line"><Textarea value={f.features} onChange={(e) => setF({ ...f, features: e.target.value })} placeholder={"Priority support\nDedicated onboarding"} /></Field>
        <Field label="Unlocks" hint="Blank = the plan's own value. Applied while the package is active.">
          <EntitlementsEditor defs={defs} value={f.entitlements} onChange={(entitlements) => setF({ ...f, entitlements })} inherit={catalog.find((c) => c.id === (org ? "enterprise" : f.plan))?.entitlements} />
        </Field>
        <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Available to apply" />
        <div className="rounded-2xl border border-border p-3">
          <Toggle checked={f.isPublic} onChange={(v) => setF({ ...f, isPublic: v })} label="Sell on the public Plans page" />
          {f.isPublic && (
            <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Badge" hint="Optional, e.g. LIMITED"><Input value={f.badge} maxLength={24} onChange={(e) => setF({ ...f, badge: e.target.value })} /></Field>
              <Toggle checked={f.highlight} onChange={(v) => setF({ ...f, highlight: v })} label="Feature it" />
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function formatEntitlement(def: EntitlementDef, value: boolean | number | undefined): string {
  if (value === undefined) return "—";
  if (def.type === "boolean") return value ? "Yes" : "No";
  if (def.key === "libraryStorageMb" && typeof value === "number") return value >= 1024 ? `${+(value / 1024).toFixed(1)} GB` : `${value} MB`;
  return formatNumber(Number(value));
}

/**
 * Edits entitlements. With `inherit` (packages), a blank field means "keep the plan's value" and is
 * left out of the saved object; without it (the plan catalog) every value is explicit.
 */
function EntitlementsEditor({ defs, value, onChange, inherit }: { defs: EntitlementDef[]; value: Record<string, boolean | number>; onChange: (v: Record<string, boolean | number>) => void; inherit?: Record<string, boolean | number> }) {
  const set = (key: string, v: boolean | number | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {defs.map((def) => (
        <label key={def.key} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2" title={def.hint}>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{def.label}</span>
          {def.type === "boolean" ? (
            <select
              value={value[def.key] === undefined ? "" : value[def.key] ? "on" : "off"}
              onChange={(e) => set(def.key, e.target.value === "" ? undefined : e.target.value === "on")}
              className="h-8 rounded-lg border border-border bg-background px-2 text-xs"
            >
              {inherit && <option value="">Plan ({inherit[def.key] ? "yes" : "no"})</option>}
              <option value="on">Yes</option>
              <option value="off">No</option>
            </select>
          ) : (
            <input
              type="number"
              min={0}
              value={value[def.key] === undefined ? "" : String(value[def.key])}
              placeholder={inherit ? String(inherit[def.key] ?? "") : ""}
              onChange={(e) => set(def.key, e.target.value === "" ? (inherit ? undefined : 0) : Number(e.target.value))}
              className="h-8 w-24 rounded-lg border border-border bg-background px-2 text-right text-xs"
            />
          )}
        </label>
      ))}
    </div>
  );
}

function CatalogEditor({ plan, defs, onClose, onSaved }: { plan: CatalogPlan | null; defs: EntitlementDef[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: "", tagline: "", price: "", discount: "10", minSeats: "", badge: "", highlight: false, features: "", monthly: "", perSeat: "", active: true, entitlements: {} as Record<string, boolean | number> });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!plan) return;
    setF({
      name: plan.name, tagline: plan.tagline, price: plan.monthlyPricePaise ? String(plan.monthlyPricePaise / 100) : "", discount: String(plan.annualDiscountPercent), minSeats: plan.minSeats ? String(plan.minSeats) : "",
      badge: plan.badge ?? "", highlight: plan.highlight, features: plan.features.join("\n"),
      monthly: plan.limits.monthly ? String(plan.limits.monthly) : "", perSeat: plan.limits.tokensPerSeat ? String(plan.limits.tokensPerSeat) : "", active: plan.active, entitlements: { ...plan.entitlements },
    });
  }, [plan]);
  if (!plan) return <Drawer open={false} onClose={onClose} title="">{null}</Drawer>;
  const enterprise = plan.id === "enterprise";
  const num = (v: string) => (v ? Number(v) : null);
  const save = async () => {
    setBusy(true);
    const ok = await act(
      () =>
        api.patch(`/console/plans/catalog/${plan.id}`, {
          name: f.name,
          tagline: f.tagline,
          monthlyPricePaise: plan.id === "free" ? 0 : Math.round((Number(f.price) || 0) * 100),
          annualDiscountPercent: Number(f.discount) || 0,
          ...(enterprise ? { minSeats: num(f.minSeats), tokensPerSeat: num(f.perSeat) } : { monthlyTokens: num(f.monthly) }),
          badge: f.badge.trim() || null,
          highlight: f.highlight,
          features: f.features.split("\n").map((s) => s.trim()).filter(Boolean),
          entitlements: f.entitlements,
          active: f.active,
        }),
      "Plan saved — the Plans page and limits update within a minute",
    );
    setBusy(false);
    if (ok) onSaved();
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={`Edit ${plan.name}`}
      subtitle={<span className="text-xs text-muted">Changes apply to everyone on this plan</span>}
      footer={<><span className="flex-1" /><Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={() => void save()}>Save plan</Button></>}
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Badge" hint="Optional, e.g. MOST POPULAR"><Input value={f.badge} maxLength={24} onChange={(e) => setF({ ...f, badge: e.target.value })} /></Field>
        </div>
        <Field label="Tagline"><Input value={f.tagline} onChange={(e) => setF({ ...f, tagline: e.target.value })} /></Field>
        {plan.id !== "free" && (
          <div className="grid grid-cols-3 gap-3">
            <Field label={enterprise ? "₹ / seat / month" : "₹ / month"}><Input type="number" min={0} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            <Field label="Annual discount %"><Input type="number" min={0} max={90} value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} /></Field>
            {enterprise && <Field label="Min seats"><Input type="number" min={1} value={f.minSeats} onChange={(e) => setF({ ...f, minSeats: e.target.value })} /></Field>}
          </div>
        )}
        {enterprise ? (
          <Field label="Pooled tokens per seat / month"><Input type="number" min={1} value={f.perSeat} onChange={(e) => setF({ ...f, perSeat: e.target.value })} /></Field>
        ) : (
          <Field label="Tokens per month" hint="Billable tokens (cache reads count 10%). Renews on each subscriber's own monthly date; applies to the current month immediately.">
            <Input type="number" min={1} value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} />
          </Field>
        )}
        <Field label="Plans page bullets" hint="One per line"><Textarea value={f.features} onChange={(e) => setF({ ...f, features: e.target.value })} className="min-h-[120px]" /></Field>
        <Field label="Unlocks"><EntitlementsEditor defs={defs} value={f.entitlements} onChange={(entitlements) => setF({ ...f, entitlements })} /></Field>
        <div className="flex flex-wrap gap-6">
          <Toggle checked={f.highlight} onChange={(v) => setF({ ...f, highlight: v })} label="Feature this plan" />
          {plan.id !== "free" && <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Show & sell" />}
        </div>
      </div>
    </Drawer>
  );
}

function GrantDrawer({ open, packages, orgs, onClose, onSaved }: { open: boolean; packages: Pkg[]; orgs: Org[]; onClose: () => void; onSaved: () => void }) {
  const blank = { target: "user" as "user" | "org", user: "", organizationId: "", mode: "plan" as "plan" | "package", packageId: "", plan: "pro", monthlyTokenCap: "", seats: "", durationDays: "30", note: "" };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF(blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const eligiblePackages = packages.filter((p) => p.active && p.target === (f.target === "org" ? "organization" : "individual"));
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Grant access"
      subtitle="Switches back automatically when it ends (never touches a plan someone pays for)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={f.target === "user" ? !f.user.trim() : !f.organizationId}
            onClick={async () => {
              setBusy(true);
              const ok = await act(
                () =>
                  api.post("/console/plans/grants", {
                    ...(f.target === "user" ? { user: f.user.trim() } : { organizationId: f.organizationId }),
                    ...(f.mode === "package"
                      ? { packageId: f.packageId }
                      : {
                          plan: f.target === "org" ? "enterprise" : f.plan,
                          monthlyTokenCap: f.monthlyTokenCap ? Number(f.monthlyTokenCap) : null,
                          seats: f.seats ? Number(f.seats) : null,
                          durationDays: f.durationDays ? Number(f.durationDays) : null,
                        }),
                    note: f.note,
                  }),
                "Access granted",
              );
              setBusy(false);
              if (ok) onSaved();
            }}
          >
            Grant
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Give access to">
          <Segmented value={f.target} onChange={(target) => setF({ ...f, target, packageId: "" })} options={[{ value: "user", label: "A person" }, { value: "org", label: "An organization" }]} />
        </Field>
        {f.target === "user" ? (
          <Field label="Email (or user id)"><Input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} placeholder="person@company.com" /></Field>
        ) : (
          <Field label="Organization"><Select value={f.organizationId} onChange={(e) => setF({ ...f, organizationId: e.target.value })} options={[{ value: "", label: "Choose…" }, ...orgs.map((o) => ({ value: o.id, label: `${o.name} (${o.plan}, ${o.seat_count} seats)` }))]} /></Field>
        )}
        <Field label="What">
          <Segmented value={f.mode} onChange={(mode) => setF({ ...f, mode })} options={[{ value: "plan", label: "Custom" }, { value: "package", label: "A package" }]} />
        </Field>
        {f.mode === "package" ? (
          <Field label="Package"><Select value={f.packageId} onChange={(e) => setF({ ...f, packageId: e.target.value })} options={[{ value: "", label: "Choose…" }, ...eligiblePackages.map((p) => ({ value: p.id, label: p.name }))]} /></Field>
        ) : (
          <>
            {f.target === "user" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Plan"><Select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })} options={[{ value: "pro", label: "Pro" }, { value: "premium", label: "Premium" }, { value: "free", label: "Free" }]} /></Field>
                <Field label="Tokens / month" hint="Empty = plan default"><Input type="number" min={1} value={f.monthlyTokenCap} onChange={(e) => setF({ ...f, monthlyTokenCap: e.target.value })} /></Field>
              </div>
            ) : (
              <Field label="Seats"><Input type="number" min={1} value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} /></Field>
            )}
            <Field label="For (days)" hint="Empty = no end date"><Input type="number" min={1} value={f.durationDays} onChange={(e) => setF({ ...f, durationDays: e.target.value })} /></Field>
          </>
        )}
        <Field label="Note" hint="Why — e.g. “Partnership trial”, “Refund goodwill”"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Drawer>
  );
}

type Economics = {
  settings: { usd_to_inr: number; blended_cost_per_m_inr: number; target_cost_share_pct: number; free_cost_budget_inr: number; e2b_cost_per_hour_inr: number };
  overheadMonthlyInr: number;
  payingUsers: number;
  overheadPerPaidUserInr: number;
  plans: {
    id: CatalogPlan["id"];
    name: string;
    priceInr: number;
    monthlyCredits: number;
    usageCostInr: number;
    tokensMillions: number;
    e2bAvgInr: number;
    overheadInr: number;
    totalCostInr: number;
    marginInr: number;
    marginPct: number | null;
    status: "ok" | "tight" | "loss";
    subscribers: number;
    suggested: { monthly: number | null; tokensPerSeat: number | null };
  }[];
};

/** Live profit per plan from Finance: usage cost at the caps + E2B + hosting/domains overhead, with one-click suggested limits. */
function ProfitPanel({ canManage, onApplied }: { canManage: boolean; onApplied: () => void }) {
  const eco = useResource<Economics>("/console/plans/economics");
  const e = eco.data;
  const [busy, setBusy] = useState<string | null>(null);
  if (eco.loading && !e) return <Loading />;
  if (!e) return <ErrorNote error={eco.error} />;
  const tone = (st: string) => (st === "ok" ? "green" : st === "tight" ? "amber" : "red");
  async function apply(p: Economics["plans"][number]) {
    setBusy(p.id);
    const body = p.id === "enterprise" ? { tokensPerSeat: p.suggested.tokensPerSeat } : { monthlyTokens: p.suggested.monthly };
    const ok = await act(() => api.patch(`/console/plans/catalog/${p.id}`, body), `${p.name} limits updated`);
    setBusy(null);
    if (ok) {
      void eco.reload();
      onApplied();
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <Card className="text-sm text-muted">
        Usage cost at ₹{e.settings.blended_cost_per_m_inr}/1M tokens (Finance → settings) · E2B ₹{e.settings.e2b_cost_per_hour_inr}/h · hosting, domains and tools{" "}
        {formatMoney(e.overheadMonthlyInr)}/month across {e.payingUsers} paying user{e.payingUsers === 1 ? "" : "s"} ({formatMoney(e.overheadPerPaidUserInr)} each). Worst case = a subscriber who uses the whole monthly allowance.
        Change costs in Finance (blended rate, per-model overrides) or Expenses (hosting, domains, E2B fees) and this updates.
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {e.plans.map((p) => (
          <Card key={p.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{p.name}</span>
              <Badge tone={tone(p.status)}>{p.status === "ok" ? "healthy" : p.status === "tight" ? "tight" : "losing"}</Badge>
              <span className="ml-auto text-xs text-muted">{p.subscribers} {p.id === "enterprise" ? "seats" : "users"}</span>
            </div>
            <div className="text-2xl font-semibold">{p.priceInr ? formatMoney(p.priceInr) : "Free"}<span className="text-sm font-normal text-muted">{p.priceInr ? " / month" : ""}</span></div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Usage at cap</dt><dd className="text-right">{formatMoney(p.usageCostInr)} · {formatNumber(p.tokensMillions)}M tok</dd>
              <dt className="text-muted">E2B (avg)</dt><dd className="text-right">{formatMoney(p.e2bAvgInr)}</dd>
              <dt className="text-muted">Hosting &amp; domains</dt><dd className="text-right">{formatMoney(p.overheadInr)}</dd>
              <dt className="font-medium">Total cost</dt><dd className="text-right font-medium">{formatMoney(p.totalCostInr)}</dd>
              <dt className="font-medium">Profit</dt><dd className={`text-right font-medium ${p.marginInr < 0 ? "text-danger" : ""}`}>{p.priceInr ? `${formatMoney(p.marginInr)} (${p.marginPct}%)` : "—"}</dd>
            </dl>
            <div className="mt-1 border-t border-border pt-2 text-xs text-muted">
              Suggested for {p.id === "free" ? `₹${e.settings.free_cost_budget_inr}` : `${e.settings.target_cost_share_pct}% usage cost`}:{" "}
              {p.id === "enterprise" ? `${formatNumber(p.suggested.tokensPerSeat ?? 0)} tokens / seat / month` : `${formatNumber(p.suggested.monthly ?? 0)} tokens / month`}
            </div>
            {canManage && (
              <Button size="sm" disabled={busy === p.id} onClick={() => void apply(p)}>Apply suggested allowance</Button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
