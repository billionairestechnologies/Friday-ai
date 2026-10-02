import { useState } from "react";
import { Copy, Globe, KeyRound, MailPlus, Plus, Server, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useStaffOptions } from "../useStaff";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Select, Stat, act, toast, useResource } from "../ui";

/**
 * Mail hosting (Team Console, admin): the company's own email on our mail server. Add a domain, put
 * the DNS records it shows at your DNS provider, then create name@company.com for each employee —
 * it appears in their Mailbox and works in Gmail's app, Outlook and phones too.
 */

type Domain = { id: string; domain: string; description: string; created_at: string };
type Mailbox = {
  id: string;
  address: string;
  display_name: string;
  owner_user_id: string | null;
  quota_mb: number;
  status: "active" | "disabled";
  created_at: string;
  mail_domains: { domain: string } | null;
};
type Overview = {
  configured: boolean;
  serverHost: string;
  domains: Domain[];
  mailboxes: Mailbox[];
  usage: Record<string, { bytes: number; messages: number; active: boolean }>;
};
type DnsRecord = { type: string; name: string; value: string; priority?: number; why: string };
type Settings = {
  email: string;
  username: string;
  incoming: { host: string; port: number; security: string };
  outgoing: { host: string; port: number; security: string; altPort: number; altSecurity: string };
  webmail: string | null;
};

const gb = (bytes: number) => (bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => toast.ok("Copied"));

export default function MailHosting() {
  const data = useResource<Overview>("/console/mail-hosting");
  const staff = useStaffOptions();
  const [addingDomain, setAddingDomain] = useState(false);
  const [dnsFor, setDnsFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [created, setCreated] = useState<{ password: string; settings: Settings } | null>(null);
  const ownerName = (id: string | null) => (id ? (staff.find((s) => s.userId === id)?.name ?? "Teammate") : "—");
  const d = data.data;

  if (data.loading && !d) return <Loading />;
  const used = d ? Object.values(d.usage).reduce((n, u) => n + u.bytes, 0) : 0;
  return (
    <>
      <PageHeader
        title="Mail hosting"
        description="Company email on our own mail server — create name@yourcompany.com for every employee."
        actions={
          d?.configured && (
            <>
              <Button onClick={() => setAddingDomain(true)}><Globe className="size-4" /> Add domain</Button>
              <Button variant="primary" disabled={!d.domains.length} onClick={() => setCreating(true)}><MailPlus className="size-4" /> New mailbox</Button>
            </>
          )
        }
      />
      <ErrorNote error={data.error} />
      {d && !d.configured ? (
        <Card className="grid gap-2 text-sm">
          <div className="flex items-center gap-2 font-semibold"><Server className="size-4" /> Connect your mail server</div>
          <p className="text-muted">
            Friday manages mailboxes on a <span className="text-foreground">mailcow</span> server you run (open-source: Postfix, Dovecot, spam filter, webmail). Set it up on a VPS with port 25 open, then set
            <span className="font-mono text-foreground"> MAILCOW_URL</span> and <span className="font-mono text-foreground">MAILCOW_API_KEY</span> on the Friday server. Full steps and DNS in
            <span className="font-mono text-foreground"> docs/MAIL_HOSTING.md</span>.
          </p>
        </Card>
      ) : d ? (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Domains" value={d.domains.length} accent="#4f8cff" />
            <Stat label="Mailboxes" value={d.mailboxes.length} hint={`${d.mailboxes.filter((m) => m.status === "disabled").length} disabled`} accent="#34d399" />
            <Stat label="Storage used" value={gb(used)} accent="#ffb547" />
            <Stat label="Mail server" value={<span className="text-base">{d.serverHost || "—"}</span>} accent="#a855f7" />
          </div>
          <Card pad={false}>
            <div className="border-b border-border px-5 py-3 text-sm font-semibold">Domains</div>
            {d.domains.length === 0 ? (
              <EmptyState icon={Globe} title="No domains yet" text="Add your company domain (e.g. billionairestech.com), then add the DNS records it shows." action={<Button variant="primary" onClick={() => setAddingDomain(true)}>Add domain</Button>} />
            ) : (
              d.domains.map((dom) => (
                <div key={dom.id} className="flex items-center gap-3 border-b border-border/60 px-5 py-2.5 last:border-0">
                  <Globe className="size-4 text-subtle" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{dom.domain}</div>
                    <div className="text-xs text-subtle">{d.mailboxes.filter((m) => m.mail_domains?.domain === dom.domain).length} mailboxes{dom.description ? ` · ${dom.description}` : ""}</div>
                  </div>
                  <Button size="sm" onClick={() => setDnsFor(dom.domain)}>DNS records</Button>
                </div>
              ))
            )}
          </Card>
          <Card pad={false}>
            <div className="border-b border-border px-5 py-3 text-sm font-semibold">Mailboxes</div>
            {d.mailboxes.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">No mailboxes yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-subtle">
                  <tr className="border-b border-border">
                    <th className="px-5 py-2 font-medium">Address</th>
                    <th className="px-3 py-2 font-medium">Employee</th>
                    <th className="px-3 py-2 font-medium">Storage</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.mailboxes.map((m) => {
                    const u = d.usage[m.address];
                    return (
                      <tr key={m.id} onClick={() => setEditing(m)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-chip/40">
                        <td className="px-5 py-2.5"><div className="font-medium">{m.address}</div><div className="text-xs text-subtle">{m.display_name}</div></td>
                        <td className="px-3 py-2.5 text-muted">{ownerName(m.owner_user_id)}</td>
                        <td className="px-3 py-2.5 text-muted tabular-nums">
                          {u ? `${gb(u.bytes)} / ${gb(m.quota_mb * 1024 * 1024)}` : `— / ${gb(m.quota_mb * 1024 * 1024)}`}
                          {u && <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-chip"><div className="h-full bg-search" style={{ width: `${Math.min(100, (u.bytes / (m.quota_mb * 1024 * 1024)) * 100)}%` }} /></div>}
                        </td>
                        <td className="px-5 py-2.5"><Badge tone={m.status === "active" ? "green" : "neutral"}>{m.status}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      ) : null}

      <AddDomain open={addingDomain} onClose={() => setAddingDomain(false)} onAdded={(domain) => { setAddingDomain(false); setDnsFor(domain); void data.reload(); }} />
      <DnsDrawer domain={dnsFor} onClose={() => setDnsFor(null)} />
      {d && (
        <CreateMailbox
          open={creating}
          domains={d.domains}
          staff={staff}
          onClose={() => setCreating(false)}
          onCreated={(res) => { setCreating(false); setCreated(res); void data.reload(); }}
        />
      )}
      <EditMailbox mailbox={editing} staff={staff} onClose={() => setEditing(null)} onChanged={(pw) => { if (pw) setCreated(pw); setEditing(null); void data.reload(); }} />
      <Modal open={Boolean(created)} onClose={() => setCreated(null)} title="Mailbox ready" footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        {created && (
          <div className="grid gap-3 text-sm">
            <p className="text-muted">Give these to the employee. <span className="text-foreground">The password is shown only once.</span> It's already linked to their Mailbox in the Console if you picked them as the owner.</p>
            <CopyRow label="Address" value={created.settings.email} />
            <CopyRow label="Password" value={created.password} mono />
            <div className="rounded-lg bg-chip/60 p-3 text-xs leading-relaxed text-muted">
              <div className="mb-1 font-medium text-foreground">For Gmail app, Outlook, Apple Mail, phones</div>
              IMAP {created.settings.incoming.host} · {created.settings.incoming.port} · {created.settings.incoming.security}<br />
              SMTP {created.settings.outgoing.host} · {created.settings.outgoing.port} · {created.settings.outgoing.security} (or {created.settings.outgoing.altPort} {created.settings.outgoing.altSecurity})<br />
              Username: the full address
              {created.settings.webmail && <><br />Browser webmail: {created.settings.webmail}</>}
            </div>
            <Button onClick={() => copy(`Email: ${created.settings.email}\nPassword: ${created.password}\nIMAP: ${created.settings.incoming.host}:${created.settings.incoming.port} SSL/TLS\nSMTP: ${created.settings.outgoing.host}:${created.settings.outgoing.port} SSL/TLS\nUsername: ${created.settings.username}`)}>
              <Copy className="size-3.5" /> Copy everything
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}

function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
      <span className="w-20 text-xs text-subtle">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono")}>{value}</span>
      <button type="button" aria-label={`Copy ${label}`} onClick={() => copy(value)} className="rounded-md p-1 text-subtle hover:bg-chip"><Copy className="size-3.5" /></button>
    </div>
  );
}

function AddDomain({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (domain: string) => void }) {
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a mail domain"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim())} onClick={async () => {
            setBusy(true);
            const ok = await act(() => api.post("/console/mail-hosting/domains", { domain: domain.trim(), description }), "Domain added");
            setBusy(false);
            if (ok) { onAdded(domain.trim().toLowerCase()); setDomain(""); setDescription(""); }
          }}>Add domain</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Domain"><Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.com" autoFocus /></Field>
        <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Main company domain" /></Field>
        <p className="text-xs text-muted">Next you'll see the DNS records (MX, SPF, DKIM, DMARC) to add at your domain provider. Mail starts arriving once MX points here.</p>
      </div>
    </Modal>
  );
}

function DnsDrawer({ domain, onClose }: { domain: string | null; onClose: () => void }) {
  const dns = useResource<{ dns: DnsRecord[] }>(domain ? `/console/mail-hosting/domains/${encodeURIComponent(domain)}/dns` : null);
  return (
    <Drawer open={Boolean(domain)} onClose={onClose} width={720} title={`DNS for ${domain ?? ""}`} subtitle="Add these at your domain provider (GoDaddy, Cloudflare, Hostinger…)">
      {dns.loading && !dns.data ? (
        <Loading />
      ) : (
        <div className="grid gap-2">
          <ErrorNote error={dns.error} />
          {(dns.data?.dns ?? []).map((r) => (
            <Card key={`${r.type}${r.name}`} className="grid gap-1.5 py-3">
              <div className="flex items-center gap-2">
                <Badge tone="blue">{r.type}</Badge>
                <span className="font-mono text-xs">{r.name}</span>
                {r.priority != null && <span className="text-xs text-subtle">priority {r.priority}</span>}
                <span className="flex-1" />
                <button type="button" onClick={() => copy(r.value)} className="rounded-md p-1 text-subtle hover:bg-chip" aria-label="Copy value"><Copy className="size-3.5" /></button>
              </div>
              <div className="font-mono text-xs break-all text-foreground">{r.value}</div>
              <div className="text-xs text-muted">{r.why}</div>
            </Card>
          ))}
          <p className="mt-2 text-xs text-muted">Also ask your VPS provider to set the server IP's reverse DNS (PTR) to the mail server's hostname — Gmail and Outlook check it.</p>
        </div>
      )}
    </Drawer>
  );
}

function CreateMailbox({ open, domains, staff, onClose, onCreated }: { open: boolean; domains: Domain[]; staff: { userId: string; name: string; email: string | null }[]; onClose: () => void; onCreated: (r: { password: string; settings: Settings }) => void }) {
  const [form, setForm] = useState({ domainId: "", localPart: "", displayName: "", ownerUserId: "", quotaMb: "5120", password: "" });
  const [busy, setBusy] = useState(false);
  const domainId = form.domainId || domains[0]?.id || "";
  const domain = domains.find((x) => x.id === domainId)?.domain ?? "";
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New mailbox"
      footer={
        <>
          <span className="flex-1" />
          <Button variant="primary" loading={busy} disabled={!form.localPart || !domainId} onClick={async () => {
            setBusy(true);
            try {
              const res = await api.post<{ password: string; settings: Settings }>("/console/mail-hosting/mailboxes", {
                domainId, localPart: form.localPart.trim().toLowerCase(), displayName: form.displayName.trim(), ownerUserId: form.ownerUserId || null,
                quotaMb: Number(form.quotaMb), password: form.password || undefined,
              });
              setForm({ domainId: "", localPart: "", displayName: "", ownerUserId: "", quotaMb: "5120", password: "" });
              onCreated(res);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Couldn't create the mailbox");
            } finally {
              setBusy(false);
            }
          }}><Plus className="size-4" /> Create mailbox</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Employee (owner)" hint="Links the mailbox to their Mailbox in the Console">
          <Select
            value={form.ownerUserId}
            onChange={(e) => {
              const s = staff.find((x) => x.userId === e.target.value);
              setForm({ ...form, ownerUserId: e.target.value, displayName: form.displayName || s?.name || "", localPart: form.localPart || (s?.name ?? "").toLowerCase().trim().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, "") || "" });
            }}
            options={[{ value: "", label: "No owner (shared mailbox, e.g. info@)" }, ...staff.map((s) => ({ value: s.userId, label: `${s.name}${s.email ? ` · ${s.email}` : ""}` }))]}
          />
        </Field>
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <Field label="Name before @"><Input value={form.localPart} onChange={(e) => setForm({ ...form, localPart: e.target.value })} placeholder="parth" /></Field>
          <span className="pb-2.5 text-muted">@</span>
          <Field label="Domain"><Select value={domainId} onChange={(e) => setForm({ ...form, domainId: e.target.value })} options={domains.map((x) => ({ value: x.id, label: x.domain }))} /></Field>
        </div>
        {form.localPart && <p className="-mt-1 text-xs text-muted">Address: <span className="font-mono text-foreground">{form.localPart.trim().toLowerCase()}@{domain}</span></p>}
        <Field label="Display name"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Parth Rathod" /></Field>
        <Field label="Storage"><Select value={form.quotaMb} onChange={(e) => setForm({ ...form, quotaMb: e.target.value })} options={[["1024", "1 GB"], ["5120", "5 GB"], ["10240", "10 GB"], ["25600", "25 GB"], ["51200", "50 GB"]].map(([value, label]) => ({ value: value!, label: label! }))} /></Field>
        <Field label="Password" hint="Leave empty to generate a strong one (shown once)"><Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></Field>
      </div>
    </Drawer>
  );
}

function EditMailbox({ mailbox, staff, onClose, onChanged }: { mailbox: Mailbox | null; staff: { userId: string; name: string }[]; onClose: () => void; onChanged: (pw?: { password: string; settings: Settings }) => void }) {
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  if (!mailbox) return null;
  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      const res = await api.patch<{ password: string | null; settings: Settings }>(`/console/mail-hosting/mailboxes/${mailbox.id}`, body);
      toast.ok(msg);
      if (res.password) onChanged({ password: res.password, settings: res.settings });
      else onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the mailbox");
    }
  };
  return (
    <Drawer open onClose={onClose} title={mailbox.address} subtitle={mailbox.display_name}>
      <div className="grid gap-4">
        <Field label="Employee (owner)">
          <Select value={mailbox.owner_user_id ?? ""} onChange={(e) => void patch({ ownerUserId: e.target.value || null }, "Owner updated")} options={[{ value: "", label: "No owner (shared)" }, ...staff.map((s) => ({ value: s.userId, label: s.name }))]} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void patch({ password: "" }, "Password reset")}><KeyRound className="size-3.5" /> Reset password</Button>
          {mailbox.status === "active" ? (
            <Button onClick={() => void patch({ status: "disabled" }, "Mailbox disabled — it can't sign in or receive mail")}>Disable</Button>
          ) : (
            <Button onClick={() => void patch({ status: "active" }, "Mailbox enabled")}>Enable</Button>
          )}
        </div>
        <Card className="grid gap-2 border-danger/30">
          <div className="text-sm font-semibold text-danger">Delete mailbox</div>
          <p className="text-xs text-muted">Deletes the address and every email in it from the server. This can't be undone — disable it instead if the employee might come back.</p>
          {deleting ? (
            <>
              <Field label={`Type ${mailbox.address} to confirm`}><Input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
              <Button variant="danger" disabled={confirm !== mailbox.address} onClick={async () => { if (await act(() => api.delete(`/console/mail-hosting/mailboxes/${mailbox.id}`), "Mailbox deleted")) { setConfirm(""); setDeleting(false); onChanged(); } }}>
                <Trash2 className="size-3.5" /> Delete for good
              </Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setDeleting(true)}>Delete…</Button>
          )}
        </Card>
      </div>
    </Drawer>
  );
}
