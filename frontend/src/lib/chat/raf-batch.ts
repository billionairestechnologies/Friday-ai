import type { AgentStatus, AssistantStatus, Citation } from "./types";

export type StreamAcc = {
  text: string;
  think: string;
  status?: AssistantStatus;
  cites: Citation[];
  agents: AgentStatus[];
  error?: string;
};

export function createStreamBatcher(apply: (acc: StreamAcc) => void) {
  let acc: StreamAcc = empty();
  let raf = 0;

  const flush = () => {
    raf = 0;
    if (!acc.text && !acc.think && acc.cites.length === 0 && acc.agents.length === 0 && !acc.status && !acc.error) {
      return;
    }
    apply(acc);
    acc = empty();
  };

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(flush);
  };

  return {
    text(c: string) {
      acc.text += c;
      acc.status = "writing";
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
    flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flush();
    },
  };
}

function empty(): StreamAcc {
  return { text: "", think: "", cites: [], agents: [] };
}
