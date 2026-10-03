import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Hammer, Pencil, Send } from "lucide-react";
import { handOffToBuild } from "@/lib/chat/build-handoff";

/** Text the server stores as a plan message — the thread shows just this line above the plan card. */
export const PLAN_MARKER = "Here's the plan. Approve it to start building, or tell me what to change.";
/** The Approve button sends exactly this (backend plan.ts keys off it). */
export const PLAN_APPROVE_TEXT = "Approved — build it as planned.";

/** Above the composer while the newest message is a plan waiting for an answer: nothing is built
 *  until the user approves. "Request changes" opens its own box right here to type what to change —
 *  it used to only try to focus the composer, which did nothing visible when that wasn't available. */
export function PlanApprovalPanel({ onApprove, onSubmitChanges }: { onApprove: () => void; onSubmitChanges: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) boxRef.current?.focus();
  }, [editing]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmitChanges(t);
    setText("");
    setEditing(false);
  };
  return (
    <div className="mb-2 flex flex-col gap-3 rounded-2xl border border-border bg-composer px-4 py-3 shadow-[var(--shadow-soft)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-foreground">Ready to build this plan?</p>
          <p className="mt-0.5 text-xs text-muted">Nothing is built until you approve. Want something different? Request changes and tell me what.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-expanded={editing}
            onClick={() => setEditing((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-sm text-foreground hover:bg-chip"
          >
            <Pencil className="size-3.5" /> Request changes
          </button>
          <button
            type="button"
            onClick={onApprove}
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-90"
          >
            <Hammer className="size-3.5" /> Approve &amp; build
          </button>
        </div>
      </div>
      {editing && (
        <div className="flex flex-col gap-2">
          <textarea
            ref={boxRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
            rows={3}
            placeholder="What should change in the plan? e.g. “use React with Tailwind, add a dark mode, drop the sound effects”"
            className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-subtle focus:border-foreground/40"
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-subtle">⌘/Ctrl + Enter to send</span>
            <button type="button" onClick={() => setEditing(false)} className="rounded-full px-3 py-1.5 text-sm text-muted hover:bg-chip">
              Cancel
            </button>
            <button
              type="button"
              disabled={!text.trim()}
              onClick={submit}
              className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
            >
              <Send className="size-3.5" /> Send changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Under a normal-chat reply to a build request: Build Mode lives in the Build workspace. */
export function SuggestBuildCard({ prompt }: { prompt: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex w-full flex-col gap-3 rounded-2xl border border-border bg-elevated px-4 py-3 sm:flex-row sm:items-center">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-chip">
        <Hammer className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Want Friday to actually build this?</p>
        <p className="mt-0.5 text-xs text-muted">Build plans it with you first, then writes the code, runs it and shows a live preview.</p>
      </div>
      <button
        type="button"
        onClick={() => {
          handOffToBuild(prompt);
          void navigate({ to: "/build" });
        }}
        className="shrink-0 rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-90"
      >
        Open in Build
      </button>
    </div>
  );
}
