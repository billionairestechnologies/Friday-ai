import { ArrowRight, Megaphone, Sparkles, Wrench, Zap } from "lucide-react";
import { Markdown } from "@/lib/chat/markdown";
import { cn } from "@/lib/utils";

/** One product update, as users see it in the "What's new" popup (also the console's live preview). */
export type WhatsNewItem = {
  id: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  kind: "feature" | "improvement" | "news" | "maintenance";
};

const KIND = {
  feature: { label: "New feature", icon: Sparkles, tint: "from-[#4f8cff]/25 via-[#a855f7]/20 to-transparent" },
  improvement: { label: "Improved", icon: Zap, tint: "from-emerald-400/20 via-[#4f8cff]/15 to-transparent" },
  news: { label: "News", icon: Megaphone, tint: "from-amber-400/20 via-rose-400/10 to-transparent" },
  maintenance: { label: "Heads up", icon: Wrench, tint: "from-zinc-400/20 via-zinc-500/10 to-transparent" },
} as const;

export function WhatsNewCard({ item, onCta, className }: { item: WhatsNewItem; onCta?: () => void; className?: string }) {
  const kind = KIND[item.kind] ?? KIND.feature;
  const Icon = kind.icon;
  return (
    <div className={cn("relative overflow-hidden", className)}>
      {item.imageUrl ? (
        <img src={item.imageUrl} alt="" className="aspect-[16/8] w-full object-cover" />
      ) : (
        <div className={cn("relative flex aspect-[16/7] w-full items-center justify-center bg-gradient-to-br", kind.tint)}>
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.08),transparent_55%)]" />
          <span className="relative flex size-14 items-center justify-center rounded-2xl border border-white/10 bg-background/60 shadow-[var(--shadow-soft)] backdrop-blur">
            <Icon className="size-6 text-foreground" />
          </span>
        </div>
      )}
      <div className="px-6 pt-5 pb-6">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-[11px] font-semibold text-muted">
          <Icon className="size-3" /> {kind.label}
        </span>
        <h2 className="mt-3 font-[var(--font-heading)] text-xl font-semibold tracking-tight text-foreground">{item.title || "Untitled update"}</h2>
        {item.body && (
          <div className="mt-2 text-sm text-muted">
            <Markdown text={item.body} />
          </div>
        )}
        {item.ctaLabel && item.ctaUrl && (
          <a
            href={item.ctaUrl}
            onClick={onCta}
            className="premium-control mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-medium text-background hover:opacity-90"
          >
            {item.ctaLabel} <ArrowRight className="size-4" />
          </a>
        )}
      </div>
    </div>
  );
}
