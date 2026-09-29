import { useState } from "react";
import { AtSign, Inbox, Plus, Star, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Select, Toggle, act, useResource } from "../ui";

type Identity = { id: string; address: string; display_name: string; team: string; purpose: string; is_default: boolean };

export default function MailSettings() {
  const data = useResource<{ identities: Identity[]; configured: boolean }>("/console/mail");
  const [form, setForm] = useState({ address: "", displayName: "Friday", team: "", purpose: "general", isDefault: false });
  const [busy, setBusy] = useState(false);
  const inboundUrl = `${window.location.origin}/api/support/inbound`;
  return (
    <>
      <PageHeader title="Team mail" description="The addresses Friday sends from — support@, hello@, sales@… Each purpose uses its own address, and replies come back to the right inbox." />
      {data.data && !data.data.configured && <ErrorNote error="Email sending isn't configured — set RESEND_API_KEY (and verify your domain in Resend) on the server." />}
      <ErrorNote error={data.error} />
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div>
          {data.loading && !data.data ? (
            <Loading />
          ) : !data.data?.identities.length ? (
            <EmptyState icon={AtSign} title="No team addresses yet" text="Add support@yourdomain.com so support replies come from a real team inbox." />
          ) : (
            <div className="grid gap-2">
              {data.data.identities.map((i) => (
                <Card key={i.id} className="flex items-center gap-3 py-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-chip"><AtSign className="size-4 text-muted" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{i.display_name} &lt;{i.address}&gt;</div>
                    <div className="text-xs text-muted">{i.team || "—"}</div>
                  </div>
                  <Badge tone="blue">{i.purpose}</Badge>
                  {i.is_default && <Badge tone="amber"><Star className="size-3" /> default</Badge>}
                  <button type="button" aria-label="Remove" onClick={async () => { if (await act(() => api.delete(`/console/mail/${i.id}`), "Removed")) void data.reload(); }} className="flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-chip hover:text-danger">
                    <Trash2 className="size-3.5" />
                  </button>
                </Card>
              ))}
            </div>
          )}
          <Card className="mt-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Inbox className="size-4 text-muted" /> Receive support email as tickets</div>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
              <li>In your email provider (Resend, Postmark, Mailgun, SendGrid…), enable <span className="text-foreground">inbound email</span> for your support address.</li>
              <li>Point its webhook to <span className="font-mono text-xs text-foreground">{inboundUrl}</span></li>
              <li>Add the header <span className="font-mono text-xs text-foreground">x-friday-inbound-secret</span> with the value of <span className="font-mono text-xs text-foreground">SUPPORT_INBOUND_SECRET</span> from the server environment.</li>
            </ol>
            <p className="mt-2 text-xs text-subtle">New emails open tickets; replies to “[#1234]” threads land on the existing ticket.</p>
          </Card>
        </div>
        <Card className="h-fit">
          <div className="mb-3 text-sm font-semibold">Add an address</div>
          <div className="grid gap-3">
            <Field label="Address" hint="Must be on a domain verified with your email provider"><Input type="email" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="support@yourdomain.com" /></Field>
            <Field label="Sender name"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Friday Support" /></Field>
            <Field label="Used for">
              <Select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} options={[{ value: "general", label: "General & team invites" }, { value: "support", label: "Support replies" }, { value: "marketing", label: "Marketing campaigns" }, { value: "sales", label: "Sales" }]} />
            </Field>
            <Field label="Team" hint="Optional"><Input value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} /></Field>
            <Toggle checked={form.isDefault} onChange={(v) => setForm({ ...form, isDefault: v })} label="Default sender" />
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.address}
              onClick={async () => {
                setBusy(true);
                const ok = await act(() => api.post("/console/mail", form), "Address added");
                setBusy(false);
                if (ok) {
                  setForm({ address: "", displayName: "Friday", team: "", purpose: "general", isDefault: false });
                  void data.reload();
                }
              }}
            >
              <Plus className="size-4" /> Add address
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
