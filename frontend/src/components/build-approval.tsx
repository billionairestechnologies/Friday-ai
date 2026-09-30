import { useState } from "react";
import { FileCode2, GitPullRequest, Loader2, Puzzle, ShieldAlert, TerminalSquare } from "lucide-react";
import { api } from "@/lib/api";
import type { BuildApproval } from "@/lib/chat/types";

const ICONS = { file: FileCode2, command: TerminalSquare, connector: Puzzle, pr: GitPullRequest } as const;

/** Above the composer while the Build agent is paused on a permission prompt (Claude Code-style).
 *  The build waits server-side, so this works from any device — the answer goes to /approve. */
export function ApprovalPanel({ approval, conversationId, onDecided }: { approval: BuildApproval; conversationId: string; onDecided: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const Icon = ICONS[approval.kind] ?? TerminalSquare;

  async function decide(decision: "allow" | "deny" | "allow_all") {
    setBusy(decision);
    setError(null);
    try {
      await api.post(`/build/${conversationId}/approve`, { id: approval.id, decision });
      onDecided(approval.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send your answer — try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-2 rounded-2xl border border-amber-500/40 bg-composer px-4 py-3 shadow-[var(--shadow-soft)]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">Friday wants to</p>
          <p className="text-[15px] font-medium break-words text-foreground">{approval.title}</p>
          {approval.detail && <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-chip/60 px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap text-muted">{approval.detail}</pre>}
          {approval.always && (
            <p className="mt-1.5 flex items-center gap-1 text-xs text-muted">
              <ShieldAlert className="size-3.5" /> Always asks — this reaches outside the sandbox or can't be undone.
            </p>
          )}
          {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button type="button" disabled={Boolean(busy)} onClick={() => void decide("deny")} className="rounded-full border border-border px-3.5 py-1.5 text-sm text-foreground hover:bg-chip disabled:opacity-50">
          {busy === "deny" ? <Loader2 className="size-4 animate-spin" /> : "Deny"}
        </button>
        {!approval.always && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void decide("allow_all")} className="rounded-full border border-border px-3.5 py-1.5 text-sm text-foreground hover:bg-chip disabled:opacity-50">
            {busy === "allow_all" ? <Loader2 className="size-4 animate-spin" /> : "Allow all for this build"}
          </button>
        )}
        <button type="button" disabled={Boolean(busy)} onClick={() => void decide("allow")} className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50">
          {busy === "allow" ? <Loader2 className="size-4 animate-spin" /> : "Allow"}
        </button>
      </div>
    </div>
  );
}
