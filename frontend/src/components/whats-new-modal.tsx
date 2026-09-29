import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { POLICY_VERSION } from "@/lib/site/legal";
import { cn } from "@/lib/utils";
import { WhatsNewCard, type WhatsNewItem } from "@/components/whats-new-card";

/**
 * "What's new": product updates published from the Team Console, shown ONCE per user (the server
 * records each view, so it's once across all their devices — and new signups see what's live).
 * Several pending updates show as a short carousel. Never on the console, share, status or legal pages,
 * and never on top of the consent gate.
 */
const HIDDEN_ON = /^\/(admin|share|privacy|terms|status|mobile-auth-bridge)(\/|$)/;

export function WhatsNewModal() {
  const { user, isPending } = useCurrentUserState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [items, setItems] = useState<WhatsNewItem[]>([]);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const fetchedFor = useRef<string | null>(null);
  const userId = user?.id ?? null;
  // Same rule as ConsentGate: until the current policy is accepted the gate owns the screen.
  const policyOk = user?.policyVersion === POLICY_VERSION;

  useEffect(() => {
    if (isPending || !userId || !policyOk || HIDDEN_ON.test(pathname) || fetchedFor.current === userId) return;
    fetchedFor.current = userId;
    // Let the app settle first so the popup never fights the first paint.
    const t = window.setTimeout(() => {
      api
        .get<{ updates: WhatsNewItem[] }>("/updates/pending?platform=web")
        .then((r) => {
          if (r.updates?.length) {
            setItems(r.updates);
            setIndex(0);
            setOpen(true);
          }
        })
        .catch(() => {});
    }, 1200);
    return () => window.clearTimeout(t);
  }, [isPending, userId, policyOk, pathname]);

  function close(clickedId?: string) {
    setOpen(false);
    if (items.length) void api.post("/updates/seen", { ids: items.map((i) => i.id), ...(clickedId ? { clickedId } : {}) }).catch(() => {});
  }

  const item = items[index];
  const last = index >= items.length - 1;
  return (
    <Dialog.Root open={open && Boolean(item)} onOpenChange={(v) => !v && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content onOpenAutoFocus={(e) => e.preventDefault()} className="fixed top-[50%] left-[50%] z-[70] w-[min(92vw,440px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-elevated shadow-[var(--shadow-panel)] duration-300 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <Dialog.Title className="sr-only">What's new in Friday</Dialog.Title>
          <Dialog.Close className="absolute top-3 right-3 z-10 flex size-8 items-center justify-center rounded-full bg-background/70 text-muted backdrop-blur hover:text-foreground" aria-label="Close">
            <X className="size-4" />
          </Dialog.Close>
          <AnimatePresence mode="wait" initial={false}>
            {item && (
              <motion.div key={item.id} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
                <WhatsNewCard item={item} onCta={() => close(item.id)} />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-center gap-3 border-t border-border px-6 py-3">
            {items.length > 1 && (
              <div className="flex gap-1.5">
                {items.map((it, i) => (
                  <button key={it.id} type="button" aria-label={`Update ${i + 1}`} onClick={() => setIndex(i)} className={cn("h-1.5 rounded-full transition-all duration-300", i === index ? "w-5 bg-foreground" : "w-1.5 bg-border")} />
                ))}
              </div>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => (last ? close() : setIndex((i) => i + 1))}
              className="premium-control h-9 rounded-full px-4 text-sm font-medium text-foreground hover:bg-chip"
            >
              {last ? "Got it" : "Next"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
