import { useNavigate } from "@tanstack/react-router";
import { Hammer, Pencil } from "lucide-react";
import { handOffToBuild } from "@/lib/chat/build-handoff";

/** Text the server stores as a plan message — the thread shows just this line above the plan card. */
export const PLAN_MARKER = "Here's the plan. Approve it to start building, or tell me what to change.";
/** The Approve button sends exactly this (backend plan.ts keys off it). */
export const PLAN_APPROVE_TEXT = "Approved — build it as planned.";

/** Above the composer while the newest message is a plan waiting for an answer: nothing is built
 *  until the user approves; typing in the composer instead asks for a revised plan. */
export function PlanApprovalPanel({ onApprove, onRequestChanges }: { onApprove: () => void; onRequestChanges: () => void }) {
  return (
    <div className="mb-2 flex flex-col gap-3 rounded-2xl border border-border bg-composer px-4 py-3 shadow-[var(--shadow-soft)] sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-foreground">Ready to build this plan?</p>
        <p className="mt-0.5 text-xs text-muted">Nothing is built until you approve. To change it, type what you want different below.</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onRequestChanges}
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
