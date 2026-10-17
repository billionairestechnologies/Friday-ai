import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ArrowRight, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { POLICY_VERSION } from "@/lib/site/legal";
import { cn } from "@/lib/utils";
import { WhatsNewCard, linkProps, type WhatsNewItem } from "@/components/whats-new-card";

/**
 * "What's new": product updates published from the Team Console, shown ONCE per person per version
 * (supabase 0062). Each item is CLAIMED right before it is shown (POST /updates/claim) — the first
 * tab/device wins, others skip it — so nothing is marked seen that wasn't displayed, and two open
 * tabs never show the same popup. What the person did (dismissed / acknowledged / clicked) is
 * recorded per item. Banner-variant updates show as a slim bar instead of a dialog.
 * Never on the console, share, status or legal pages, and never on top of the consent gate.
 */
const HIDDEN_ON = /^\/(admin|share|privacy|terms|status|mobile-auth-bridge)(\/|$)/;

type Item = WhatsNewItem & { id: string; version: number };

const claim = (item: Item) =>
  api
    .post<{ show: boolean }>("/updates/claim", { id: item.id, version: item.version, platform: "web" })
    .then((r) => r.show)
    .catch(() => false);
const act = (item: Item, state: "dismissed" | "acknowledged" | "clicked") => void api.post("/updates/act", { id: item.id, version: item.version, state }).catch(() => {});

export function WhatsNewModal() {
  const { user, isPending } = useCurrentUserState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [queue, setQueue] = useState<Item[]>([]);
  const [current, setCurrent] = useState<Item | null>(null);
  const [banner, setBanner] = useState<Item | null>(null);
  const fetchedFor = useRef<string | null>(null);
  const userId = user?.id ?? null;
  const policyOk = user?.policyVersion === POLICY_VERSION;

  useEffect(() => {
    if (isPending || !userId || !policyOk || HIDDEN_ON.test(pathname) || fetchedFor.current === userId) return;
    fetchedFor.current = userId;
    // Let the app settle first so the popup never fights the first paint.
    const t = window.setTimeout(() => {
      api
        .get<{ updates: Item[] }>("/updates/pending?platform=web")
        .then(async (r) => {
          const items = (r.updates ?? []).map((u) => ({ ...u, version: u.version ?? 1 }));
          const firstBanner = items.find((i) => i.variant === "banner");
          if (firstBanner && (await claim(firstBanner))) setBanner(firstBanner);
          setQueue(items.filter((i) => i.variant !== "banner"));
        })
        .catch(() => {});
    }, 1200);
    return () => window.clearTimeout(t);
  }, [isPending, userId, policyOk, pathname]);

  // Show the next queued item only once this tab has won its claim.
  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...rest] = queue;
    let live = true;
    void claim(next!).then((ok) => {
      if (!live) return;
      setQueue(rest);
      if (ok) setCurrent(next!);
    });
    return () => {
      live = false;
    };
  }, [queue, current]);

  function finish(state: "dismissed" | "acknowledged" | "clicked") {
    if (current) act(current, state);
    // "Next" shows the next one; closing (X / Esc / outside) stops for now — the rest stay unclaimed
    // and appear another time.
    if (state === "dismissed") setQueue([]);
    setCurrent(null);
  }

  const more = queue.length > 0;
  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {banner && (
          <motion.div
            role="status"
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -40, opacity: 0 }}
            className="fixed top-3 left-1/2 z-[65] flex w-[min(94vw,640px)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-border bg-elevated px-4 py-2.5 text-sm shadow-[var(--shadow-panel)]"
          >
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{banner.title}</span>
              {banner.body && <span className="ml-2 text-muted">{banner.body.replace(/[#*_`>]/g, "").slice(0, 140)}</span>}
            </span>
            {banner.ctaLabel && banner.ctaUrl && (
              <a href={banner.ctaUrl} {...linkProps(banner.ctaUrl)} onClick={() => (act(banner, "clicked"), setBanner(null))} className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline">
                {banner.ctaLabel} <ArrowRight className="size-3.5" />
              </a>
            )}
            <button type="button" aria-label="Dismiss" onClick={() => (act(banner, "dismissed"), setBanner(null))} className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground">
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <Dialog.Root open={Boolean(current)} onOpenChange={(v) => !v && finish("dismissed")}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed top-[50%] left-[50%] z-[70] w-[min(92vw,440px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-elevated shadow-[var(--shadow-panel)] duration-300 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none"
          >
            <Dialog.Title className="sr-only">{current ? `What's new: ${current.title}` : "What's new in Friday"}</Dialog.Title>
            <Dialog.Close className="absolute top-3 right-3 z-10 flex size-8 items-center justify-center rounded-full bg-background/70 text-muted backdrop-blur hover:text-foreground" aria-label="Close">
              <X className="size-4" />
            </Dialog.Close>
            <AnimatePresence mode="wait" initial={false}>
              {current && (
                <motion.div key={`${current.id}:${current.version}`} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
                  <WhatsNewCard item={current} onCta={() => finish("clicked")} />
                </motion.div>
              )}
            </AnimatePresence>
            <div className="flex items-center gap-3 border-t border-border px-6 py-3">
              {/* No "N more": an item another tab already showed is only known once it's claimed. */}
              <span className="flex-1" />
              <button type="button" onClick={() => finish("acknowledged")} className={cn("premium-control h-9 rounded-full px-4 text-sm font-medium text-foreground hover:bg-chip")} autoFocus>
                {more ? "Next" : "Got it"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </MotionConfig>
  );
}
