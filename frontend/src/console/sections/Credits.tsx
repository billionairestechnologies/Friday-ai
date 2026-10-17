import { useMemo, useState } from "react";
import { Check, Gift, Search, Settings2, ShieldCheck, Users as UsersIcon, X } from "lucide-react";
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
  PageHeader,
  Segmented,
  Select,
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
 * Console → Credits: bonus tokens on top of a plan's monthly allowance (supabase 0060,
 * services/quota/credits.ts). Grants are append-only; the ledger owns the balance. Big grants wait
 * for a second person; bulk grants are previewed and then granted to exactly the previewed audience.
 */

type Status = "pending" | "active" | "expired" | "revoked" | "rejected";
type Grant = {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  tokens: number;
  remaining: number;
  status: Status;
  kind: string;
  source: string;
  reason: string;
  expires_at: string | null;
  batch_id: string | null;
  created_by: string | null;
  approved_by: string | null;
  revoke_reason: string | null;
  expired_tokens: number;
  revoked_tokens: number;
  created_at: string;
  recipient: { name: string; email: string | null } | null;
};
type Settings = { approvalThresholdTokens: number; maxGrantTokens: number; bulkMaxRecipients: number };
type Overview = {
  summary: { outstanding: number; pendingCount: number; pendingTokens: number; expiringIn7Days: number; granted30d: number; used30d: number };
  settings: Settings;
  grants: Grant[];
};
type Staff = { staff: Array<{ userId: string; name: string }> };
type UserRow = { id: string; email: string | null; full_name: string | null; plan: string };

const KINDS = [
  { value: "promotional", label: "Promotional" },
  { value: "goodwill", label: "Goodwill" },
  { value: "compensation", label: "Compensation (outage, bug)" },
  { value: "trial", label: "Trial" },
  { value: "campaign", label: "Campaign" },
  { value: "program", label: "Programme (student / startup)" },
];
const QUICK = [500_000, 1_000_000, 5_000_000, 10_000_000];
const EXPIRY = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "custom", label: "Pick a date" },
  { value: "never", label: "Never" },
];
const TONE: Record<Status, string> = { pending: "amber", active: "green", expired: "neutral", revoked: "red", rejected: "neutral" };
const fmt = (n: number) => (n >= 1_000_000_000 ? `${Number((n / 1_000_000_000).toFixed(2))}B` : n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : n >= 1_000 ? `${Number((n / 1_000).toFixed(1))}K` : String(n));

function expiryIso(choice: string, custom: string): string | null | undefined {
  if (choice === "never") return null;
  if (choice === "custom") return fromLocalInput(custom) ?? undefined;
  return new Date(Date.now() + Number(choice) * 86_400_000).toISOString();
}

export default function Credits() {
  const canGrant = useCan("credits.grant");
  const canApprove = useCan("credits.approve");
  const canSettings = useCan("credits.settings");
  const data = useResource<Overview>("/console/credits");
  const staff = useResource<Staff>("/console/staff");
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [drawer, setDrawer] = useState<"single" | "bulk" | "settings" | null>(null);
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const who = useMemo(() => new Map((staff.data?.staff ?? []).map((s) => [s.userId, s.name])), [staff.data]);

  if (data.loading && !data.data) return <Loading label="Loading credits" />;
  if (data.error && !data.data) return <ErrorNote error={data.error} />;
  const { summary, settings, grants } = data.data!;
  const shown = filter === "all" ? grants : grants.filter((g) => g.status === filter);
  const pending = grants.filter((g) => g.status === "pending");
  const batches = new Map<string, Grant[]>();
  const singles: Grant[] = [];
  for (const g of pending) {
    if (g.batch_id) batches.set(g.batch_id, [...(batches.get(g.batch_id) ?? []), g]);
    else singles.push(g);
  }

  const approve = async (path: string, text: string) => {
    if (await act(() => api.post(path, {}), text)) void data.reload();
  };

  return (
    <>
      <PageHeader
        title="Credits"
        description="Bonus tokens on top of a plan's monthly allowance. They carry over from month to month, expire on their own date, and are used after the month's tokens run out."
        actions={
          <div className="flex flex-wrap gap-2">
            {canSettings && (
              <Button onClick={() => setDrawer("settings")}>
                <Settings2 className="size-4" /> Limits
              </Button>
            )}
            {canGrant && (
              <>
                <Button onClick={() => setDrawer("bulk")}>
                  <UsersIcon className="size-4" /> Bulk grant
                </Button>
                <Button variant="primary" onClick={() => setDrawer("single")}>
                  <Gift className="size-4" /> Grant credits
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Unspent credits" value={fmt(summary.outstanding)} hint="Across every account" />
          <Stat label="Waiting for approval" value={formatNumber(summary.pendingCount)} hint={summary.pendingTokens ? `${fmt(summary.pendingTokens)} tokens` : undefined} />
          <Stat label="Expiring in 7 days" value={fmt(summary.expiringIn7Days)} />
          <Stat label="Granted · 30 days" value={fmt(summary.granted30d)} />
          <Stat label="Used · 30 days" value={fmt(summary.used30d)} />
        </div>

        {pending.length > 0 && (
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
              <ShieldCheck className="size-4" /> Waiting for approval
              <span className="w-full text-xs font-normal text-muted md:w-auto">Above {fmt(settings.approvalThresholdTokens)} tokens · approved by someone other than whoever asked</span>
            </div>
            <ul className="divide-y divide-border/60 text-sm">
              {[...batches.entries()].map(([batchId, list]) => (
                <li key={batchId} className="flex flex-col gap-2 py-2.5 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-medium">
                      Bulk grant · {formatNumber(list.length)} people × {fmt(list[0]!.tokens)}
                    </div>
                    <div className="text-xs text-muted">
                      {list[0]!.reason} · {fmt(list.reduce((n, g) => n + g.tokens, 0))} total · asked by {who.get(list[0]!.created_by ?? "") ?? "a teammate"} {timeAgo(list[0]!.created_at)}
                    </div>
                  </div>
                  {canApprove && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setRevoking({ ...list[0]!, id: `batch:${batchId}` })}>
                        <X className="size-4" /> Reject
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => void approve(`/console/credits/batches/${batchId}/approve`, "Batch approved")}>
                        <Check className="size-4" /> Approve all
                      </Button>
                    </div>
                  )}
                </li>
              ))}
              {singles.map((g) => (
                <li key={g.id} className="flex flex-col gap-2 py-2.5 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="font-medium">
                      {fmt(g.tokens)} tokens · <Recipient grant={g} />
                    </div>
                    <div className="text-xs text-muted">
                      {g.reason} · asked by {who.get(g.created_by ?? "") ?? "a teammate"} {timeAgo(g.created_at)}
                    </div>
                  </div>
                  {canApprove && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setRevoking(g)}>
                        <X className="size-4" /> Reject
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => void approve(`/console/credits/grants/${g.id}/approve`, "Grant approved")}>
                        <Check className="size-4" /> Approve
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="font-medium">Grants</div>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "active", label: "Active" },
                { value: "pending", label: "Pending" },
                { value: "expired", label: "Expired" },
                { value: "revoked", label: "Revoked" },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={Gift} title="No grants here" text={canGrant ? "Grant credits to a person, or to a whole audience with Bulk grant." : undefined} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-3">To</th>
                    <th className="py-2 pr-3 text-right">Granted</th>
                    <th className="py-2 pr-3 text-right">Left</th>
                    <th className="py-2 pr-3">Expires</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Why</th>
                    {canGrant && <th className="py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((g) => (
                    <tr key={g.id} className="border-b border-border/60 last:border-0 align-top">
                      <td className="py-2.5 pr-3">
                        <Recipient grant={g} />
                        <div className="text-xs text-muted">
                          {g.kind}
                          {g.batch_id ? " · bulk" : ""} · {formatDate(g.created_at)}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{fmt(g.tokens)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{g.status === "active" ? fmt(g.remaining) : "—"}</td>
                      <td className="py-2.5 pr-3 text-xs">{g.expires_at ? formatDate(g.expires_at) : "Never"}</td>
                      <td className="py-2.5 pr-3">
                        <Badge tone={TONE[g.status]}>{g.status}</Badge>
                        {g.status === "expired" && g.expired_tokens > 0 && <div className="mt-1 text-xs text-muted">{fmt(g.expired_tokens)} unused</div>}
                        {g.status === "revoked" && <div className="mt-1 text-xs text-muted">{fmt(g.revoked_tokens)} taken back</div>}
                      </td>
                      <td className="max-w-[260px] py-2.5 pr-3 text-xs text-muted">
                        {g.reason}
                        {g.revoke_reason && <div className="mt-0.5">Revoked: {g.revoke_reason}</div>}
                        <div className="mt-0.5">by {who.get(g.created_by ?? "") ?? "a teammate"}</div>
                      </td>
                      {canGrant && (
                        <td className="py-2.5 text-right">
                          {g.status === "active" && g.remaining > 0 && (
                            <Button size="sm" onClick={() => setRevoking(g)}>
                              Revoke
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {drawer === "single" && <GrantDrawer settings={settings} onClose={() => setDrawer(null)} onDone={() => (setDrawer(null), void data.reload())} />}
      {drawer === "bulk" && <BulkDrawer settings={settings} onClose={() => setDrawer(null)} onDone={() => (setDrawer(null), void data.reload())} />}
      {drawer === "settings" && <SettingsDrawer settings={settings} onClose={() => setDrawer(null)} onDone={() => (setDrawer(null), void data.reload())} />}
      {revoking && <RevokeDrawer grant={revoking} onClose={() => setRevoking(null)} onDone={() => (setRevoking(null), void data.reload())} />}
    </>
  );
}

function Recipient({ grant }: { grant: Grant }) {
  if (grant.organization_id) return <span className="font-medium">Organization pool</span>;
  return (
    <span className="font-medium" title={grant.recipient?.email ?? undefined}>
      {grant.recipient?.name ?? `${grant.user_id?.slice(0, 8) ?? "?"}…`}
    </span>
  );
}

function TokensField({ value, onChange, max }: { value: string; onChange: (v: string) => void; max: number }) {
  const n = Number(value);
  return (
    <Field label="Tokens" hint={`Up to ${fmt(max)} per grant.`}>
      <div className="flex flex-wrap gap-2">
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onChange(String(q))}
            className={cn("rounded-lg border px-3 py-1.5 text-sm transition-colors", n === q ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-chip")}
          >
            {fmt(q)}
          </button>
        ))}
        <Input aria-label="Custom token amount" inputMode="numeric" className="w-36" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))} />
      </div>
    </Field>
  );
}

function CommonFields(p: {
  kind: string;
  setKind: (v: string) => void;
  expiry: string;
  setExpiry: (v: string) => void;
  customExpiry: string;
  setCustomExpiry: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
}) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Type">
          <Select value={p.kind} onChange={(e) => p.setKind(e.target.value)} options={KINDS} />
        </Field>
        <Field label="Expires after">
          <Select value={p.expiry} onChange={(e) => p.setExpiry(e.target.value)} options={EXPIRY} />
          {p.expiry === "custom" && <Input type="datetime-local" className="mt-2" aria-label="Expiry date" value={p.customExpiry} onChange={(e) => p.setCustomExpiry(e.target.value)} />}
        </Field>
      </div>
      <Field label="Reason" hint="Shown in the history and the audit log (not to the customer).">
        <Textarea rows={2} value={p.reason} onChange={(e) => p.setReason(e.target.value)} placeholder="e.g. Sorry for Tuesday's outage" />
      </Field>
    </>
  );
}

function GrantDrawer({ settings, onClose, onDone }: { settings: Settings; onClose: () => void; onDone: () => void }) {
  const [key] = useState(() => crypto.randomUUID());
  const [query, setQuery] = useState("");
  const [user, setUser] = useState<UserRow | null>(null);
  const [tokens, setTokens] = useState("1000000");
  const [kind, setKind] = useState("goodwill");
  const [expiry, setExpiry] = useState("90");
  const [customExpiry, setCustomExpiry] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const search = useResource<{ users: UserRow[] }>(query.trim().length >= 2 && !user ? `/console/users?limit=8&q=${encodeURIComponent(query.trim())}` : null);
  const n = Number(tokens);
  const expiresAt = expiryIso(expiry, customExpiry);
  const big = n > settings.approvalThresholdTokens;
  const ready = user && Number.isInteger(n) && n > 0 && n <= settings.maxGrantTokens && expiresAt !== undefined && reason.trim().length >= 3;

  const submit = async () => {
    setBusy(true);
    const ok = await act(
      () => api.post("/console/credits/grants", { userId: user!.id, tokens: n, expiresAt, kind, reason: reason.trim(), key }),
      big ? "Sent for approval" : "Credits granted — they've been notified",
    );
    setBusy(false);
    if (ok) onDone();
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title="Grant credits"
      subtitle="Added on top of their monthly allowance; used after it runs out."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void submit()}>
            {big ? "Send for approval" : "Grant"}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Person">
          {user ? (
            <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{user.full_name || user.email}</span> <span className="text-muted">{user.email} · {user.plan}</span>
              </span>
              <button type="button" className="text-xs text-muted hover:text-foreground" onClick={() => setUser(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <Input aria-label="Search people" placeholder="Name or email" className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              {(search.data?.users ?? []).length > 0 && (
                <ul className="mt-2 divide-y divide-border rounded-xl border border-border text-sm">
                  {search.data!.users.map((u) => (
                    <li key={u.id}>
                      <button type="button" className="flex w-full justify-between px-3 py-2 text-left hover:bg-chip" onClick={() => setUser(u)}>
                        <span>{u.full_name || u.email}</span>
                        <span className="text-xs text-muted">
                          {u.email} · {u.plan}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Field>
        <TokensField value={tokens} onChange={setTokens} max={settings.maxGrantTokens} />
        <CommonFields kind={kind} setKind={setKind} expiry={expiry} setExpiry={setExpiry} customExpiry={customExpiry} setCustomExpiry={setCustomExpiry} reason={reason} setReason={setReason} />
        {big && <p className="rounded-xl bg-chip px-3 py-2 text-sm">Above {fmt(settings.approvalThresholdTokens)} tokens — a teammate with approval rights has to approve it before it reaches the account.</p>}
      </div>
    </Drawer>
  );
}

type Preview = { count: number; tooMany: boolean; maxRecipients: number; totalTokens: number; requiresApproval: boolean; sample: Array<{ id: string; name: string; email: string | null; plan: string }>; missingEmails: string[] };

function BulkDrawer({ settings, onClose, onDone }: { settings: Settings; onClose: () => void; onDone: () => void }) {
  const [batchId] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<"plans" | "emails" | "signed_up" | "all">("plans");
  const [plans, setPlans] = useState<string[]>(["pro"]);
  const [emails, setEmails] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tokens, setTokens] = useState("1000000");
  const [kind, setKind] = useState("promotional");
  const [expiry, setExpiry] = useState("90");
  const [customExpiry, setCustomExpiry] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const n = Number(tokens);
  const expiresAt = expiryIso(expiry, customExpiry);

  const audience = () => {
    if (mode === "plans") return { kind: "plans", plans };
    if (mode === "emails") return { kind: "emails", emails: emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean) };
    if (mode === "signed_up") return { kind: "signed_up", from: fromLocalInput(from), to: fromLocalInput(to) };
    return { kind: "all" };
  };
  const reset = () => setPreview(null);

  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview(await api.post<Preview>("/console/credits/bulk/preview", { audience: audience(), tokens: n }));
    } catch (err) {
      await act(() => Promise.reject(err));
    }
    setBusy(false);
  };
  const submit = async () => {
    setBusy(true);
    const ok = await act(
      () => api.post("/console/credits/bulk", { audience: audience(), tokens: n, expiresAt, kind, reason: reason.trim(), batchId, expectedCount: preview!.count }),
      preview!.requiresApproval ? "Batch sent for approval" : `Granted to ${preview!.count.toLocaleString()} people`,
    );
    setBusy(false);
    if (ok) onDone();
  };
  const ready = preview && !preview.tooMany && preview.count > 0 && Number.isInteger(n) && n > 0 && expiresAt !== undefined && reason.trim().length >= 3;

  return (
    <Drawer
      open
      onClose={onClose}
      title="Bulk grant"
      subtitle="Preview the audience first; the grant goes to exactly the people previewed."
      width={620}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {!preview ? (
            <Button variant="primary" loading={busy} disabled={!(Number.isInteger(n) && n > 0)} onClick={() => void runPreview()}>
              Preview audience
            </Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
              {preview.requiresApproval ? "Send for approval" : `Grant to ${preview.count.toLocaleString()}`}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Who">
          <Segmented
            value={mode}
            onChange={(v) => (setMode(v), reset())}
            options={[
              { value: "plans", label: "By plan" },
              { value: "emails", label: "Email list" },
              { value: "signed_up", label: "Signed up between" },
              { value: "all", label: "Everyone" },
            ]}
          />
          <div className="mt-3">
            {mode === "plans" && (
              <div className="flex flex-wrap gap-2">
                {["free", "pro", "premium", "enterprise"].map((p) => (
                  <label key={p} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm", plans.includes(p) ? "border-primary bg-primary/10 text-primary" : "border-border")}>
                    <input type="checkbox" className="sr-only" checked={plans.includes(p)} onChange={() => (setPlans(plans.includes(p) ? plans.filter((x) => x !== p) : [...plans, p]), reset())} />
                    {p[0]!.toUpperCase() + p.slice(1)}
                  </label>
                ))}
              </div>
            )}
            {mode === "emails" && <Textarea rows={4} aria-label="Email addresses" placeholder="One per line, or separated by commas" value={emails} onChange={(e) => (setEmails(e.target.value), reset())} />}
            {mode === "signed_up" && (
              <div className="grid gap-2 md:grid-cols-2">
                <Input type="datetime-local" aria-label="From" value={from} onChange={(e) => (setFrom(e.target.value), reset())} />
                <Input type="datetime-local" aria-label="To" value={to} onChange={(e) => (setTo(e.target.value), reset())} />
              </div>
            )}
          </div>
        </Field>
        <TokensField value={tokens} onChange={(v) => (setTokens(v), reset())} max={settings.maxGrantTokens} />
        <CommonFields kind={kind} setKind={setKind} expiry={expiry} setExpiry={setExpiry} customExpiry={customExpiry} setCustomExpiry={setCustomExpiry} reason={reason} setReason={setReason} />

        {preview && (
          <Card className="bg-chip">
            {preview.tooMany ? (
              <p className="text-sm text-danger">More than {preview.maxRecipients.toLocaleString()} people match — narrow the audience (the limit is set under Limits).</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-xs text-muted">People</div>
                    <div className="text-lg font-semibold tabular-nums">{preview.count.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Total tokens</div>
                    <div className="text-lg font-semibold tabular-nums">{fmt(preview.totalTokens)}</div>
                  </div>
                </div>
                {preview.sample.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs text-muted">
                    {preview.sample.map((s) => (
                      <li key={s.id}>
                        {s.name} · {s.email} · {s.plan}
                      </li>
                    ))}
                    {preview.count > preview.sample.length && <li>…and {(preview.count - preview.sample.length).toLocaleString()} more</li>}
                  </ul>
                )}
                {preview.missingEmails.length > 0 && <p className="mt-2 text-xs text-danger">No account for: {preview.missingEmails.join(", ")}</p>}
                {preview.requiresApproval && <p className="mt-2 text-xs">The total is above {fmt(settings.approvalThresholdTokens)} — the batch waits for a teammate's approval.</p>}
              </>
            )}
          </Card>
        )}
      </div>
    </Drawer>
  );
}

function RevokeDrawer({ grant, onClose, onDone }: { grant: Grant; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const batch = grant.id.startsWith("batch:") ? grant.id.slice(6) : null;
  const pending = grant.status === "pending";
  const submit = async () => {
    setBusy(true);
    const path = batch ? `/console/credits/batches/${batch}/reject` : `/console/credits/grants/${grant.id}/revoke`;
    const ok = await act(() => api.post(path, { reason: reason.trim() }), pending ? "Rejected" : "Revoked — the unused part was taken back");
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={batch ? "Reject bulk grant" : pending ? "Reject grant" : "Revoke grant"}
      subtitle={pending ? "Nothing reaches the account." : `Takes back the ${fmt(grant.remaining)} tokens still unused. What was used stays used.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={reason.trim().length < 3} onClick={() => void submit()}>
            {pending || batch ? "Reject" : "Revoke"}
          </Button>
        </div>
      }
    >
      <Field label="Reason">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Drawer>
  );
}

function SettingsDrawer({ settings, onClose, onDone }: { settings: Settings; onClose: () => void; onDone: () => void }) {
  const [threshold, setThreshold] = useState(String(settings.approvalThresholdTokens));
  const [max, setMax] = useState(String(settings.maxGrantTokens));
  const [bulk, setBulk] = useState(String(settings.bulkMaxRecipients));
  const [busy, setBusy] = useState(false);
  const vals = [threshold, max, bulk].map(Number);
  const ok = vals.every((v) => Number.isInteger(v) && v > 0);
  const submit = async () => {
    setBusy(true);
    const done = await act(() => api.post("/console/credits/settings", { approvalThresholdTokens: vals[0], maxGrantTokens: vals[1], bulkMaxRecipients: vals[2] }), "Limits saved");
    setBusy(false);
    if (done) onDone();
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title="Grant limits"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={() => void submit()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Needs approval above (tokens)" hint="For one grant, or the total of a bulk grant.">
          <Input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value.replace(/[^\d]/g, ""))} />
        </Field>
        <Field label="Largest single grant (tokens)">
          <Input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/[^\d]/g, ""))} />
        </Field>
        <Field label="Most people in one bulk grant">
          <Input inputMode="numeric" value={bulk} onChange={(e) => setBulk(e.target.value.replace(/[^\d]/g, ""))} />
        </Field>
      </div>
    </Drawer>
  );
}
