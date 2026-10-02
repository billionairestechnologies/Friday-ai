import { type RefObject, useEffect } from "react";

/**
 * Closes a hand-rolled popover the way every menu should behave: a press anywhere outside it, or
 * Escape. Testers reported the Share popup staying open when they clicked elsewhere — Radix menus
 * already do this, the few custom popovers did not.
 *
 * `pointerdown` (not click) so a press that starts a drag/scroll outside still closes it, and so it
 * runs before the target's own click handler (pressing another header button opens that one cleanly).
 */
export function useDismiss(open: boolean, onClose: () => void, ...refs: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && refs.some((r) => r.current?.contains(target))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
    // refs are stable ref objects; onClose identity changes every render and must not re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** Escape-to-close for full-screen modals that already close on a backdrop click. */
export function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
