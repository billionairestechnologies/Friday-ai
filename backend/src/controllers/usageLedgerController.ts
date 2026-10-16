import type { Request, Response } from "express";
import { z } from "zod";
import { recordAdminAuditLog } from "../services/usageService.js";
import {
  adjustUsageAccount,
  exportLedgerCsv,
  listFlaggedCalls,
  listUsageAccounts,
  setUsageAccountSuspended,
  usageAccountDetail,
  usageOverview,
} from "../services/console/usageLedgerService.js";
import { runQuotaMaintenance } from "../services/quota/quotaJobs.js";

const accountId = z.string().uuid();

export async function overview(_req: Request, res: Response) {
  res.json(await usageOverview());
}

export async function accounts(req: Request, res: Response) {
  const q = z.object({ q: z.string().max(200).optional(), filter: z.enum(["all", "exhausted", "near", "suspended"]).optional() }).parse(req.query);
  res.json({ accounts: await listUsageAccounts(q) });
}

export async function account(req: Request, res: Response) {
  res.json(await usageAccountDetail(accountId.parse(req.params.accountId)));
}

const adjustSchema = z.object({
  // Positive consumes allowance (debit/correction), negative gives it back (bonus/refund/correction).
  tokens: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine((n) => n !== 0, "tokens can't be 0"),
  kind: z.enum(["bonus", "refund", "correction", "debit", "reset"]),
  reason: z.string().trim().min(3).max(500),
  key: z.string().max(100).optional(),
});

export async function adjust(req: Request, res: Response) {
  const id = accountId.parse(req.params.accountId);
  const body = adjustSchema.parse(req.body);
  const snapshot = await adjustUsageAccount(id, body, req.user!.id);
  void recordAdminAuditLog(req.user!.id, "usage_adjusted", "quota_account", id, { tokens: body.tokens, kind: body.kind, reason: body.reason }).catch(() => {});
  res.json({ snapshot });
}

export async function setStatus(req: Request, res: Response) {
  const id = accountId.parse(req.params.accountId);
  const body = z.object({ suspended: z.boolean(), reason: z.string().trim().min(3).max(500) }).parse(req.body);
  await setUsageAccountSuspended(id, body.suspended, body.reason, req.user!.id);
  void recordAdminAuditLog(req.user!.id, body.suspended ? "usage_suspended" : "usage_unsuspended", "quota_account", id, { reason: body.reason }).catch(() => {});
  res.status(204).send();
}

export async function calls(req: Request, res: Response) {
  const q = z.object({ kind: z.enum(["failed", "estimated"]).default("failed") }).parse(req.query);
  res.json({ calls: await listFlaggedCalls(q) });
}

export async function exportCsv(req: Request, res: Response) {
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const q = z.object({ from: day, to: day }).parse(req.query);
  const csv = await exportLedgerCsv(`${q.from}T00:00:00Z`, `${q.to}T23:59:59.999Z`);
  void recordAdminAuditLog(req.user!.id, "usage_exported", "token_ledger", undefined, q).catch(() => {});
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="friday-usage-${q.from}-to-${q.to}.csv"`);
  res.send(csv);
}

/** Runs the reconciliation / expiry / stale-hold sweep now instead of waiting for the next tick. */
export async function reconcile(req: Request, res: Response) {
  const result = await runQuotaMaintenance({ alert: false });
  void recordAdminAuditLog(req.user!.id, "usage_reconciled", "quota", undefined, result).catch(() => {});
  res.json(result);
}
