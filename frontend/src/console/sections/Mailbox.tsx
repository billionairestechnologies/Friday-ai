import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Download,
  Flag,
  Forward,
  Inbox,
  KeyRound,
  Mail,
  MailOpen,
  Paperclip,
  PenSquare,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { API_BASE_URL, api, getAccessToken } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Select, Textarea, Toggle, act, useResource } from "../ui";

/**
 * Mailbox (Team Console): one inbox for the employee's company mailbox (hosted on our mail server)
 * and any other account they add — Gmail, Outlook, Zoho, iCloud or any IMAP/SMTP server.
 * Message HTML renders in a sandboxed iframe: no scripts, and remote images stay blocked until
 * "Show images" (tracking pixels).
 */

type Account = {
  id: string;
  kind: "hosted" | "external";
  label: string;
  email: string;
  display_name: string;
  imap_host: string;
  is_default: boolean;
  last_error: string | null;
};
type ClientSettings = {
  email: string;
  username: string;
  incoming: { protocol: string; host: string; port: number; security: string };
  outgoing: { protocol: string; host: string; port: number; security: string; altPort: number; altSecurity: string };
  webmail: string | null;
};
type Folder = { path: string; name: string; specialUse: string | null; unseen: number; total: number };
type Addr = { name: string; address: string };
type Summary = { uid: number; subject: string; from: Addr[]; to: Addr[]; date: string | null; seen: boolean; flagged: boolean; answered: boolean; size: number; hasAttachments: boolean };
type FullMessage = {
  uid: number;
  messageId: string | null;
  references: string[];
  subject: string;
  from: Addr[];
  to: Addr[];
  cc: Addr[];
  replyTo: Addr[];
  date: string | null;
  html: string | null;
  text: string;
  flagged: boolean;
  attachments: { index: number; filename: string; contentType: string; size: number }[];
  inline: Record<string, string>;
};

const who = (a: Addr[] | undefined) => (a?.length ? a[0]!.name || a[0]!.address : "—");
const list = (a: Addr[]) => a.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(", ");
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function when(d: string | null) {
  if (!d) return "";
  const date = new Date(d);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.getFullYear() === now.getFullYear()
      ? date.toLocaleDateString([], { month: "short", day: "numeric" })
      : date.toLocaleDateString();
}

type Compose = { mode: "new" | "reply" | "replyAll" | "forward"; original?: FullMessage };

export default function Mailbox() {
  const accounts = useResource<{ accounts: Account[]; presets: Record<string, { help: string }>; settings: ClientSettings[] }>("/console/mailbox/accounts");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [folder, setFolder] = useState("INBOX");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [openUid, setOpenUid] = useState<number | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [adding, setAdding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const all = accounts.data?.accounts ?? [];
  const account = all.find((a) => a.id === accountId) ?? all[0] ?? null;
  useEffect(() => {
    setFolder("INBOX");
    setOpenUid(null);
    setPage(0);
  }, [account?.id]);

  const folders = useResource<{ folders: Folder[] }>(account ? `/console/mailbox/accounts/${account.id}/folders` : null);
  const msgs = useResource<{ total: number; page: number; pageSize: number; messages: Summary[] }>(
    account ? `/console/mailbox/accounts/${account.id}/messages?folder=${encodeURIComponent(folder)}&page=${page}&q=${encodeURIComponent(search)}` : null,
  );

  // New mail: refresh the open folder every 60s while the tab is visible.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible" && !openUid) {
        void msgs.reload();
        void folders.reload();
      }
    }, 60_000);
    return () => window.clearInterval(t);
  }, [msgs.reload, folders.reload, openUid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function bulk(uids: number[], action: string) {
    if (!account) return;
    if (await act(() => api.post(`/console/mailbox/accounts/${account.id}/actions`, { folder, uids, action }))) {
      if (action === "trash" || action === "archive" || action === "delete") setOpenUid(null);
      void msgs.reload();
      void folders.reload();
    }
  }

  if (accounts.loading && !accounts.data) return <Loading />;
  if (!all.length) {
    return (
      <>
        <PageHeader title="Mailbox" description="Your company email and any other inbox you use — in one place." />
        <ErrorNote error={accounts.error} />
        <EmptyState
          icon={Mail}
          title="No mail accounts yet"
          text="An admin creates your company mailbox in Mail hosting. You can also add Gmail, Outlook or any other account."
          action={<Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" /> Add an account</Button>}
        />
        <AddAccount open={adding} presets={accounts.data?.presets ?? {}} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void accounts.reload(); }} />
      </>
    );
  }

  const pages = msgs.data ? Math.ceil(msgs.data.total / msgs.data.pageSize) : 0;
  return (
    <>
      <PageHeader
        title="Mailbox"
        description={account ? `${account.display_name ? `${account.display_name} · ` : ""}${account.email}` : undefined}
        actions={
          <>
            <Button onClick={() => setShowSettings(true)}><Settings2 className="size-4" /> Accounts</Button>
            <Button variant="primary" onClick={() => setCompose({ mode: "new" })}><PenSquare className="size-4" /> Compose</Button>
          </>
        }
      />
      {account?.last_error && <ErrorNote error={`${account.email}: ${account.last_error}`} />}
      <div className="grid min-h-[70dvh] gap-4 lg:grid-cols-[220px_minmax(0,380px)_minmax(0,1fr)]">
        {/* Accounts + folders */}
        <div className={cn("flex flex-col gap-3", openUid && "hidden lg:flex")}>
          {all.length > 1 && (
            <Select value={account?.id ?? ""} onChange={(e) => setAccountId(e.target.value)} options={all.map((a) => ({ value: a.id, label: `${a.label} · ${a.email}` }))} />
          )}
          <Card pad={false} className="p-1.5">
            {folders.loading && !folders.data ? (
              <p className="p-3 text-xs text-muted">Loading folders…</p>
            ) : (
              (folders.data?.folders ?? [{ path: "INBOX", name: "Inbox", specialUse: "\\Inbox", unseen: 0, total: 0 }]).map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => { setFolder(f.path); setOpenUid(null); setPage(0); }}
                  className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm", folder === f.path ? "bg-chip-on font-medium" : "hover:bg-chip")}
                >
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {f.unseen > 0 && <span className="text-xs text-primary tabular-nums">{f.unseen}</span>}
                </button>
              ))
            )}
          </Card>
          <ErrorNote error={folders.error} />
        </div>

        {/* Message list */}
        <Card pad={false} className={cn("flex min-h-0 flex-col overflow-hidden", openUid && "hidden lg:flex")}>
          <form
            className="flex items-center gap-2 border-b border-border p-2"
            onSubmit={(e) => { e.preventDefault(); setSearch(query); setPage(0); }}
          >
            <Search className="ml-1 size-4 shrink-0 text-subtle" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mail" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            {search && <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); setSearch(""); }}><X className="size-4 text-subtle" /></button>}
            <button type="button" aria-label="Refresh" onClick={() => { void msgs.reload(); void folders.reload(); }} className="rounded-md p-1 text-subtle hover:bg-chip"><RefreshCw className={cn("size-4", msgs.loading && "animate-spin")} /></button>
          </form>
          <ErrorNote error={msgs.error} />
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {msgs.loading && !msgs.data ? (
              <Loading />
            ) : !msgs.data?.messages.length ? (
              <p className="p-6 text-center text-sm text-muted">{search ? "No messages match." : "Nothing here."}</p>
            ) : (
              msgs.data.messages.map((m) => (
                <button
                  key={m.uid}
                  type="button"
                  onClick={() => setOpenUid(m.uid)}
                  className={cn("flex w-full flex-col gap-0.5 border-b border-border/60 px-3 py-2.5 text-left", openUid === m.uid ? "bg-chip-on" : "hover:bg-chip/60")}
                >
                  <div className="flex items-center gap-2">
                    {!m.seen && <span className="size-2 shrink-0 rounded-full bg-primary" />}
                    <span className={cn("min-w-0 flex-1 truncate text-sm", !m.seen && "font-semibold")}>{folder.toLowerCase().includes("sent") ? `To: ${who(m.to)}` : who(m.from)}</span>
                    {m.flagged && <Flag className="size-3 text-amber-400" />}
                    {m.hasAttachments && <Paperclip className="size-3 text-subtle" />}
                    <span className="shrink-0 text-[11px] text-subtle tabular-nums">{when(m.date)}</span>
                  </div>
                  <div className={cn("truncate text-xs", m.seen ? "text-muted" : "text-foreground")}>{m.subject}</div>
                </button>
              ))
            )}
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted">
              <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button>
              <span>Page {page + 1} of {pages}</span>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Older</Button>
            </div>
          )}
        </Card>

        {/* Reader */}
        <Card pad={false} className={cn("min-h-0 overflow-hidden", !openUid && "hidden lg:block")}>
          {account && openUid ? (
            <Reader
              key={`${account.id}/${folder}/${openUid}`}
              accountId={account.id}
              folder={folder}
              uid={openUid}
              onBack={() => setOpenUid(null)}
              onAction={(action) => void bulk([openUid], action)}
              onCompose={(mode, original) => setCompose({ mode, original })}
              onRead={() => { msgs.setData((d) => d && { ...d, messages: d.messages.map((x) => (x.uid === openUid ? { ...x, seen: true } : x)) }); void folders.reload(); }}
            />
          ) : (
            <div className="grid h-full place-items-center p-10 text-center text-sm text-muted">
              <div><Inbox className="mx-auto mb-2 size-8 text-subtle" />Select a message to read it.</div>
            </div>
          )}
        </Card>
      </div>
      {account && compose && <Composer account={account} compose={compose} onClose={() => setCompose(null)} onSent={() => { setCompose(null); void msgs.reload(); }} />}
      <AccountsDrawer
        open={showSettings}
        accounts={all}
        settings={accounts.data?.settings ?? []}
        onClose={() => setShowSettings(false)}
        onAdd={() => setAdding(true)}
        onChanged={() => void accounts.reload()}
      />
      <AddAccount open={adding} presets={accounts.data?.presets ?? {}} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void accounts.reload(); }} />
    </>
  );
}

/** The message HTML in a locked-down iframe: no scripts, no forms; remote images only on request. */
function MessageBody({ message }: { message: FullMessage }) {
  const [images, setImages] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(400);
  const html = useMemo(() => {
    if (!message.html) return null;
    let body = message.html.replace(/cid:([^"'\s)>]+)/g, (m, cid: string) => message.inline[cid] ?? message.inline[cid.replace(/^<|>$/g, "")] ?? m);
    // Defence in depth on top of the sandbox: drop scripts and inline handlers outright.
    body = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${images ? "https: http:" : ""}; img-src data: ${images ? "https: http:" : ""}; font-src data: ${images ? "https:" : ""};`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f1f1f;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#0b57d0}</style></head><body>${body}</body></html>`;
  }, [message, images]);
  const hasRemote = Boolean(message.html && /<img[^>]+src=["']?https?:/i.test(message.html));
  if (!html) return <pre className="p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap text-foreground">{message.text}</pre>;
  return (
    <>
      {hasRemote && !images && (
        <div className="flex items-center justify-between border-b border-border bg-chip/50 px-4 py-1.5 text-xs text-muted">
          Images from the internet are hidden to protect your privacy.
          <button type="button" onClick={() => setImages(true)} className="font-medium text-foreground hover:underline">Show images</button>
        </div>
      )}
      <iframe
        ref={ref}
        title="Message"
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        srcDoc={html}
        onLoad={() => {
          const doc = ref.current?.contentDocument;
          if (doc) setHeight(Math.min(20_000, Math.max(200, doc.documentElement.scrollHeight + 8)));
        }}
        style={{ height }}
        className="w-full rounded-b-[var(--radius-xl)] bg-white"
      />
    </>
  );
}

function Reader({ accountId, folder, uid, onBack, onAction, onCompose, onRead }: {
  accountId: string;
  folder: string;
  uid: number;
  onBack: () => void;
  onAction: (action: string) => void;
  onCompose: (mode: Compose["mode"], original: FullMessage) => void;
  onRead: () => void;
}) {
  const res = useResource<{ message: FullMessage }>(`/console/mailbox/accounts/${accountId}/messages/${uid}?folder=${encodeURIComponent(folder)}`);
  const m = res.data?.message;
  useEffect(() => {
    if (m) onRead();
  }, [m?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function download(index: number, filename: string) {
    const r = await fetch(`${API_BASE_URL}/console/mailbox/accounts/${accountId}/messages/${uid}/attachments/${index}?folder=${encodeURIComponent(folder)}`, {
      headers: { Authorization: `Bearer ${getAccessToken() ?? ""}` },
    });
    if (!r.ok) return act(() => Promise.reject(new Error("Download failed")));
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  if (res.loading && !m) return <Loading />;
  if (res.error) return <div className="p-4"><ErrorNote error={res.error} /></div>;
  if (!m) return null;
  const isTrash = /trash|bin|deleted/i.test(folder);
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <button type="button" onClick={onBack} aria-label="Back" className="rounded-md p-1.5 text-muted hover:bg-chip lg:hidden"><ArrowLeft className="size-4" /></button>
        <IconBtn label="Reply" onClick={() => onCompose("reply", m)}><Reply className="size-4" /></IconBtn>
        <IconBtn label="Reply all" onClick={() => onCompose("replyAll", m)}><ReplyAll className="size-4" /></IconBtn>
        <IconBtn label="Forward" onClick={() => onCompose("forward", m)}><Forward className="size-4" /></IconBtn>
        <span className="mx-1 h-5 w-px bg-border" />
        <IconBtn label="Archive" onClick={() => onAction("archive")}><Archive className="size-4" /></IconBtn>
        <IconBtn label={isTrash ? "Delete forever" : "Move to trash"} onClick={() => onAction(isTrash ? "delete" : "trash")}><Trash2 className="size-4" /></IconBtn>
        <IconBtn label="Mark unread" onClick={() => { onAction("unread"); onBack(); }}><MailOpen className="size-4" /></IconBtn>
        <IconBtn label={m.flagged ? "Unflag" : "Flag"} onClick={() => onAction(m.flagged ? "unflag" : "flag")}><Flag className={cn("size-4", m.flagged && "fill-amber-400 text-amber-400")} /></IconBtn>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pt-4 pb-3">
          <h2 className="text-lg font-semibold">{m.subject}</h2>
          <div className="mt-2 text-sm"><span className="font-medium">{who(m.from)}</span> <span className="text-subtle">&lt;{m.from[0]?.address}&gt;</span></div>
          <div className="text-xs text-muted">To {list(m.to)}{m.cc.length ? ` · Cc ${list(m.cc)}` : ""} · {m.date ? new Date(m.date).toLocaleString() : ""}</div>
          {m.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <button key={a.index} type="button" onClick={() => void download(a.index, a.filename)} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-chip">
                  <Paperclip className="size-3.5 text-subtle" /> <span className="max-w-48 truncate">{a.filename}</span> <span className="text-subtle">{kb(a.size)}</span> <Download className="size-3.5 text-subtle" />
                </button>
              ))}
            </div>
          )}
        </div>
        <MessageBody message={m} />
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-chip hover:text-foreground">
      {children}
    </button>
  );
}

const splitAddrs = (s: string) => s.split(/[,;\n]/).map((x) => x.trim().replace(/^.*<([^>]+)>.*$/, "$1")).filter(Boolean);

function quote(m: FullMessage) {
  const header = `On ${m.date ? new Date(m.date).toLocaleString() : ""}, ${who(m.from)} <${m.from[0]?.address ?? ""}> wrote:`;
  return `\n\n${header}\n${m.text.split("\n").map((l) => `> ${l}`).join("\n")}`;
}

function Composer({ account, compose, onClose, onSent }: { account: Account; compose: Compose; onClose: () => void; onSent: () => void }) {
  const o = compose.original;
  const subjectPrefix = compose.mode === "forward" ? "Fwd: " : compose.mode === "new" ? "" : "Re: ";
  const initialTo = !o ? "" : compose.mode === "forward" ? "" : list(o.replyTo.length ? o.replyTo : o.from);
  const initialCc =
    o && compose.mode === "replyAll" ? list([...o.to, ...o.cc].filter((a) => a.address.toLowerCase() !== account.email.toLowerCase())) : "";
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(initialCc);
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(Boolean(initialCc));
  const [subject, setSubject] = useState(o ? (o.subject.toLowerCase().startsWith(subjectPrefix.toLowerCase().trim()) ? o.subject : `${subjectPrefix}${o.subject}`) : "");
  const [body, setBody] = useState(o ? (compose.mode === "forward" ? `\n\n---------- Forwarded message ----------\nFrom: ${list(o.from)}\nDate: ${o.date ?? ""}\nSubject: ${o.subject}\nTo: ${list(o.to)}\n\n${o.text}` : quote(o)) : "");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const total = files.reduce((n, f) => n + f.size, 0);

  async function send() {
    setBusy(true);
    const attachments = await Promise.all(
      files.map(
        (f) =>
          new Promise<{ filename: string; contentType: string; dataBase64: string }>((resolve, reject) => {
            const r = new FileReader();
            r.onerror = () => reject(new Error(`Couldn't read ${f.name}`));
            r.onload = () => resolve({ filename: f.name, contentType: f.type || "application/octet-stream", dataBase64: String(r.result).split(",")[1] ?? "" });
            r.readAsDataURL(f);
          }),
      ),
    ).catch(() => null);
    if (!attachments) {
      setBusy(false);
      return;
    }
    const ok = await act(
      () =>
        api.post(`/console/mailbox/accounts/${account.id}/send`, {
          to: splitAddrs(to),
          cc: splitAddrs(cc),
          bcc: splitAddrs(bcc),
          subject,
          text: body,
          inReplyTo: o && compose.mode !== "forward" ? o.messageId : null,
          references: o && compose.mode !== "forward" ? [...o.references, ...(o.messageId ? [o.messageId] : [])] : undefined,
          attachments,
        }),
      "Sent",
    );
    setBusy(false);
    if (ok) onSent();
  }

  return (
    <Drawer
      open
      onClose={onClose}
      width={640}
      title={compose.mode === "new" ? "New message" : compose.mode === "forward" ? "Forward" : "Reply"}
      subtitle={`From ${account.display_name ? `${account.display_name} <${account.email}>` : account.email}`}
      footer={
        <>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-chip">
            <Paperclip className="size-4" /> Attach
            <input type="file" multiple className="hidden" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 10))} />
          </label>
          <span className="flex-1" />
          <Button variant="primary" loading={busy} disabled={!splitAddrs(to).length || total > 20 * 1024 * 1024} onClick={() => void send()}>
            <Send className="size-4" /> Send
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="To"><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com, …" autoFocus={!o || compose.mode === "forward"} /></Field>
        {showCc ? (
          <>
            <Field label="Cc"><Input value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
            <Field label="Bcc"><Input value={bcc} onChange={(e) => setBcc(e.target.value)} /></Field>
          </>
        ) : (
          <button type="button" onClick={() => setShowCc(true)} className="-mt-1 justify-self-start text-xs text-muted hover:text-foreground">Add Cc / Bcc</button>
        )}
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={16} autoFocus={Boolean(o) && compose.mode !== "forward"} className="font-sans" />
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-lg bg-chip px-2 py-1 text-xs">
                {f.name} <span className="text-subtle">{kb(f.size)}</span>
                <button type="button" aria-label="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))}><X className="size-3" /></button>
              </span>
            ))}
            {total > 20 * 1024 * 1024 && <span className="text-xs text-danger">Attachments are limited to 20 MB.</span>}
          </div>
        )}
      </div>
    </Drawer>
  );
}

function AccountsDrawer({ open, accounts, settings, onClose, onAdd, onChanged }: { open: boolean; accounts: Account[]; settings: ClientSettings[]; onClose: () => void; onAdd: () => void; onChanged: () => void }) {
  const [pwFor, setPwFor] = useState<Account | null>(null);
  const [pw, setPw] = useState("");
  return (
    <Drawer open={open} onClose={onClose} title="Mail accounts" subtitle="Your company mailbox and any other inbox you read here" footer={<Button variant="primary" onClick={onAdd}><Plus className="size-4" /> Add Gmail / Outlook / other</Button>}>
      <div className="grid gap-3">
        {accounts.map((a) => {
          const s = settings.find((x) => x.email === a.email);
          return (
            <Card key={a.id} className="grid gap-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.email}</div>
                  <div className="text-xs text-muted">{a.kind === "hosted" ? "Company mailbox" : `${a.label} · ${a.imap_host}`}</div>
                </div>
                {a.is_default ? <Badge tone="blue">default</Badge> : <Button size="sm" onClick={async () => { if (await act(() => api.post(`/console/mailbox/accounts/${a.id}/default`), "Default account set")) onChanged(); }}>Make default</Button>}
                {a.kind === "external" && (
                  <Button size="sm" variant="danger" onClick={async () => { if (await act(() => api.delete(`/console/mailbox/accounts/${a.id}`), "Account removed")) onChanged(); }}><Trash2 className="size-3.5" /></Button>
                )}
              </div>
              {a.last_error && <p className="text-xs text-danger">{a.last_error}</p>}
              {s && (
                <div className="rounded-lg bg-chip/60 p-3 text-xs leading-relaxed text-muted">
                  <div className="mb-1 font-medium text-foreground">Use it in Gmail app, Outlook, Apple Mail or your phone</div>
                  <div>Username: <span className="font-mono text-foreground">{s.username}</span> · Password: your mailbox password</div>
                  <div>Incoming (IMAP): <span className="font-mono text-foreground">{s.incoming.host}</span> · port {s.incoming.port} · {s.incoming.security}</div>
                  <div>Outgoing (SMTP): <span className="font-mono text-foreground">{s.outgoing.host}</span> · port {s.outgoing.port} {s.outgoing.security} (or {s.outgoing.altPort} {s.outgoing.altSecurity})</div>
                  {s.webmail && <div>Browser webmail: <a href={s.webmail} target="_blank" rel="noreferrer" className="text-foreground underline">{s.webmail}</a></div>}
                  <button type="button" onClick={() => { setPwFor(a); setPw(""); }} className="mt-2 inline-flex items-center gap-1 font-medium text-foreground hover:underline"><KeyRound className="size-3" /> Change mailbox password</button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <Modal
        open={Boolean(pwFor)}
        onClose={() => setPwFor(null)}
        title="Change mailbox password"
        footer={
          <>
            <Button onClick={() => setPwFor(null)}>Cancel</Button>
            <Button variant="primary" disabled={pw.length < 10} onClick={async () => { if (pwFor && (await act(() => api.post(`/console/mailbox/accounts/${pwFor.id}/password`, { password: pw }), "Password changed — update it in your other mail apps"))) setPwFor(null); }}>
              Change password
            </Button>
          </>
        }
      >
        <Field label="New password" hint="At least 10 characters. Your phone and other mail apps will ask for it again.">
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </Drawer>
  );
}

function AddAccount({ open, presets, onClose, onAdded }: { open: boolean; presets: Record<string, { help: string }>; onClose: () => void; onAdded: () => void }) {
  const [preset, setPreset] = useState("gmail");
  const [form, setForm] = useState({ email: "", displayName: "", password: "", imapHost: "", imapPort: "993", smtpHost: "", smtpPort: "465", username: "" });
  const [secure, setSecure] = useState({ imap: true, smtp: true });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a mail account"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!form.email || !form.password}
            onClick={async () => {
              setBusy(true);
              const custom = preset === "custom";
              const ok = await act(
                () =>
                  api.post("/console/mailbox/accounts", {
                    email: form.email,
                    displayName: form.displayName,
                    password: form.password,
                    preset,
                    ...(custom
                      ? { imapHost: form.imapHost, imapPort: Number(form.imapPort), imapSecure: secure.imap, smtpHost: form.smtpHost, smtpPort: Number(form.smtpPort), smtpSecure: secure.smtp, username: form.username || undefined }
                      : {}),
                  }),
                "Account added",
              );
              setBusy(false);
              if (ok) {
                setForm({ email: "", displayName: "", password: "", imapHost: "", imapPort: "993", smtpHost: "", smtpPort: "465", username: "" });
                onAdded();
              }
            }}
          >
            Connect
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Provider">
          <Select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            options={[
              { value: "gmail", label: "Gmail / Google Workspace" },
              { value: "outlook", label: "Outlook / Microsoft 365" },
              { value: "zoho", label: "Zoho Mail" },
              { value: "yahoo", label: "Yahoo Mail" },
              { value: "icloud", label: "iCloud Mail" },
              { value: "custom", label: "Other (IMAP/SMTP)" },
            ]}
          />
        </Field>
        {presets[preset]?.help && <p className="rounded-lg bg-chip/60 p-2.5 text-xs leading-relaxed text-muted">{presets[preset]!.help}</p>}
        <Field label="Email address"><Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Your name (shown to recipients)"><Input value={form.displayName} onChange={(e) => set("displayName", e.target.value)} /></Field>
        <Field label={preset === "custom" ? "Password" : "App password"}><Input type="password" value={form.password} onChange={(e) => set("password", e.target.value)} /></Field>
        {preset === "custom" && (
          <>
            <div className="grid grid-cols-[1fr_90px] gap-3">
              <Field label="IMAP server"><Input value={form.imapHost} onChange={(e) => set("imapHost", e.target.value)} placeholder="imap.example.com" /></Field>
              <Field label="Port"><Input value={form.imapPort} onChange={(e) => set("imapPort", e.target.value)} /></Field>
            </div>
            <Toggle checked={secure.imap} onChange={(v) => setSecure({ ...secure, imap: v })} label="IMAP over SSL/TLS (port 993)" />
            <div className="grid grid-cols-[1fr_90px] gap-3">
              <Field label="SMTP server"><Input value={form.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} placeholder="smtp.example.com" /></Field>
              <Field label="Port"><Input value={form.smtpPort} onChange={(e) => set("smtpPort", e.target.value)} /></Field>
            </div>
            <Toggle checked={secure.smtp} onChange={(v) => setSecure({ ...secure, smtp: v })} label="SMTP over SSL/TLS (465) — off = STARTTLS (587)" />
            <Field label="Username (if not the email)"><Input value={form.username} onChange={(e) => set("username", e.target.value)} /></Field>
          </>
        )}
        <p className="text-xs text-subtle">Friday checks the sign-in before saving. Passwords are stored encrypted and only used to read and send your mail.</p>
      </div>
    </Modal>
  );
}
