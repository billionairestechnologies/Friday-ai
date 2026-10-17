import { useEffect, useRef, useState } from "react";
import { Bell, Gift, GraduationCap, Info, Megaphone } from "lucide-react";
import { api } from "@/lib/api";
import { useDismiss } from "@/lib/use-dismiss";
import { cn } from "@/lib/utils";

/**
 * The bell in the sidebar: this person's notifications (benefits, programme decisions…) and the
 * What's New history (GET /notifications). Opening it marks everything read.
 */
type Item = { id: string; kind: string; title: string; body: string; createdAt: string; read: boolean };
type Update = { id: string; title: string; body: string; ctaLabel: string | null; ctaUrl: string | null; publishedAt: string };
type Inbox = { items: Item[]; unread: number; whatsNew: Update[] };

const ICON: Record<string, typeof Bell> = { credit_granted: Gift, program_approved: GraduationCap, program_needs_info: Info, program_rejected: Info, program_renew: GraduationCap };

function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

export function InboxButton() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"mine" | "updates">("mine");
  const [data, setData] = useState<Inbox | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const load = () =>
    api
      .get<Inbox>("/notifications?platform=web")
      .then(setData)
      .catch(() => {});
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 120_000);
    return () => window.clearInterval(t);
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && data?.unread) {
      void api.post("/notifications/read", { all: true }).then(() => setData((d) => (d ? { ...d, unread: 0, items: d.items.map((i) => ({ ...i, read: true })) } : d)));
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-label={data?.unread ? `Notifications, ${data.unread} unread` : "Notifications"} aria-expanded={open} onClick={toggle} className={cn("relative flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground", open && "bg-chip text-foreground")}>
        <Bell className="size-4" />
        {Boolean(data?.unread) && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-notify ring-2 ring-background" />}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute top-11 left-0 z-50 w-[min(86vw,340px)] overflow-hidden rounded-2xl border border-border bg-elevated shadow-[var(--shadow-panel)]">
          <div className="flex gap-1 border-b border-border p-1.5">
            {(["mine", "updates"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={cn("h-8 flex-1 rounded-full text-xs font-medium", tab === t ? "bg-chip text-foreground" : "text-muted hover:text-foreground")}>
                {t === "mine" ? "For you" : "What's new"}
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {tab === "mine" ? (
              (data?.items ?? []).length === 0 ? (
                <p className="p-6 text-center text-sm text-muted">Nothing yet.</p>
              ) : (
                data!.items.map((i) => {
                  const Icon = ICON[i.kind] ?? Bell;
                  return (
                    <div key={i.id} className="flex gap-3 border-b border-border/60 px-4 py-3 last:border-0">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-sm text-foreground", !i.read && "font-semibold")}>{i.title}</p>
                        {i.body && <p className="mt-0.5 text-xs text-muted">{i.body}</p>}
                      </div>
                      <span className="shrink-0 text-[11px] text-subtle">{ago(i.createdAt)}</span>
                    </div>
                  );
                })
              )
            ) : (data?.whatsNew ?? []).length === 0 ? (
              <p className="p-6 text-center text-sm text-muted">No updates yet.</p>
            ) : (
              data!.whatsNew.map((u) => (
                <div key={u.id} className="flex gap-3 border-b border-border/60 px-4 py-3 last:border-0">
                  <Megaphone className="mt-0.5 size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{u.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">{u.body.replace(/[#*_`>]/g, "")}</p>
                    {u.ctaLabel && u.ctaUrl && (
                      <a href={u.ctaUrl} {...(/^https:\/\//i.test(u.ctaUrl) ? { target: "_blank", rel: "noopener noreferrer" } : {})} className="mt-1 inline-block text-xs font-medium text-foreground underline-offset-2 hover:underline">
                        {u.ctaLabel}
                      </a>
                    )}
                  </div>
                  <span className="shrink-0 text-[11px] text-subtle">{ago(u.publishedAt)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
