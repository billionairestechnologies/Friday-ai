import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Clock, FlaskConical, Mail, Plus, Send, Trash2, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Markdown } from "@/lib/chat/markdown";
import { useCan, useConsole } from "../access";
import { AUDIENCES } from "./Updates";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Select, Textarea, act, formatDate, formatNumber, fromLocalInput, statusTone, toLocalInput, useResource } from "../ui";

type Campaign = {
  id: string;
  name: string;
  subject: string;
  preheader: string;
  body_markdown: string;
  cta_label: string | null;
  cta_url: string | null;
  audience: string;
  from_identity_id: string | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "failed";
  scheduled_at: string | null;
  sent_at: string | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  last_error: string | null;
  created_at: string;
};
type Identity = { id: string; address: string; display_name: string; purpose: string };

export default function Marketing() {
  const list = useResource<{ campaigns: Campaign[] }>("/console/campaigns");
  const [open, setOpen] = useState<string | "new" | null>(null);
  const canManage = useCan("marketing.manage");
  const mailConfigured = useConsole((s) => s.me?.mailConfigured);
  const sending = list.data?.campaigns.some((c) => c.status === "sending" || c.status === "scheduled");

  // Live progress while a send is running.
  useEffect(() => {
    if (!sending) return;
    const t = window.setInterval(() => void list.reload(), 4000);
    return () => window.clearInterval(t);
  }, [sending, list]);

  return (
    <>
      <PageHeader
        title="Email campaigns"
        description="Announce features, offers and news to your users by email. Unsubscribes are honoured automatically."
        actions={canManage && <Button variant="primary" onClick={() => setOpen("new")}><Plus className="size-4" /> New campaign</Button>}
      />
      {!mailConfigured && <ErrorNote error="Email isn't configured yet — set RESEND_API_KEY on the server to send campaigns." />}
      <ErrorNote error={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.campaigns.length ? (
        <EmptyState icon={Mail} title="No campaigns yet" text="Write once in Markdown, preview it, send a test to yourself, then send or schedule." action={canManage && <Button variant="primary" onClick={() => setOpen("new")}>Write a campaign</Button>} />
      ) : (
        <Card pad={false} className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-b border-border text-left text-xs text-subtle">
              <tr>
                <th className="px-4 py-3 font-medium">Campaign</th>
                <th className="px-4 py-3 font-medium">Audience</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Delivery</th>
                <th className="px-4 py-3 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {list.data.campaigns.map((c) => {
                const pct = c.total_recipients ? Math.round((c.sent_count / c.total_recipients) * 100) : 0;
                return (
                  <tr key={c.id} onClick={() => setOpen(c.id)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-chip/40">
                    <td className="px-4 py-3">
                      <div className="font-medium">{c.name}</div>
                      <div className="truncate text-xs text-muted">{c.subject || "No subject yet"}</div>
                    </td>
                    <td className="px-4 py-3 text-muted">{AUDIENCES.find((a) => a.value === c.audience)?.label.replace(" (incl. new signups)", "")}</td>
                    <td className="px-4 py-3"><Badge tone={statusTone(c.status)}>{c.status}</Badge></td>
                    <td className="px-4 py-3">
                      {c.status === "draft" ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-chip">
                            <motion.div className="h-full rounded-full bg-emerald-400" initial={false} animate={{ width: `${pct}%` }} transition={{ duration: 0.5 }} />
                          </div>
                          <span className="text-xs text-muted tabular-nums">{formatNumber(c.sent_count)}/{formatNumber(c.total_recipients)}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted">{formatDate(c.sent_at ?? c.scheduled_at ?? c.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <Composer id={open} campaigns={list.data?.campaigns ?? []} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />
    </>
  );
}

function Composer({ id, campaigns, onClose, onChanged }: { id: string | "new" | null; campaigns: Campaign[]; onClose: () => void; onChanged: () => void }) {
  const canManage = useCan("marketing.manage");
  const canSend = useCan("marketing.send");
  const me = useConsole((s) => s.me);
  const identities = useResource<{ identities: Identity[] }>(id ? "/console/mail" : null);
  const blank = { name: "", subject: "", preheader: "", bodyMarkdown: "Hi {{first_name}},\n\n", ctaLabel: "", ctaUrl: "", audience: "all", fromIdentityId: "" };
  const [form, setForm] = useState(blank);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const campaign = id && id !== "new" ? campaigns.find((c) => c.id === id) : null;
  const locked = campaign ? campaign.status === "sending" || campaign.status === "sent" : false;

  useEffect(() => {
    if (id === "new") {
      setForm(blank);
      setSavedId(null);
    } else if (campaign) {
      setForm({ name: campaign.name, subject: campaign.subject, preheader: campaign.preheader, bodyMarkdown: campaign.body_markdown, ctaLabel: campaign.cta_label ?? "", ctaUrl: campaign.cta_url ?? "", audience: campaign.audience, fromIdentityId: campaign.from_identity_id ?? "" });
      setSavedId(campaign.id);
      setScheduleAt(toLocalInput(campaign.scheduled_at));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, campaign?.id]);

  useEffect(() => {
    if (!id) return;
    setCount(null);
    api.get<{ count: number }>(`/console/campaigns/audience?audience=${form.audience}`).then((r) => setCount(r.count)).catch(() => setCount(null));
  }, [id, form.audience]);

  const payload = () => ({ ...form, name: form.name || form.subject || "Untitled campaign", ctaLabel: form.ctaLabel || null, ctaUrl: form.ctaUrl || null, fromIdentityId: form.fromIdentityId || null });

  async function save(): Promise<string | null> {
    let current = savedId;
    const ok = await act(async () => {
      if (current) await api.patch(`/console/campaigns/${current}`, payload());
      else {
        const res = await api.post<{ campaign: Campaign }>("/console/campaigns", payload());
        current = res.campaign.id;
        setSavedId(current);
      }
    });
    if (ok) onChanged();
    return ok ? current : null;
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    await fn();
    setBusy(null);
  }

  const personalised = form.bodyMarkdown.replace(/\{\{\s*first_name\s*\}\}/gi, me?.staff.name?.split(/\s+/)[0] ?? "Alex").replace(/\{\{\s*name\s*\}\}/gi, me?.staff.name ?? "Alex Doe");

  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      width={1040}
      title={campaign ? campaign.name : "New campaign"}
      subtitle={campaign && <span className="inline-flex items-center gap-2"><Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>{campaign.last_error && <span className="text-danger">{campaign.last_error}</span>}</span>}
      footer={
        !locked && canManage ? (
          <>
            {savedId && (
              <Button variant="danger" onClick={() => run("delete", async () => { if (window.confirm("Delete this campaign?") && (await act(() => api.delete(`/console/campaigns/${savedId}`), "Deleted"))) { onChanged(); onClose(); } })}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
            {campaign?.status === "scheduled" && canSend && (
              <Button onClick={() => run("cancel", async () => { if (await act(() => api.post(`/console/campaigns/${savedId}/cancel`), "Schedule cancelled")) onChanged(); })} loading={busy === "cancel"}>
                Cancel schedule
              </Button>
            )}
            <span className="flex-1" />
            <Button onClick={() => run("save", async () => { await save(); })} loading={busy === "save"}>Save draft</Button>
            <Button
              onClick={() => run("test", async () => { const cid = await save(); if (cid) await act(() => api.post(`/console/campaigns/${cid}/test`, {}), `Test sent to ${me?.staff.email}`); })}
              loading={busy === "test"}
              disabled={!form.subject.trim()}
            >
              <FlaskConical className="size-3.5" /> Send test to me
            </Button>
            {canSend && (
              <Button variant="primary" onClick={() => setConfirm(true)} disabled={!form.subject.trim() || !form.bodyMarkdown.trim()}>
                <Send className="size-3.5" /> Send…
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_440px]">
        <fieldset disabled={locked || !canManage} className="grid content-start gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Campaign name" hint="Internal only"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="October feature launch" /></Field>
            <Field label="From">
              <Select value={form.fromIdentityId} onChange={(e) => setForm({ ...form, fromIdentityId: e.target.value })} options={[{ value: "", label: "Default sender" }, ...(identities.data?.identities ?? []).map((i) => ({ value: i.id, label: `${i.display_name} <${i.address}>` }))]} />
            </Field>
          </div>
          <Field label="Subject" hint="{{first_name}} works here too"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="{{first_name}}, Build Mode just got a lot smarter" /></Field>
          <Field label="Preview text" hint="The grey line after the subject in the inbox"><Input value={form.preheader} onChange={(e) => setForm({ ...form, preheader: e.target.value })} /></Field>
          <Field label="Message (Markdown)"><Textarea value={form.bodyMarkdown} onChange={(e) => setForm({ ...form, bodyMarkdown: e.target.value })} className="min-h-[240px] font-mono text-[13px]" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Button label"><Input value={form.ctaLabel} onChange={(e) => setForm({ ...form, ctaLabel: e.target.value })} placeholder="Try it now" /></Field>
            <Field label="Button link"><Input value={form.ctaUrl} onChange={(e) => setForm({ ...form, ctaUrl: e.target.value })} placeholder="https://…" /></Field>
          </div>
          <Field label="Audience" hint={<span className="inline-flex items-center gap-1"><Users className="size-3" /> {count == null ? "Counting…" : `${formatNumber(count)} people (opted-out users are excluded)`}</span>}>
            <Select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} options={AUDIENCES} />
          </Field>
          {campaign && campaign.status !== "draft" && (
            <Card className="text-sm">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div><div className="text-xl font-semibold tabular-nums">{formatNumber(campaign.total_recipients)}</div><div className="text-xs text-muted">Recipients</div></div>
                <div><div className="text-xl font-semibold text-emerald-300 tabular-nums">{formatNumber(campaign.sent_count)}</div><div className="text-xs text-muted">Delivered</div></div>
                <div><div className="text-xl font-semibold text-danger tabular-nums">{formatNumber(campaign.failed_count)}</div><div className="text-xs text-muted">Failed</div></div>
              </div>
            </Card>
          )}
        </fieldset>
        <div>
          <div className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">Inbox preview</div>
          <div className="sticky top-0 overflow-hidden rounded-[var(--radius-xl)] border border-border">
            <div className="border-b border-black/5 bg-[#f4f4f2] px-5 py-3 text-[13px] text-[#18181a]">
              <div className="font-semibold">{form.subject.replace(/\{\{\s*first_name\s*\}\}/gi, me?.staff.name?.split(/\s+/)[0] ?? "Alex") || "Subject line"}</div>
              <div className="truncate text-[#6b6b6f]">{form.preheader || "Preview text"}</div>
            </div>
            <div className="max-h-[560px] overflow-y-auto bg-[#f4f4f2] p-4">
              <div className="rounded-2xl border border-[#e8e6e1] bg-white px-6 py-6 text-[#2b2b2e] [&_.md]:text-[#2b2b2e] [&_.md_a]:text-[#1a56db] [&_.md_h1]:text-[#18181a] [&_.md_h2]:text-[#18181a] [&_.md_strong]:text-[#18181a]">
                <div className="mb-5 flex items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-[#18181a] to-[#4a4a4d] text-sm font-extrabold text-white">F</span>
                  <span className="text-lg font-extrabold tracking-tight text-[#18181a]">Friday</span>
                </div>
                <Markdown text={personalised} />
                {form.ctaLabel && <span className="mt-4 inline-block rounded-full bg-[#18181a] px-6 py-3 text-sm font-semibold text-white">{form.ctaLabel}</span>}
                <div className="mt-6 border-t border-[#efeeea] pt-4 text-xs text-[#9a9a9e]">You're getting this because you have a Friday account. · Unsubscribe</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Send this campaign?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
            <Button
              onClick={() => run("schedule", async () => { const cid = await save(); if (cid && scheduleAt && (await act(() => api.post(`/console/campaigns/${cid}/send`, { scheduledAt: fromLocalInput(scheduleAt) }), "Scheduled"))) { setConfirm(false); onChanged(); } })}
              disabled={!scheduleAt}
              loading={busy === "schedule"}
            >
              <Clock className="size-3.5" /> Schedule
            </Button>
            <Button variant="primary" onClick={() => run("send", async () => { const cid = await save(); if (cid && (await act(() => api.post(`/console/campaigns/${cid}/send`, {}), "Sending started"))) { setConfirm(false); onChanged(); } })} loading={busy === "send"}>
              <Send className="size-3.5" /> Send now
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          “{form.subject}” goes to <span className="font-semibold text-foreground">{count == null ? "…" : formatNumber(count)}</span> people ({AUDIENCES.find((a) => a.value === form.audience)?.label}). This can't be undone.
        </p>
        <Field label="Or schedule for later" className="mt-4"><Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} /></Field>
      </Modal>
    </Drawer>
  );
}
