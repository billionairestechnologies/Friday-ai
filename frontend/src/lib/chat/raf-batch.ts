import type { AgentStatus, AssistantStatus, Citation } from "./types";

export type StreamAcc = {
  text: string;
  think: string;
  status?: AssistantStatus;
  cites: Citation[];
  agents: AgentStatus[];
  error?: string;
};

// Tokens arrive from the network in uneven bursts (provider batching, TCP, proxies) — painting each
// burst as-is made replies lurch forward in jumps and then stall ("sticks and starts"). Instead,
// arriving text goes into a backlog that is revealed a little every frame, at a rate proportional
// to the backlog: a big burst drains within ~DRAIN_MS instead of landing at once, and a slow stream
// still shows every character as soon as it arrives. Same smooth cadence ChatGPT/Claude use.
const DRAIN_MS = 240;
/** Floor so a small backlog still clears promptly (~2 chars/frame ≈ 120 chars/s at 60fps). */
const MIN_CHARS_PER_FRAME = 2;
/** Upper bound on the final drain when the stream ends, so "done" is never held back noticeably. */
const FINAL_DRAIN_MAX_MS = 450;
/** A tool call (search, page read) pauses the stream, then the next paragraph lands in one burst. Draining a big burst
 *  in 240 ms looks like "types, stops, then jumps" — so a bigger backlog gets proportionally longer (up to this), which
 *  reads as steady typing. Never used for the final drain once the stream has ended. */
const MAX_BURST_DRAIN_MS = 800;
const BURST_MS_PER_CHAR = 1.2;

/** How many backlog characters to reveal this frame (exported for tests). */
export function revealCount(backlog: number, frameMs: number, drainMs = DRAIN_MS): number {
  if (backlog <= 0) return 0;
  const dt = Math.min(Math.max(frameMs, 1), 100); // a background tab can report huge gaps
  return Math.min(backlog, Math.max(MIN_CHARS_PER_FRAME, Math.ceil((backlog * dt) / drainMs)));
}

/** Never split a UTF-16 surrogate pair (emoji) across frames — it would render as "�" for a frame. */
function safeCut(text: string, n: number): number {
  if (n >= text.length) return text.length;
  const code = text.charCodeAt(n - 1);
  return code >= 0xd800 && code <= 0xdbff ? n + 1 : n;
}

export function createStreamBatcher(apply: (acc: StreamAcc) => void) {
  let acc: StreamAcc = empty();
  let raf = 0;
  let backlog = "";
  let lastFrame = 0;
  let drainMs = DRAIN_MS;
  let drained: (() => void) | null = null;

  const push = () => {
    if (!acc.text && !acc.think && acc.cites.length === 0 && acc.agents.length === 0 && !acc.status && !acc.error) {
      return;
    }
    apply(acc);
    acc = empty();
  };

  const frame = (now: number) => {
    raf = 0;
    const dt = lastFrame ? now - lastFrame : 16;
    lastFrame = now;
    if (backlog) {
      const effectiveDrain = drainMs === DRAIN_MS ? Math.min(MAX_BURST_DRAIN_MS, Math.max(DRAIN_MS, backlog.length * BURST_MS_PER_CHAR)) : drainMs;
      const n = safeCut(backlog, revealCount(backlog.length, dt, effectiveDrain));
      acc.text += backlog.slice(0, n);
      backlog = backlog.slice(n);
      acc.status = "writing";
    }
    push();
    if (backlog) {
      raf = requestAnimationFrame(frame);
    } else {
      lastFrame = 0;
      if (drained) {
        const done = drained;
        drained = null;
        done();
      }
    }
  };

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  return {
    text(c: string) {
      backlog += c;
      schedule();
    },
    think(c: string) {
      acc.think += c;
      acc.status = "thinking";
      schedule();
    },
    status(s: NonNullable<AssistantStatus>) {
      acc.status = s;
      schedule();
    },
    cite(c: Citation) {
      acc.cites.push(c);
      schedule();
    },
    agent(a: AgentStatus) {
      acc.agents.push(a);
      schedule();
    },
    error(c: string) {
      acc.error = c;
      this.flush();
    },
    /** Reveals everything still pending right now (errors, aborts). */
    flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      lastFrame = 0;
      if (backlog) {
        acc.text += backlog;
        backlog = "";
      }
      push();
      if (drained) {
        const done = drained;
        drained = null;
        done();
      }
    },
    /**
     * Stream finished: let the backlog finish typing out (faster than normal), then resolve. Capped
     * so the end of a reply is never held back; a hidden tab (no animation frames) resolves via the
     * timeout and flushes.
     */
    drain(): Promise<void> {
      if (!backlog) {
        this.flush();
        return Promise.resolve();
      }
      drainMs = Math.min(DRAIN_MS, 120);
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.flush(), FINAL_DRAIN_MAX_MS);
        drained = () => {
          clearTimeout(timer);
          resolve();
        };
        schedule();
      });
    },
  };
}

function empty(): StreamAcc {
  return { text: "", think: "", cites: [], agents: [] };
}
