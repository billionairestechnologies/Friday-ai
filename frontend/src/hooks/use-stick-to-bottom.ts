import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
} from "react";

const BOTTOM_GAP = 80;

export function useStickToBottom(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
) {
  const pinned = useRef(true);
  const programmatic = useRef(false);
  const [away, setAway] = useState(false);

  const stick = useCallback(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
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
