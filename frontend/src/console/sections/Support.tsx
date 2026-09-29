import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Inbox, Lock, Plus, Search, Send } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCan, useConsole } from "../access";
import { useStaffOptions } from "../useStaff";
import { Avatar, Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Textarea, Toggle, act, formatDate, statusTone, timeAgo, useResource } from "../ui";

type Ticket = {
  id: string;
  number: number;
  email: string;
  name: string;
  subject: string;
  status: "open" | "pending" | "resolved" | "closed";
  priority: string;
  category: string;
  channel: string;
  assignee_id: string | null;
  assignee: { name: string } | null;
  last_message_at: string;
  created_at: string;
};
type Message = { id: string; author_type: "user" | "staff" | "system"; author: { name: string } | null; body: string; internal: boolean; created_at: string };
type TicketDetail = Ticket & { messages: Message[]; account: { plan: string; createdAt: string } | null };

const STATUS_FILTERS = ["active", "open", "pending", "resolved", "closed"] as const;

export default function Support() {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("active");
  const [assignee, setAssignee] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams({ status, ...(assignee ? { assignee } : {}), ...(query ? { q: query } : {}) });
  const list = useResource<{ tickets: Ticket[]; stats: Record<string, number> }>(`/console/support?${params}`);
  const canReply = useCan("support.reply");

  return (
    <>
      <PageHeader
        title="Support"
        description="Every conversation with users — from the app, the web and email."
        actions={canReply && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" /> New ticket</Button>}
      />
      <ErrorNote error={list.error} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          value={status}
          onChange={setStatus}
          options={STATUS_FILTERS.map((s) => ({ value: s, label: s === "active" ? "Active" : s[0]!.toUpperCase() + s.slice(1), count: s === "active" ? (list.data?.stats.open ?? 0) + (list.data?.stats.pending ?? 0) : list.data?.stats[s] }))}
        />
        <Segmented value={assignee} onChange={setAssignee} options={[{ value: "", label: "Everyone" }, { value: "me", label: "Mine" }, { value: "none", label: "Unassigned", count: list.data?.stats.unassigned }]} />
        <label className="ml-auto flex h-9 min-w-[220px] items-center gap-2 rounded-full border border-border bg-background px-3 text-muted">
          <Search className="size-3.5" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject, email or #number" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle" />
        </label>
      </div>
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Card pad={false} className="max-h-[calc(100dvh-240px)] min-h-[420px] overflow-y-auto">
          {list.loading && !list.data ? (
            <Loading />
          ) : !list.data?.tickets.length ? (
            <div className="p-4"><EmptyState icon={Inbox} title="Inbox zero" text="No tickets match these filters." /></div>
          ) : (
            <ul>
              {list.data.tickets.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(t.id)}
                    className={cn("flex w-full flex-col gap-1 border-b border-border/60 px-4 py-3 text-left transition-colors duration-150", selected === t.id ? "bg-chip-on" : "hover:bg-chip/60")}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-subtle tabular-nums">#{t.number}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t.subject}</span>
                      <span className="shrink-0 text-[11px] text-subtle">{timeAgo(t.last_message_at)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">{t.name || t.email}</span>
                      {t.priority !== "normal" && <Badge tone={statusTone(t.priority)}>{t.priority}</Badge>}
                      <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <AnimatePresence mode="wait">
          {selected ? (
            <motion.div key={selected} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <TicketPane id={selected} onChanged={() => void list.reload()} />
            </motion.div>
          ) : (
            <Card className="flex min-h-[420px] items-center justify-center">
              <div className="text-center text-sm text-muted">
                <Inbox className="mx-auto mb-2 size-6" /> Pick a ticket to read the conversation.
              </div>
            </Card>
          )}
        </AnimatePresence>
      </div>
      <NewTicketModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelected(id); void list.reload(); }} />
    </>
  );
}

function TicketPane({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, loading, setData } = useResource<{ ticket: TicketDetail }>(`/console/support/${id}`);
  const staff = useStaffOptions();
  const me = useConsole((s) => s.me);
  const canReply = useCan("support.reply");
  const canManage = useCan("support.manage");
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const ticket = data?.ticket;
  const messages = useMemo(() => ticket?.messages ?? [], [ticket]);

  async function patch(update: Record<string, unknown>) {
    await act(async () => {
      const res = await api.patch<{ ticket: TicketDetail }>(`/console/support/${id}`, update);
      setData({ ticket: res.ticket });
      onChanged();
    });
  }

  async function send() {
    if (!body.trim()) return;
    setSending(true);
    const ok = await act(async () => {
      const res = await api.post<{ ticket: TicketDetail }>(`/console/support/${id}/reply`, { body, internal });
      setData({ ticket: res.ticket });
      onChanged();
    }, internal ? "Note added" : "Reply sent");
    setSending(false);
    if (ok) setBody("");
  }

  if (loading && !ticket) return <Card><Loading /></Card>;
  if (!ticket) return null;
  return (
    <Card pad={false} className="flex max-h-[calc(100dvh-240px)] min-h-[420px] flex-col">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-subtle">#{ticket.number} · via {ticket.channel} · opened {formatDate(ticket.created_at)}</div>
            <h2 className="mt-0.5 truncate text-base font-semibold">{ticket.subject}</h2>
            <div className="mt-1 text-xs text-muted">
              {ticket.name || "Unknown"} · {ticket.email}
              {ticket.account && <> · <Badge tone="blue">{ticket.account.plan}</Badge></>}
            </div>
          </div>
        </div>
        {canManage && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Select value={ticket.status} onChange={(e) => void patch({ status: e.target.value })} options={["open", "pending", "resolved", "closed"].map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))} />
            <Select value={ticket.priority} onChange={(e) => void patch({ priority: e.target.value })} options={["low", "normal", "high", "urgent"].map((s) => ({ value: s, label: `${s[0]!.toUpperCase()}${s.slice(1)} priority` }))} />
            <Select
              value={ticket.assignee_id ?? ""}
              onChange={(e) => void patch({ assigneeId: e.target.value || null })}
              options={[{ value: "", label: "Unassigned" }, ...staff.map((s) => ({ value: s.userId, label: s.userId === me?.staff.userId ? `${s.name} (me)` : s.name }))]}
            />
          </div>
        )}
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages.map((m) =>
          m.author_type === "system" ? (
            <div key={m.id} className="text-center text-[11px] text-subtle">{m.body} · {timeAgo(m.created_at)}</div>
          ) : (
            <div key={m.id} className={cn("flex gap-2.5", m.author_type === "staff" && "flex-row-reverse")}>
              <Avatar name={m.author_type === "user" ? ticket.name || ticket.email : m.author?.name ?? "Team"} />
              <div className={cn("max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm", m.internal ? "border border-dashed border-amber-500/40 bg-amber-500/10" : m.author_type === "staff" ? "bg-chip-on" : "bg-chip")}>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] text-subtle">
                  {m.internal && <Lock className="size-3 text-amber-300" />}
                  {m.author_type === "user" ? ticket.name || ticket.email : m.author?.name ?? "Team"} · {timeAgo(m.created_at)}
                </div>
                <div className="whitespace-pre-wrap text-foreground">{m.body}</div>
              </div>
            </div>
          ),
        )}
      </div>
      {canReply && (
        <div className="border-t border-border p-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={internal ? "Internal note — only the team sees this" : `Reply to ${ticket.name || ticket.email}… (emailed to them)`}
            className={cn("min-h-[84px]", internal && "border-amber-500/40")}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <Toggle checked={internal} onChange={setInternal} label="Internal note" />
            <span className="ml-auto hidden text-[11px] text-subtle sm:inline">⌘/Ctrl + Enter</span>
            <Button variant="primary" onClick={() => void send()} loading={sending} disabled={!body.trim()}>
              <Send className="size-3.5" /> {internal ? "Add note" : "Send reply"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function NewTicketModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ email: "", name: "", subject: "", body: "" });
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New ticket"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await act(async () => {
                const res = await api.post<{ ticket: { id: string } }>("/console/support", form);
                setForm({ email: "", name: "", subject: "", body: "" });
                onCreated(res.ticket.id);
              }, "Ticket created");
              setBusy(false);
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer email"><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" /></Field>
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        </div>
        <Field label="Subject"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
        <Field label="What they said"><Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
