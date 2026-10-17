import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { MotionConfig, motion } from "framer-motion";
import { Gift, GraduationCap, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { POLICY_VERSION } from "@/lib/site/legal";

/**
 * One-time popup for a benefit granted to this person (bonus credits, a programme approval) —
 * supabase 0062. Shown only after the grant committed (the server writes the notification then),
 * claimed before display so it appears once across tabs and devices, and acknowledged on "Got it".
 */
const HIDDEN_ON = /^\/(admin|share|privacy|terms|status|mobile-auth-bridge)(\/|$)/;

type Popup = { id: string; kind: string; title: string; body: string; data: Record<string, unknown>; createdAt: string };

export function BenefitPopup() {
  const { user, isPending } = useCurrentUserState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [queue, setQueue] = useState<Popup[]>([]);
  const [current, setCurrent] = useState<Popup | null>(null);
  const fetchedFor = useRef<string | null>(null);
  const userId = user?.id ?? null;
  const policyOk = user?.policyVersion === POLICY_VERSION;

  useEffect(() => {
    if (isPending || !userId || !policyOk || HIDDEN_ON.test(pathname) || fetchedFor.current === userId) return;
    fetchedFor.current = userId;
    // After What's New has had its turn, so two dialogs never open at once.
    const t = window.setTimeout(() => {
      api
        .get<{ popups: Popup[] }>("/notifications/popups")
        .then((r) => setQueue(r.popups ?? []))
        .catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, [isPending, userId, policyOk, pathname]);

  useEffect(() => {
    if (current || queue.length === 0) return;
    // Don't stack on top of another open dialog (What's New, settings…); try again shortly.
    if (document.querySelector('[role="dialog"]')) {
      const t = window.setTimeout(() => setQueue((q) => [...q]), 1500);
      return () => window.clearTimeout(t);
    }
    const [next, ...rest] = queue;
    let live = true;
    void api
      .post<{ show: boolean }>(`/notifications/${next!.id}/claim`, {})
      .then((r) => live && (setQueue(rest), r.show && setCurrent(next!)))
      .catch(() => live && setQueue(rest));
    return () => {
      live = false;
    };
  }, [queue, current]);

  const close = () => {
    if (current) void api.post(`/notifications/${current.id}/ack`, {}).catch(() => {});
    setCurrent(null);
  };
  const Icon = current?.kind === "program_approved" ? GraduationCap : Gift;
  return (
    <MotionConfig reducedMotion="user">
      <Dialog.Root open={Boolean(current)} onOpenChange={(v) => !v && close()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
          <Dialog.Content className="fixed top-[50%] left-[50%] z-[70] w-[min(92vw,400px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-[var(--radius-2xl)] border border-border bg-elevated text-center shadow-[var(--shadow-panel)] data-[state=open]:animate-in data-[state=open]:zoom-in-95 motion-reduce:animate-none">
            <Dialog.Close className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground" aria-label="Close">
              <X className="size-4" />
            </Dialog.Close>
            <div className="bg-gradient-to-b from-emerald-400/20 via-[#4f8cff]/10 to-transparent px-6 pt-8 pb-2">
              <motion.span
                initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 260, damping: 16 }}
                className="mx-auto flex size-16 items-center justify-center rounded-2xl border border-white/10 bg-background/70 shadow-[var(--shadow-soft)]"
              >
                <Icon className="size-7 text-foreground" />
              </motion.span>
            </div>
            <div className="px-6 pt-3 pb-6">
              <Dialog.Title className="text-xl font-semibold tracking-tight text-foreground">{current?.title}</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-muted">{current?.body}</Dialog.Description>
              <button type="button" onClick={close} autoFocus className="premium-control mt-5 h-10 w-full rounded-full bg-foreground text-sm font-medium text-background hover:opacity-90">
                Got it
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </MotionConfig>
  );
}
