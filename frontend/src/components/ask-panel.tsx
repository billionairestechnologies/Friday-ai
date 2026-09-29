import { useState } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AskQuestion } from "@/lib/chat/types";

/** Text the server stores as the question message — also lets the thread recognise it. Shared by
 *  Build Mode's and general chat's ask rounds alike, so it's worded generically. */
export const ASK_MARKER = "A few quick questions before I go ahead, so the result is what you need.";
/** The user's picks go back as a normal message starting with this (the backend keys off it). */
export const ANSWERS_PREFIX = "My answers to your questions:";

/** Popup above the composer: one question at a time, recommended option first, "Other" last. */
export function AskPanel({ questions, onSubmit, onDismiss }: { questions: AskQuestion[]; onSubmit: (text: string) => void; onDismiss: () => void }) {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const q = questions[step];
  if (!q) return null;
  const isOther = picked[q.id] === "__other__";
  const answer = isOther ? other[q.id]?.trim() : picked[q.id];
  const last = step === questions.length - 1;

  function next() {
    if (!answer) return;
    if (!last) return setStep(step + 1);
    const lines = questions.map((x) => `- ${x.question}: ${picked[x.id] === "__other__" ? other[x.id]?.trim() : picked[x.id]}`);
    onSubmit(`${ANSWERS_PREFIX}\n${lines.join("\n")}`);
  }

  return (
    <div className="mb-2 overflow-hidden rounded-2xl border border-border bg-composer shadow-[var(--shadow-soft)]">
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-subtle">
            Question {step + 1} of {questions.length}
          </p>
          <p className="mt-0.5 text-[15px] font-medium text-foreground">{q.question}</p>
        </div>
        <button type="button" aria-label="Skip questions" onClick={onDismiss} className="rounded-full p-1 text-muted hover:bg-chip hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-1 px-2 py-2">
        {q.options.map((o) => {
          const on = picked[q.id] === o.label;
          return (
            <button
              key={o.label}
              type="button"
              onClick={() => setPicked({ ...picked, [q.id]: o.label })}
              className={cn("flex items-start gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-chip", on && "bg-chip")}
            >
              <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-foreground bg-foreground text-background" : "border-border")}>
                {on && <Check className="size-3" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-sm text-foreground">{o.label}</span>
                {o.recommended && <span className="ml-2 rounded-full bg-chip px-2 py-0.5 text-[11px] text-muted">Recommended</span>}
                {o.description && <span className="mt-0.5 block text-xs text-muted">{o.description}</span>}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setPicked({ ...picked, [q.id]: "__other__" })}
          className={cn("flex items-start gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-chip", isOther && "bg-chip")}
        >
          <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", isOther ? "border-foreground bg-foreground text-background" : "border-border")}>
            {isOther && <Check className="size-3" />}
          </span>
          <span className="text-sm text-foreground">Other</span>
        </button>
        {isOther && (
          <input
            autoFocus
            value={other[q.id] ?? ""}
            onChange={(e) => setOther({ ...other, [q.id]: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && next()}
            placeholder="Type your own answer"
            className="mx-2.5 mb-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
          />
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
        <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)} className="text-sm text-muted hover:text-foreground disabled:opacity-40">
          Back
        </button>
        <button type="button" disabled={!answer} onClick={next} className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background disabled:opacity-40">
          {last ? "Submit" : "Next"}
        </button>
      </div>
    </div>
  );
}

/** Read-only version inside the chat thread. */
export function AskCard({ questions }: { questions: AskQuestion[] }) {
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-2xl border border-border bg-elevated p-4">
      {questions.map((q, i) => (
        <div key={q.id}>
          <p className="text-sm font-medium text-foreground">
            {i + 1}. {q.question}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {q.options.map((o) => (o.recommended ? `${o.label} (recommended)` : o.label)).join(" · ")} · Other
          </p>
        </div>
      ))}
    </div>
  );
}
