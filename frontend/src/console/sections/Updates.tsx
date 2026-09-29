import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Eye, Megaphone, MousePointerClick, Plus, Send, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { WhatsNewCard } from "@/components/whats-new-card";
import { cn } from "@/lib/utils";
import { useCan } from "../access";
import { Badge, Button, Card, Drawer, EmptyState, ErrorNote, Field, Input, Loading, PageHeader, Select, Textarea, act, formatDate, fromLocalInput, statusTone, toLocalInput, useResource } from "../ui";

type Update = {
  id: string;
  title: string;
  body: string;
  image_url: string | null;
  cta_label: string | null;
  cta_url: string | null;
  kind: "feature" | "improvement" | "news" | "maintenance";
  audience: string;
  platforms: string[];
  status: "draft" | "published" | "archived";
  publish_at: string | null;
  expires_at: string | null;
  created_at: string;
  stats: { views: number; clicks: number };
};

export const AUDIENCES = [
  { value: "all", label: "Everyone (incl. new signups)" },
  { value: "free", label: "Free users" },
  { value: "paid", label: "All paying users" },
  { value: "pro", label: "Pro users" },
  { value: "premium", label: "Premium users" },
  { value: "new_users", label: "New users (last 14 days)" },
];

export default function Updates() {
  const list = useResource<{ updates: Update[] }>("/console/updates");
  const [editing, setEditing] = useState<Update | "new" | null>(null);
  const canManage = useCan("updates.manage");
  return (
    <>
      <PageHeader
        title="Product updates"
        description="Announce what's new. Each update pops up once for every matching user — on web, Android and iOS — including people who sign up later."
        actions={canManage && <Button variant="primary" onClick={() => setEditing("new")}><Plus className="size-4" /> New update</Button>}
      />
      <ErrorNote error={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.updates.length ? (
        <EmptyState icon={Megaphone} title="No updates yet" text="Ship something? Tell everyone — it shows once, beautifully, the next time they open Friday." action={canManage && <Button variant="primary" onClick={() => setEditing("new")}>Write an update</Button>} />
      ) : (
        <div className="grid gap-3">
          {list.data.updates.map((u) => (
            <Card key={u.id} className="flex flex-wrap items-center gap-4 transition-colors hover:bg-chip/30">
              <button type="button" onClick={() => setEditing(u)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="truncate text-base font-semibold">{u.title}</span>
                  <Badge tone={statusTone(u.status)}>{u.status}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {AUDIENCES.find((a) => a.value === u.audience)?.label} · {u.platforms.join(", ")} · {u.status === "published" ? `live since ${formatDate(u.publish_at)}` : `created ${formatDate(u.created_at)}`}
                </div>
              </button>
              <div className="flex items-center gap-4 text-sm text-muted">
                <span className="inline-flex items-center gap-1.5"><Eye className="size-3.5" /> {u.stats.views}</span>
                <span className="inline-flex items-center gap-1.5"><MousePointerClick className="size-3.5" /> {u.stats.clicks}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
      <UpdateEditor update={editing} onClose={() => setEditing(null)} onChanged={() => void list.reload()} />
    </>
  );
}

function UpdateEditor({ update, onClose, onChanged }: { update: Update | "new" | null; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate();
  const canManage = useCan("updates.manage");
  const canMarket = useCan("marketing.manage");
  const blank = { title: "", body: "", imageUrl: "", ctaLabel: "", ctaUrl: "", kind: "feature" as Update["kind"], audience: "all", platforms: ["web", "android", "ios"], publishAt: "", expiresAt: "" };
  const [form, setForm] = useState(blank);
  const [id, setId] = useState<string | null>(null);
  const [status, setStatus] = useState<Update["status"]>("draft");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (update === "new") {
      setForm(blank);
      setId(null);
      setStatus("draft");
    } else if (update) {
      setForm({
        title: update.title,
        body: update.body,
        imageUrl: update.image_url ?? "",
        ctaLabel: update.cta_label ?? "",
        ctaUrl: update.cta_url ?? "",
        kind: update.kind,
        audience: update.audience,
        platforms: update.platforms,
        publishAt: toLocalInput(update.publish_at),
        expiresAt: toLocalInput(update.expires_at),
      });
      setId(update.id);
      setStatus(update.status);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update]);

  const payload = () => ({ ...form, imageUrl: form.imageUrl || null, ctaLabel: form.ctaLabel || null, ctaUrl: form.ctaUrl || null, publishAt: fromLocalInput(form.publishAt), expiresAt: fromLocalInput(form.expiresAt) });

  async function save(): Promise<string | null> {
    let savedId = id;
    const ok = await act(async () => {
      if (id) await api.patch(`/console/updates/${id}`, payload());
      else {
        const res = await api.post<{ update: Update }>("/console/updates", payload());
        savedId = res.update.id;
        setId(res.update.id);
      }
    });
    if (ok) onChanged();
    return ok ? savedId : null;
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    await fn();
    setBusy(null);
  }

  return (
    <Drawer
      open={Boolean(update)}
      onClose={onClose}
      width={980}
      title={id ? "Edit update" : "New update"}
      subtitle={<Badge tone={statusTone(status)}>{status}</Badge>}
      footer={
        canManage && (
          <>
            {id && (
              <Button variant="danger" onClick={() => run("delete", async () => { if (window.confirm("Delete this update?") && (await act(() => api.delete(`/console/updates/${id}`), "Deleted"))) { onChanged(); onClose(); } })}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
            {id && canMarket && (
              <Button
                variant="ghost"
                onClick={() =>
                  run("email", async () => {
                    await act(async () => {
                      await api.post(`/console/updates/${id}/campaign`);
                      void navigate({ to: "/admin/$section", params: { section: "marketing" } });
                    }, "Draft campaign created from this update");
                  })
                }
                loading={busy === "email"}
              >
                <Send className="size-3.5" /> Email this update
              </Button>
            )}
            <span className="flex-1" />
            <Button onClick={() => run("save", async () => { if (await save()) onClose(); })} loading={busy === "save"} disabled={!form.title.trim()}>
              Save {status === "published" ? "" : "draft"}
            </Button>
            {status === "published" ? (
              <Button variant="secondary" loading={busy === "unpublish"} onClick={() => run("unpublish", async () => { if (id && (await act(() => api.post(`/console/updates/${id}/status`, { status: "archived" }), "Archived — no longer shown"))) { setStatus("archived"); onChanged(); } })}>
                Archive
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!form.title.trim()}
                loading={busy === "publish"}
                onClick={() =>
                  run("publish", async () => {
                    const savedId = await save();
                    if (savedId && (await act(() => api.post(`/console/updates/${savedId}/status`, { status: "published" }), form.publishAt ? "Scheduled" : "Published — users will see it next time they open Friday"))) {
                      setStatus("published");
                      onChanged();
                    }
                  })
                }
              >
                {form.publishAt && new Date(form.publishAt).getTime() > Date.now() ? "Schedule" : "Publish"}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="grid content-start gap-3">
          <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Build Mode now works like Claude Code" /></Field>
          <Field label="Message" hint="Markdown: **bold**, lists, links."><Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} className="min-h-[160px]" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Update["kind"] })} options={[{ value: "feature", label: "New feature" }, { value: "improvement", label: "Improvement" }, { value: "news", label: "News" }, { value: "maintenance", label: "Maintenance" }]} /></Field>
            <Field label="Who sees it"><Select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} options={AUDIENCES} /></Field>
          </div>
          <Field label="Image URL" hint="Optional — 16:8 works best."><Input value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} placeholder="https://…" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Button label"><Input value={form.ctaLabel} onChange={(e) => setForm({ ...form, ctaLabel: e.target.value })} placeholder="Try it" /></Field>
            <Field label="Button link"><Input value={form.ctaUrl} onChange={(e) => setForm({ ...form, ctaUrl: e.target.value })} placeholder="https://…/build" /></Field>
          </div>
          <Field label="Platforms">
            <div className="flex gap-2">
              {["web", "android", "ios"].map((p) => {
                const on = form.platforms.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm({ ...form, platforms: on ? form.platforms.filter((x) => x !== p) : [...form.platforms, p] })}
                    className={cn("h-9 rounded-full border px-4 text-sm transition-colors", on ? "border-foreground bg-foreground text-background" : "border-border text-muted hover:text-foreground")}
                  >
                    {{ web: "Web", android: "Android", ios: "iOS" }[p]}
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Go live at" hint="Empty = when you publish"><Input type="datetime-local" value={form.publishAt} onChange={(e) => setForm({ ...form, publishAt: e.target.value })} /></Field>
            <Field label="Stop showing at" hint="Optional"><Input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></Field>
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">Live preview</div>
          <div className="sticky top-0 overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-background shadow-[var(--shadow-panel)]">
            <WhatsNewCard item={{ id: "preview", title: form.title, body: form.body, imageUrl: form.imageUrl || null, ctaLabel: form.ctaLabel || null, ctaUrl: form.ctaUrl || null, kind: form.kind }} />
            <div className="border-t border-border px-6 py-3 text-right text-xs text-muted">Got it</div>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
