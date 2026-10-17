import type { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../utils/logger.js";
import { recordAdminAuditLog } from "../services/usageService.js";
import {
  cancelMultiplier,
  invalidateMultipliers,
  MAX_MULTIPLIER,
  multiplierFor,
  multiplierOverview,
  publishMultipliers,
  type MultiplierRow,
} from "../services/quota/multipliers.js";

/** Console → Models → Usage multipliers (supabase 0059, services/quota/multipliers.ts). */

export async function overview(_req: Request, res: Response) {
  res.json(await multiplierOverview());
}

const iso = z.string().datetime({ offset: true });
const publishSchema = z.object({
  models: z
    .array(z.object({ provider_slug: z.string().min(1).max(100), model_id: z.string().min(1).max(200), expected_latest: z.string().uuid().nullable() }))
    .min(1)
    .max(200),
  multiplier: z.number().min(0).max(MAX_MULTIPLIER),
  kind: z.enum(["base", "promo"]),
  effective_from: iso.nullish(),
  effective_to: iso.nullish(),
  reason: z.string().trim().min(3).max(500),
});

/** The model rows (multiplier + its row id) go in the model_multipliers history; the audit log also records who and why. */
async function audit(req: Request, action: string, rows: MultiplierRow[], extra: (row: MultiplierRow) => Record<string, unknown> = () => ({})) {
  await Promise.all(
    rows.map((r) =>
      recordAdminAuditLog(req.user!.id, action, "model_multiplier", r.id, {
        provider_slug: r.provider_slug,
        model_id: r.model_id,
        multiplier: r.multiplier,
        kind: r.kind,
        effective_from: r.effective_from,
        effective_to: r.effective_to,
        reason: r.reason,
        correlation_id: req.requestId ?? null,
        ...extra(r),
      }),
    ),
  ).catch((err) => logger.error("multiplier_audit_failed", { error: err instanceof Error ? err.message : String(err), requestId: req.requestId }));
}

export async function publish(req: Request, res: Response) {
  const body = publishSchema.parse(req.body);
  // What each model was charged at just before, for the audit trail (fresh read, not the 30 s cache).
  invalidateMultipliers();
  const previous = new Map<string, number>();
  for (const m of body.models) previous.set(`${m.provider_slug}/${m.model_id}`, (await multiplierFor(m.provider_slug, m.model_id)).multiplier);
  const created = await publishMultipliers(
    body.models.map((m) => ({
      ...m,
      multiplier: body.multiplier,
      kind: body.kind,
      effective_from: body.effective_from ?? null,
      effective_to: body.effective_to ?? null,
      reason: body.reason,
    })),
    req.user!.id,
  );
  await audit(req, "multiplier_published", created, (r) => ({ previous_multiplier: previous.get(`${r.provider_slug}/${r.model_id}`) ?? null }));
  res.status(201).json({ created });
}

export async function cancel(req: Request, res: Response) {
  const id = z.string().uuid().parse(req.params.multiplierId);
  const row = await cancelMultiplier(id, req.user!.id);
  await audit(req, "multiplier_cancelled", [row]);
  res.json({ row });
}
