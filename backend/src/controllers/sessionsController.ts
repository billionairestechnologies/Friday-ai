import type { Request, Response } from "express";
import { z } from "zod";
import { recordAdminAuditLog } from "../services/usageService.js";
import * as sessions from "../services/sessions/sessionService.js";

/** /api/sessions (the person's own devices) and the Console's per-user view (supabase 0068). */

const id = z.string().uuid();
const kind = z.enum(["app", "cli"]).default("app");

export async function listMine(req: Request, res: Response) {
  res.json({ sessions: await sessions.listSessions(req.user!.id, req.authToken) });
}

export async function revokeMine(req: Request, res: Response) {
  const k = kind.parse(req.query.kind);
  await sessions.revokeSession(req.user!.id, k, id.parse(req.params.sessionId));
  res.json({ ok: true });
}

export async function revokeMyOthers(req: Request, res: Response) {
  res.json({ ok: true, signedOut: await sessions.revokeOthers(req.user!.id, req.authToken ?? null) });
}

export async function consoleList(req: Request, res: Response) {
  res.json({ sessions: await sessions.listSessions(id.parse(req.params.userId)) });
}

export async function consoleRevoke(req: Request, res: Response) {
  const userId = id.parse(req.params.userId);
  const sessionId = id.parse(req.params.sessionId);
  const k = kind.parse(req.query.kind);
  await sessions.revokeSession(userId, k, sessionId, "admin");
  void recordAdminAuditLog(req.user!.id, "console.user.session_revoke", "user", userId, { sessionId, kind: k }).catch(() => {});
  res.json({ ok: true });
}

export async function consoleRevokeAll(req: Request, res: Response) {
  const userId = id.parse(req.params.userId);
  const n = await sessions.revokeOthers(userId, null, "admin");
  void recordAdminAuditLog(req.user!.id, "console.user.sessions_revoke_all", "user", userId, { signedOut: n }).catch(() => {});
  res.json({ ok: true, signedOut: n });
}
