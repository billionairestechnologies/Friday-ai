import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Building2, Handshake, KanbanSquare, Mail, Phone, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCan } from "../access";
import { useStaffOptions } from "../useStaff";
import { Avatar, Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Textarea, act, formatDate, formatMoney, statusTone, timeAgo, useResource } from "../ui";

type Stage = { id: string; name: string; position: number; outcome: "open" | "won" | "lost"; color: string };
type Contact = {
  id: string;
  kind: "lead" | "client";
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string;
  stage_id: string;
  owner_id: string | null;
  owner: { name: string } | null;
  value: number;
  currency: string;
  tags: string[];
  notes: string;
  user_id: string | null;
  last_activity_at: string;
};
type Activity = { id: string; kind: string; body: string; author: { name: string } | null; created_at: string };
type Board = { stages: Stage[]; contacts: Contact[]; summary: { stageId: string; count: number; value: number }[] };

export default function Crm() {
  const [view, setView] = useState<"board" | "table">("board");
  const [kind, setKind] = useState<"" | "lead" | "client">("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [stagesOpen, setStagesOpen] = useState(false);
  const canManage = useCan("crm.manage");
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams({ ...(kind ? { kind } : {}), ...(query ? { q: query } : {}) });
  const board = useResource<Board>(`/console/crm?${params}`);

  async function move(contactId: string, stageId: string) {
    const prev = board.data;
    if (!prev) return;
    // Optimistic: the card lands in its new column instantly.
    board.setData({ ...prev, contacts: prev.contacts.map((c) => (c.id === contactId ? { ...c, stage_id: stageId } : c)) });
    const ok = await act(() => api.patch(`/console/crm/contacts/${contactId}`, { stageId }));
    if (!ok) board.setData(prev);
    else void board.reload();
  }

  const totalOpen = board.data?.summary.reduce((n, s) => n + (board.data!.stages.find((x) => x.id === s.stageId)?.outcome === "open" ? s.value : 0), 0) ?? 0;

  return (
    <>
      <PageHeader
        title="CRM"
        description={board.data ? `${board.data.contacts.length} contacts · ${formatMoney(totalOpen)} in open pipeline` : "Leads, clients and your sales pipeline."}
        actions={
          <>
            {canManage && <Button variant="ghost" onClick={() => setStagesOpen(true)}><Settings2 className="size-4" /> Stages</Button>}
            {canManage && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" /> New contact</Button>}
          </>
        }
      />
      <ErrorNote error={board.error} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented value={view} onChange={setView} options={[{ value: "board", label: "Board" }, { value: "table", label: "Table" }]} />
        <Segmented value={kind} onChange={setKind} options={[{ value: "", label: "All" }, { value: "lead", label: "Leads" }, { value: "client", label: "Clients" }]} />
        <label className="ml-auto flex h-9 min-w-[220px] items-center gap-2 rounded-full border border-border bg-background px-3 text-muted">
          <Search className="size-3.5" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, company" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle" />
        </label>
      </div>
      {board.loading && !board.data ? (
        <Loading />
      ) : !board.data ? null : board.data.contacts.length === 0 && !query ? (
        <EmptyState icon={Handshake} title="No contacts yet" text="Add your first lead — every call, email and meeting lands on their timeline." action={canManage && <Button variant="primary" onClick={() => setCreating(true)}>Add a lead</Button>} />
      ) : view === "board" ? (
        <div className="scroll-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-3">
          {board.data.stages.map((stage) => {
            const cards = board.data!.contacts.filter((c) => c.stage_id === stage.id);
            const value = cards.reduce((n, c) => n + Number(c.value), 0);
            return (
              <div
                key={stage.id}
                className="flex w-72 shrink-0 flex-col rounded-[var(--radius-xl)] border border-border bg-surface/60"
                onDragOver={(e) => canManage && e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData("text/contact");
                  if (id) void move(id, stage.id);
                }}
              >
                <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
                  <span className="size-2 rounded-full" style={{ background: stage.color }} />
                  <span className="text-sm font-semibold">{stage.name}</span>
                  <span className="text-xs text-subtle tabular-nums">{cards.length}</span>
                  <span className="ml-auto text-xs text-subtle tabular-nums">{formatMoney(value)}</span>
                </div>
                <div className="flex min-h-24 flex-col gap-2 px-2.5 pb-2.5">
                  {cards.map((c) => (
                    <motion.div layout key={c.id} transition={{ duration: 0.2 }}>
                    <button
                      type="button"
                      draggable={canManage}
                      onDragStart={(e) => e.dataTransfer.setData("text/contact", c.id)}
                      onClick={() => setOpenId(c.id)}
                      className="w-full cursor-grab rounded-2xl border border-border bg-background p-3 text-left shadow-[var(--shadow-soft)] transition-colors hover:border-[color-mix(in_oklab,var(--color-foreground)_25%,var(--color-border))] active:cursor-grabbing"
                    >
                      <div className="flex items-center gap-2">
                        <Avatar name={c.name} size={24} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                        {c.kind === "client" && <Badge tone="green">client</Badge>}
                      </div>
                      {c.company && <div className="mt-1.5 flex items-center gap-1 truncate text-xs text-muted"><Building2 className="size-3" /> {c.company}</div>}
                      <div className="mt-2 flex items-center gap-2 text-[11px] text-subtle">
                        <span className="font-semibold text-foreground tabular-nums">{formatMoney(Number(c.value), c.currency)}</span>
                        <span className="ml-auto">{timeAgo(c.last_activity_at)}</span>
                      </div>
                    </button>
                    </motion.div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Card pad={false} className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-border text-left text-xs text-subtle">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Stage</th>
                <th className="px-4 py-3 font-medium">Owner</th>
                <th className="px-4 py-3 text-right font-medium">Value</th>
                <th className="px-4 py-3 font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {board.data.contacts.map((c) => {
                const stage = board.data!.stages.find((s) => s.id === c.stage_id);
                return (
                  <tr key={c.id} onClick={() => setOpenId(c.id)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-chip/40">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2"><Avatar name={c.name} size={24} /><span className="font-medium">{c.name}</span><Badge tone={statusTone(c.kind)}>{c.kind}</Badge></div>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{c.company ?? "—"}</td>
                    <td className="px-4 py-2.5"><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: stage?.color }} />{stage?.name}</span></td>
                    <td className="px-4 py-2.5 text-muted">{c.owner?.name ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatMoney(Number(c.value), c.currency)}</td>
                    <td className="px-4 py-2.5 text-muted">{timeAgo(c.last_activity_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <ContactDrawer id={openId} stages={board.data?.stages ?? []} onClose={() => setOpenId(null)} onChanged={() => void board.reload()} />
      <ContactForm open={creating} stages={board.data?.stages ?? []} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void board.reload(); }} />
      <StagesModal open={stagesOpen} stages={board.data?.stages ?? []} onClose={() => setStagesOpen(false)} onChanged={() => void board.reload()} />
    </>
  );
}

type ContactDraft = { name: string; email: string; phone: string; company: string; source: string; stageId: string; kind: "lead" | "client"; value: string; currency: string; tags: string; ownerId: string; notes: string };

function draftFrom(c?: Partial<Contact>, stages: Stage[] = []): ContactDraft {
  return {
    name: c?.name ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    company: c?.company ?? "",
    source: c?.source ?? "",
    stageId: c?.stage_id ?? stages[0]?.id ?? "new",
    kind: c?.kind ?? "lead",
    value: String(c?.value ?? 0),
    currency: c?.currency ?? "INR",
    tags: (c?.tags ?? []).join(", "),
    ownerId: c?.owner_id ?? "",
    notes: c?.notes ?? "",
  };
}

function toPayload(d: ContactDraft) {
  return {
    name: d.name,
    email: d.email || null,
    phone: d.phone || null,
    company: d.company || null,
    source: d.source,
    stageId: d.stageId,
    kind: d.kind,
    value: Number(d.value) || 0,
    currency: d.currency.toUpperCase(),
    tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
    ownerId: d.ownerId || null,
    notes: d.notes,
  };
}

function ContactFields({ draft, setDraft, stages }: { draft: ContactDraft; setDraft: (d: ContactDraft) => void; stages: Stage[] }) {
  const staff = useStaffOptions();
  const set = (k: keyof ContactDraft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  return (
    <div className="grid gap-3">
      <Field label="Name"><Input value={draft.name} onChange={set("name")} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email"><Input type="email" value={draft.email} onChange={set("email")} /></Field>
        <Field label="Phone"><Input value={draft.phone} onChange={set("phone")} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Company"><Input value={draft.company} onChange={set("company")} /></Field>
        <Field label="Source" hint="Website, referral, event…"><Input value={draft.source} onChange={set("source")} /></Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Stage"><Select value={draft.stageId} onChange={set("stageId")} options={stages.map((s) => ({ value: s.id, label: s.name }))} /></Field>
        <Field label="Type"><Select value={draft.kind} onChange={set("kind")} options={[{ value: "lead", label: "Lead" }, { value: "client", label: "Client" }]} /></Field>
        <Field label="Owner"><Select value={draft.ownerId} onChange={set("ownerId")} options={[{ value: "", label: "Unassigned" }, ...staff.map((s) => ({ value: s.userId, label: s.name }))]} /></Field>
      </div>
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <Field label="Deal value"><Input type="number" min={0} value={draft.value} onChange={set("value")} /></Field>
        <Field label="Currency"><Input value={draft.currency} maxLength={3} onChange={set("currency")} /></Field>
      </div>
      <Field label="Tags" hint="Comma separated"><Input value={draft.tags} onChange={set("tags")} /></Field>
      <Field label="Notes"><Textarea value={draft.notes} onChange={set("notes")} /></Field>
    </div>
  );
}

function ContactForm({ open, stages, onClose, onSaved }: { open: boolean; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(draftFrom(undefined, stages));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setDraft(draftFrom(undefined, stages));
  }, [open, stages]);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New contact"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!draft.name.trim()} onClick={async () => { setBusy(true); const ok = await act(() => api.post("/console/crm/contacts", toPayload(draft)), "Contact added"); setBusy(false); if (ok) onSaved(); }}>
            Add contact
          </Button>
        </>
      }
    >
      <ContactFields draft={draft} setDraft={setDraft} stages={stages} />
    </Drawer>
  );
}

function ContactDrawer({ id, stages, onClose, onChanged }: { id: string | null; stages: Stage[]; onClose: () => void; onChanged: () => void }) {
  const { data, reload } = useResource<{ contact: Contact & { activities: Activity[]; account: { plan: string; createdAt: string } | null } }>(id ? `/console/crm/contacts/${id}` : null);
  const canManage = useCan("crm.manage");
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [note, setNote] = useState("");
  const [noteKind, setNoteKind] = useState("note");
  const [busy, setBusy] = useState(false);
  const contact = id && data?.contact.id === id ? data.contact : null;
  useEffect(() => {
    setDraft(contact ? draftFrom(contact, stages) : null);
  }, [contact, stages]);
  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      width={640}
      title={contact ? contact.name : "Loading…"}
      subtitle={contact && <span className="inline-flex items-center gap-2">{contact.company ?? "No company"}{contact.account && <Badge tone="blue">Friday {contact.account.plan}</Badge>}</span>}
      footer={
        canManage && contact && draft ? (
          <>
            <Button variant="danger" onClick={async () => { if (window.confirm(`Delete ${contact.name}?`) && (await act(() => api.delete(`/console/crm/contacts/${contact.id}`), "Deleted"))) { onChanged(); onClose(); } }}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
            <span className="flex-1" />
            <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); const ok = await act(() => api.patch(`/console/crm/contacts/${contact.id}`, toPayload(draft)), "Saved"); setBusy(false); if (ok) { onChanged(); void reload(); } }}>
              Save changes
            </Button>
          </>
        ) : undefined
      }
    >
      {!contact || !draft ? (
        <Loading />
      ) : (
        <div className="grid gap-6">
          <div className="flex flex-wrap gap-2 text-xs">
            {contact.email && <a href={`mailto:${contact.email}`} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-chip px-3 text-foreground hover:bg-chip-on"><Mail className="size-3.5" /> {contact.email}</a>}
            {contact.phone && <a href={`tel:${contact.phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-chip px-3 text-foreground hover:bg-chip-on"><Phone className="size-3.5" /> {contact.phone}</a>}
          </div>
          {canManage ? <ContactFields draft={draft} setDraft={setDraft} stages={stages} /> : <p className="text-sm whitespace-pre-wrap text-muted">{contact.notes || "No notes."}</p>}
          <div>
            <div className="mb-3 text-sm font-semibold">Timeline</div>
            {canManage && (
              <div className="mb-4 rounded-2xl border border-border p-3">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Log a note, call, email or meeting…" className="min-h-[64px] border-0 px-0 focus:shadow-none" />
                <div className="mt-2 flex items-center gap-2">
                  <Segmented value={noteKind} onChange={setNoteKind} options={["note", "call", "email", "meeting"].map((k) => ({ value: k, label: k[0]!.toUpperCase() + k.slice(1) }))} />
                  <Button size="sm" variant="primary" className="ml-auto" disabled={!note.trim()} onClick={async () => { if (await act(() => api.post(`/console/crm/contacts/${contact.id}/activities`, { kind: noteKind, body: note }))) { setNote(""); void reload(); onChanged(); } }}>
                    Log
                  </Button>
                </div>
              </div>
            )}
            <ol className="relative space-y-3 border-l border-border pl-5">
              {contact.activities.map((a) => (
                <li key={a.id} className="relative">
                  <span className={cn("absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-background", a.kind === "stage_change" ? "bg-purple-400" : a.kind === "system" ? "bg-subtle" : "bg-[#4f8cff]")} />
                  <div className="text-[11px] text-subtle">
                    <span className="font-semibold text-muted capitalize">{a.kind.replace("_", " ")}</span> · {a.author?.name ?? "System"} · {formatDate(a.created_at)}
                  </div>
                  <div className="mt-0.5 text-sm whitespace-pre-wrap text-foreground">{a.body}</div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function StagesModal({ open, stages, onClose, onChanged }: { open: boolean; stages: Stage[]; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Stage[]>(stages);
  useEffect(() => {
    if (open) setRows(stages);
  }, [open, stages]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pipeline stages"
      footer={
        <>
          <Button variant="ghost" onClick={() => setRows([...rows, { id: `stage-${rows.length + 1}`, name: "New stage", position: rows.length, outcome: "open", color: "#8a8f98" }])}><Plus className="size-4" /> Add stage</Button>
          <Button
            variant="primary"
            onClick={async () => {
              const ok = await act(async () => {
                for (const [i, r] of rows.entries()) await api.post("/console/crm/stages", { ...r, position: i });
              }, "Stages saved");
              if (ok) { onChanged(); onClose(); }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        {rows.map((r, i) => (
          <div key={r.id} className="grid grid-cols-[36px_1fr_110px_32px] items-center gap-2">
            <input type="color" value={r.color} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} className="h-9 w-9 cursor-pointer rounded-lg border border-border bg-transparent" />
            <Input value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <Select value={r.outcome} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, outcome: e.target.value as Stage["outcome"] } : x)))} options={[{ value: "open", label: "Open" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }]} />
            <button
              type="button"
              aria-label="Remove stage"
              className="flex size-8 items-center justify-center rounded-lg text-subtle hover:bg-chip hover:text-danger"
              onClick={async () => {
                if (stages.some((s) => s.id === r.id) && !(await act(() => api.delete(`/console/crm/stages/${r.id}`)))) return;
                setRows(rows.filter((_, j) => j !== i));
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-subtle"><KanbanSquare className="size-3.5" /> Moving a lead into a “Won” stage turns it into a client.</p>
    </Modal>
  );
}
