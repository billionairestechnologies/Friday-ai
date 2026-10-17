import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, CheckCircle2, GraduationCap, LifeBuoy, Loader2, MessageSquare, Send, Ticket, X } from "lucide-react";
import { api } from "@/lib/api";
import { useChat } from "@/lib/chat/store";
import { cn } from "@/lib/utils";
import { ProgramsPanel } from "./programs-panel";

/**
 * Help & support, in the app: message the team (lands in the Team Console's support inbox and is
 * answered by a person, by email and here), follow your tickets and reply, and redeem an offer
 * code — student passes, promos, partner deals. Opened from the profile menu's "Help", or from the
 * "View your ticket" link in support emails (?support=<number>).
 */

type TicketRow = { id: string; number: number; subject: string; status: string; created_at: string; last_message_at: string };
type TicketDetail = TicketRow & { messages: { id: string; author_type: "user" | "staff" | "system"; body: string; created_at: string }[] };
type Tab = "contact" | "tickets" | "redeem" | "programs";

const STATUS_STYLE: Record<string, string> = {
  open: "bg-[#4f8cff]/15 text-[#4f8cff]",
  pending: "bg-amber-500/15 text-amber-500",
  resolved: "bg-emerald-500/15 text-emerald-500",
  closed: "bg-chip text-muted",
};

const field =
  "w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition-[border-color] placeholder:text-subtle focus:border-foreground/40";

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
}

export function SupportCenter() {
  const dialog = useChat((s) => s.dialog);
  const setDialog = useChat((s) => s.setDialog);
  const open = dialog === "help";
  const [tab, setTab] = useState<Tab>("contact");
  const [openTicket, setOpenTicket] = useState<string | null>(null);

  // "View your ticket" in a support email links to /?support=<number>.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("support")) return;
    const value = params.get("support") ?? "";
    const number = Number(value);
    params.delete("support");
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    // ?support=contact (from the mobile apps' "Help & support"), ?support=redeem, or a ticket number.
    setTab(value === "contact" || value === "redeem" || value === "programs" ? (value as Tab) : "tickets");
    setDialog("help");
    if (number) {
      api
        .get<{ tickets: TicketRow[] }>("/support/tickets")
        .then((r) => setOpenTicket(r.tickets.find((t) => t.number === number)?.id ?? null))
        .catch(() => {});
    }
  }, [setDialog]);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && setDialog(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content onOpenAutoFocus={(e) => e.preventDefault()} className="fixed top-[50%] left-[50%] z-50 flex max-h-[min(88dvh,720px)] w-[min(94vw,560px)] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-elevated shadow-[var(--shadow-panel)] duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="flex items-start gap-3 px-6 pt-5">
            <span className="flex size-10 items-center justify-center rounded-2xl bg-chip"><LifeBuoy className="size-5" /></span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold tracking-tight">Help & support</Dialog.Title>
              <Dialog.Description className="text-sm text-muted">Real people on the Friday team read every message.</Dialog.Description>
            </div>
            <Dialog.Close className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="mx-6 mt-4 flex rounded-full bg-chip p-0.5">
            {(
              [
                ["contact", "Contact", MessageSquare],
                ["tickets", "Requests", LifeBuoy],
                ["redeem", "Redeem", Ticket],
                ["programs", "Programmes", GraduationCap],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id);
                  setOpenTicket(null);
                }}
                className={cn("relative flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-colors", tab === id ? "text-foreground" : "text-muted hover:text-foreground")}
              >
                {tab === id && <motion.span layoutId="support-tab" className="absolute inset-0 rounded-full bg-background shadow-sm" transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} />}
                <Icon className="relative size-3.5" />
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={`${tab}-${openTicket ?? ""}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
                {tab === "contact" && <ContactForm onSent={() => setTab("tickets")} />}
                {tab === "tickets" && (openTicket ? <TicketThread id={openTicket} onBack={() => setOpenTicket(null)} /> : <TicketList onOpen={setOpenTicket} />)}
                {tab === "redeem" && <RedeemForm />}
                {tab === "programs" && <ProgramsPanel />}
              </motion.div>
            </AnimatePresence>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ContactForm({ onSent }: { onSent: () => void }) {
  const [form, setForm] = useState({ category: "general", subject: "", body: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  if (sent) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }}>
          <CheckCircle2 className="size-12 text-emerald-500" />
        </motion.span>
        <div className="mt-3 text-base font-semibold">Request #{sent} sent</div>
        <p className="mt-1 max-w-xs text-sm text-muted">We emailed you a copy. Replies arrive by email and in “My requests”.</p>
        <button type="button" onClick={onSent} className="mt-5 h-9 rounded-full bg-foreground px-5 text-sm font-medium text-background">View my requests</button>
      </div>
    );
  }
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await api.post<{ ticket: { number: number } }>("/support/tickets", { ...form, platform: "web" });
          setSent(res.ticket.number);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Couldn't send that — try again");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="grid gap-1.5 text-xs font-semibold text-muted">
        What's it about?
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={cn(field, "h-10")}>
          <option value="general">A question</option>
          <option value="bug">Something isn't working</option>
          <option value="billing">Billing & plans</option>
          <option value="account">My account</option>
          <option value="feature">An idea or feature request</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-xs font-semibold text-muted">
        Subject
        <input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} className={cn(field, "h-10")} placeholder="Short summary" />
      </label>
      <label className="grid gap-1.5 text-xs font-semibold text-muted">
        Message
        <textarea required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} className={cn(field, "min-h-[140px] resize-y py-2.5 leading-relaxed")} placeholder="Tell us what happened — steps, what you expected, anything that helps." />
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="submit" disabled={busy || !form.subject.trim() || !form.body.trim()} className="mt-1 flex h-10 items-center justify-center gap-2 rounded-full bg-foreground text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send to the team
      </button>
    </form>
  );
}

function TicketList({ onOpen }: { onOpen: (id: string) => void }) {
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  useEffect(() => {
    api.get<{ tickets: TicketRow[] }>("/support/tickets").then((r) => setTickets(r.tickets)).catch(() => setTickets([]));
  }, []);
  if (!tickets) return <div className="flex justify-center py-10 text-muted"><Loader2 className="size-5 animate-spin" /></div>;
  if (tickets.length === 0) return <p className="py-10 text-center text-sm text-muted">No requests yet — use “Contact us” any time.</p>;
  return (
    <ul className="grid gap-2">
      {tickets.map((t) => (
        <li key={t.id}>
          <button type="button" onClick={() => onOpen(t.id)} className="flex w-full items-center gap-3 rounded-2xl border border-border bg-background px-4 py-3 text-left transition-colors hover:bg-chip">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{t.subject}</div>
              <div className="text-xs text-subtle">#{t.number} · updated {ago(t.last_message_at)}</div>
            </div>
            <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold", STATUS_STYLE[t.status] ?? STATUS_STYLE.closed)}>{t.status}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TicketThread({ id, onBack }: { id: string; onBack: () => void }) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFailed(false);
    api.get<{ ticket: TicketDetail }>(`/support/tickets/${id}`).then((r) => setTicket(r.ticket)).catch(() => setFailed(true));
  }, [id]);
  if (failed) {
    return (
      <div className="py-10 text-center text-sm text-muted">
        Couldn't open that request.
        <button type="button" onClick={onBack} className="mt-3 block w-full text-foreground underline underline-offset-2">Back to all requests</button>
      </div>
    );
  }
  if (!ticket) return <div className="flex justify-center py-10 text-muted"><Loader2 className="size-5 animate-spin" /></div>;
  return (
    <div>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"><ArrowLeft className="size-3.5" /> All requests</button>
      <div className="mb-4 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{ticket.subject}</div>
          <div className="text-xs text-subtle">#{ticket.number}</div>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold", STATUS_STYLE[ticket.status] ?? STATUS_STYLE.closed)}>{ticket.status}</span>
      </div>
      <div className="grid gap-2.5">
        {ticket.messages
          .filter((m) => m.author_type !== "system")
          .map((m) => (
            <div key={m.id} className={cn("max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm", m.author_type === "user" ? "ml-auto bg-chip" : "border border-border bg-background")}>
              <div className="mb-0.5 text-[11px] text-subtle">{m.author_type === "user" ? "You" : "Friday team"} · {ago(m.created_at)}</div>
              <div className="whitespace-pre-wrap">{m.body}</div>
            </div>
          ))}
      </div>
      {ticket.status !== "closed" && (
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            setBusy(true);
            try {
              const r = await api.post<{ ticket: TicketDetail }>(`/support/tickets/${id}/reply`, { body: reply });
              setTicket(r.ticket);
              setReply("");
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" className={cn(field, "min-h-[44px] flex-1 resize-none py-2.5")} rows={2} />
          <button type="submit" disabled={busy || !reply.trim()} aria-label="Send reply" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </form>
      )}
    </div>
  );
}

function RedeemForm() {
  const [code, setCode] = useState("");
  const [proof, setProof] = useState("");
  const [needsProof, setNeedsProof] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "wait" | "error"; text: string } | null>(null);
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setResult(null);
        try {
          const r = await api.post<{ status: "applied" | "credits" | "pending" | "discount"; message: string }>("/offers/redeem", { code, proof });
          setResult({ tone: r.status === "pending" ? "wait" : "ok", text: r.message });
          setNeedsProof(false);
        } catch (err) {
          const message = err instanceof Error ? err.message : "That code didn't work";
          // Student passes without a college email ask for details — reveal the field instead of just failing.
          if (/college|university|student/i.test(message)) setNeedsProof(true);
          setResult({ tone: "error", text: message });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-muted">Got a promo code, a partner code or a student pass? Enter it here.</p>
      <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CODE-1234" className={cn(field, "h-11 font-mono text-base tracking-widest")} />
      <AnimatePresence initial={false}>
        {needsProof && (
          <motion.label initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="grid gap-1.5 overflow-hidden text-xs font-semibold text-muted">
            <span className="inline-flex items-center gap-1.5"><GraduationCap className="size-3.5" /> Verify you're a student</span>
            <textarea value={proof} onChange={(e) => setProof(e.target.value)} className={cn(field, "min-h-[88px] resize-y py-2.5")} placeholder="College / university, course and year, and your student ID number" />
          </motion.label>
        )}
      </AnimatePresence>
      {result && (
        <p className={cn("rounded-xl px-3 py-2 text-sm", result.tone === "ok" ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" : result.tone === "wait" ? "bg-amber-500/12 text-amber-600 dark:text-amber-400" : "bg-danger/10 text-danger")}>
          {result.text}
        </p>
      )}
      <button type="submit" disabled={busy || code.trim().length < 3} className="flex h-10 items-center justify-center gap-2 rounded-full bg-foreground text-sm font-medium text-background disabled:opacity-50">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Ticket className="size-4" />} Redeem
      </button>
      <p className="text-xs text-subtle">Discount codes can also be entered at checkout on the Plans page.</p>
    </form>
  );
}
