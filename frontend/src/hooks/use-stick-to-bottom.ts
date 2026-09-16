import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
} from "react";

const BOTTOM_GAP = 80;
// How long after the user's last wheel/touch/pointer gesture on the scroller before a
// content-resize is allowed to auto-stick again. Without this, a resize firing mid-gesture (the
// content growing while streaming, or a content-visibility:auto element recomputing its size as
// it scrolls into view) can win a race against the user's own scroll: `pinned` only flips off
// once they've moved more than BOTTOM_GAP px, so every resize in that window snaps back to the
// bottom and fights their scroll-up attempt — reported live as the scrollbar "stuck and
// vibrating." Pausing auto-stick for the duration of active interaction removes that race
// entirely, regardless of what's causing the resize.
const INTERACTION_COOLDOWN_MS = 500;

export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
) {
  const pinned = useRef(true);
  const programmatic = useRef(false);
  const interacting = useRef(false);
  const interactionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [away, setAway] = useState(false);

  const stick = useCallback(() => {
    const el = scroller.current;
    if (!el || !pinned.current || interacting.current) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, [scroller]);

  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const ro = new ResizeObserver(() => stick());
    ro.observe(node);
    stick();
    return () => ro.disconnect();
  }, [content, stick]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const markInteracting = () => {
      interacting.current = true;
      if (interactionTimer.current) clearTimeout(interactionTimer.current);
      interactionTimer.current = setTimeout(() => {
        interacting.current = false;
      }, INTERACTION_COOLDOWN_MS);
    };
    el.addEventListener("wheel", markInteracting, { passive: true });
    el.addEventListener("touchstart", markInteracting, { passive: true });
    el.addEventListener("touchmove", markInteracting, { passive: true });
    el.addEventListener("pointerdown", markInteracting, { passive: true });
    return () => {
      el.removeEventListener("wheel", markInteracting);
      el.removeEventListener("touchstart", markInteracting);
      el.removeEventListener("touchmove", markInteracting);
      el.removeEventListener("pointerdown", markInteracting);
      if (interactionTimer.current) clearTimeout(interactionTimer.current);
    };
  }, [scroller]);

  const onScroll = useCallback((e: UIEvent<HTMLElement>) => {
    if (programmatic.current) return;
    const el = e.currentTarget;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = gap <= BOTTOM_GAP;
    if (atBottom) {
      if (!pinned.current) {
        pinned.current = true;
        setAway(false);
      }
    } else if (pinned.current) {
      pinned.current = false;
      setAway(true);
    }
  }, []);

  const jump = useCallback(() => {
    pinned.current = true;
    setAway(false);
    const el = scroller.current;
    if (el) {
      programmatic.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        programmatic.current = false;
      });
    }
  }, [scroller]);

  return { away, onScroll, jump };
}
