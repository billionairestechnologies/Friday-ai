import type { NativeBuildAction } from "./tools.js";

/**
 * Build permission modes + approval prompts (like Claude Code's). The agent loop pauses on an action
 * that needs the user's OK and waits here until they Allow/Deny it from any device (POST
 * /api/build/:conversationId/approve), the build is stopped, or it times out. The loop keeps running
 * server-side while it waits, so closing the app doesn't lose the build.
 *
 *   ask        → ask before every file change, command and connected-app action
 *   auto_edit  → file changes run automatically; commands and connected-app actions ask
 *   full_auto  → everything in the sandbox runs automatically
 *
 * Whatever the mode, a few things always ask: opening a pull request (a push to the user's GitHub),
 * deploy/publish commands, and deleting files recursively.
 */
export type PermissionMode = "ask" | "auto_edit" | "full_auto";

export type ApprovalRequest = {
  id: string;
  /** What kind of action: file | command | connector | pr */
  kind: "file" | "command" | "connector" | "pr";
  title: string;
  detail?: string;
  /** Why this one asks even in full auto (shown to the user). */
  always?: boolean;
  createdAt: number;
};

export type ApprovalDecision = "allow" | "deny" | "allow_all";

const WAIT_MS = 30 * 60_000;
const DESTRUCTIVE = /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b|\bgit\s+push\b|\bnpm\s+publish\b|\b(vercel|netlify|firebase|fly|railway|wrangler)\b[^|;&]*\b(deploy|--prod|publish|up)\b|\bgh\s+(release|repo\s+delete)\b/i;

/** Returns the approval prompt for an action, or null when it can run without asking. */
export function approvalFor(action: NativeBuildAction, mode: PermissionMode): Omit<ApprovalRequest, "id" | "createdAt"> | null {
  switch (action.kind) {
    case "pr":
      return { kind: "pr", title: `Open a pull request: ${action.title}`, detail: `Pushes branch ${action.branch} to your GitHub repository.`, always: true };
    case "run":
    case "start": {
      const always = DESTRUCTIVE.test(action.cmd);
      if (!always && mode === "full_auto") return null;
      return {
        kind: "command",
        title: action.kind === "start" ? `Start the server: ${action.desc || action.cmd}` : `Run: ${action.desc || action.cmd}`,
        detail: `$ ${action.cmd.slice(0, 1500)}`,
        ...(always ? { always: true } : {}),
      };
    }
    case "write":
    case "edit":
      if (mode !== "ask") return null;
      return { kind: "file", title: `${action.kind === "write" ? "Write" : "Edit"} ${action.path}` };
    case "ext":
      if (mode === "full_auto") return null;
      return { kind: "connector", title: `Use ${action.tool}`, detail: JSON.stringify(action.args).slice(0, 800) };
    default:
      return null;
  }
}

type Pending = { userId: string; request: ApprovalRequest; resolve: (d: ApprovalDecision) => void };
const pending = new Map<string, Map<string, Pending>>();

/** Waits for the user's decision. Resolves "deny" on timeout or when the build is stopped. */
export function requestApproval(
  conversationId: string,
  userId: string,
  request: Omit<ApprovalRequest, "id" | "createdAt">,
  signal?: AbortSignal,
): { request: ApprovalRequest; decision: Promise<ApprovalDecision> } {
  const full: ApprovalRequest = { ...request, id: `ap_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() };
  const decision = new Promise<ApprovalDecision>((resolve) => {
    let map = pending.get(conversationId);
    if (!map) pending.set(conversationId, (map = new Map()));
    const finish = (d: ApprovalDecision) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      map!.delete(full.id);
      if (map!.size === 0) pending.delete(conversationId);
      resolve(d);
    };
    const timer = setTimeout(() => finish("deny"), WAIT_MS);
    const onAbort = () => finish("deny");
    signal?.addEventListener("abort", onAbort, { once: true });
    map.set(full.id, { userId, request: full, resolve: finish });
  });
  return { request: full, decision };
}

/** The user's Allow/Deny. False when there's no such pending request for this user. */
export function resolveApproval(conversationId: string, userId: string, id: string, decision: ApprovalDecision): boolean {
  const entry = pending.get(conversationId)?.get(id);
  if (!entry || entry.userId !== userId) return false;
  entry.resolve(decision);
  return true;
}

export function listPendingApprovals(conversationId: string, userId: string): ApprovalRequest[] {
  return [...(pending.get(conversationId)?.values() ?? [])].filter((p) => p.userId === userId).map((p) => p.request);
}

export function hasPendingApproval(conversationId: string): boolean {
  return (pending.get(conversationId)?.size ?? 0) > 0;
}
