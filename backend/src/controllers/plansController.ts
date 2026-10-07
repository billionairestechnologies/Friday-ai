import { planEconomics } from "../services/finance/planEconomics.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { recordAdminAuditLog } from "../services/usageService.js";
import * as plans from "../services/console/plansService.js";
import { ENTITLEMENT_DEFS, getPlanCatalog, saveCatalogPlan } from "../services/quota/planCatalog.js";
import { resolveEntitlements } from "../services/quota/entitlements.js";
import { brandedEmail, fromAddress, mailConfigured, renderMarkdown, sendEmail } from "../services/console/mail.js";

/** Plans & Offers — console side (/api/console/plans/*) and user side (/api/offers/*). */

const id = z.string().uuid();
const isoDate = z.string().datetime({ offset: true }).nullable().optional();
const positiveInt = z.coerce.number().int().positive();
// Validated loosely here and strictly (known keys, right types, clamped) by sanitizeEntitlements.
const entitlementsSchema = z.record(z.string(), z.union([z.boolean(), z.number()]));

function audit(req: Request, action: string, targetType: string, targetId?: string, meta: Record<string, unknown> = {}) {
  void recordAdminAuditLog(req.user!.id, action, targetType, targetId, meta).catch(() => {});
}

export async function economics(_req: Request, res: Response) {
  res.json(await planEconomics());
}

export async function overview(_req: Request, res: Response) {
  const [catalog, packages, offers, grants, pending, { data: organizations }] = await Promise.all([
    getPlanCatalog(),
    plans.listPackages(),
    plans.listOffers(),
    plans.listGrants({}),
    plans.listRedemptions("pending"),
    supabaseAdmin.from("organizations").select("id, name, plan, seat_count").order("name").limit(500),
  ]);
  res.json({ catalog, entitlementDefs: ENTITLEMENT_DEFS, packages, offers, grants, pending, organizations: organizations ?? [] });
}

const catalogSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  tagline: z.string().max(240).optional(),
  monthlyPricePaise: z.coerce.number().int().min(0).max(1e10).optional(),
  annualDiscountPercent: z.coerce.number().int().min(0).max(90).optional(),
  minSeats: positiveInt.max(10_000).nullable().optional(),
  features: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  badge: z.string().trim().max(24).nullable().optional(),
  highlight: z.boolean().optional(),
  weeklyTokens: positiveInt.nullable().optional(),
  rollingTokens: positiveInt.nullable().optional(),
  monthlyTokens: positiveInt.nullable().optional(),
  tokensPerSeat: positiveInt.nullable().optional(),
  entitlements: entitlementsSchema.optional(),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100).optional(),
});

/** Edit a plan's price, copy, limits and entitlements — the Plans page and quota system follow within a minute. */
export async function saveCatalog(req: Request, res: Response) {
  const planId = z.enum(["free", "pro", "premium", "enterprise"]).parse(req.params.planId);
  const body = catalogSchema.parse(req.body);
  if (planId === "free" && body.monthlyPricePaise) throw new HttpError(400, "The Free plan can't have a price");
  const plan = await saveCatalogPlan(planId, body, req.user!.id);
  // Entitlements are cached per user for 30s; limits re-read the catalog on the next check.
  audit(req, "console.plans.catalog.save", "plan", planId, { fields: Object.keys(body) });
  res.json({ plan });
}

/** What a specific person can use right now (support: "why can't I use Deep Research?"). */
export async function userEntitlements(req: Request, res: Response) {
  const userId = await plans.resolveTargetUser(z.string().trim().min(3).parse(req.query.user));
  resolveEntitlements.invalidate(userId);
  res.json(await resolveEntitlements(userId));
}

const packageSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  target: z.enum(["individual", "organization"]),
  plan: z.enum(["free", "pro", "premium", "enterprise"]),
  monthlyTokenCap: positiveInt.nullable().optional(),
  seats: positiveInt.max(100_000).nullable().optional(),
  pooledMonthlyTokens: positiveInt.nullable().optional(),
  durationDays: positiveInt.max(3650).nullable().optional(),
  pricePaise: z.coerce.number().int().min(0).max(1e12).optional(),
  currency: z.string().length(3).optional(),
  features: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  active: z.boolean().optional(),
  public: z.boolean().optional(),
  entitlements: entitlementsSchema.optional(),
  badge: z.string().trim().max(24).nullable().optional(),
  highlight: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100).optional(),
});

export async function savePackage(req: Request, res: Response) {
  const body = packageSchema.parse(req.body);
  const pkg = await plans.savePackage(body, req.user!.id);
  audit(req, "console.plans.package.save", "package", pkg.id as string, { plan: body.plan });
  res.json({ package: pkg });
}

export async function deletePackage(req: Request, res: Response) {
  res.json(await plans.deletePackage(id.parse(req.params.packageId)));
}

const offerSchema = z.object({
  id: id.optional(),
  code: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  kind: z.enum(["plan_grant", "package", "discount"]),
  plan: z.enum(["pro", "premium"]).nullable().optional(),
  packageId: id.nullable().optional(),
  durationDays: positiveInt.max(3650).nullable().optional(),
  discountPercent: z.coerce.number().int().min(1).max(100).nullable().optional(),
  appliesToPlans: z.array(z.enum(["pro", "premium", "enterprise", "packages"])).optional(),
  eligibility: z.enum(["anyone", "new_users", "email_domain", "student"]),
  emailDomains: z.array(z.string().trim().max(120)).max(100).optional(),
  requiresApproval: z.boolean().optional(),
  maxRedemptions: positiveInt.nullable().optional(),
  startsAt: isoDate,
  expiresAt: isoDate,
  active: z.boolean().optional(),
});

export async function saveOffer(req: Request, res: Response) {
  const body = offerSchema.parse(req.body);
  const offer = await plans.saveOffer(body, req.user!.id);
  audit(req, "console.plans.offer.save", "offer", offer.id as string, { code: offer.code, kind: body.kind });
  res.json({ offer });
}

export async function deleteOffer(req: Request, res: Response) {
  res.json(await plans.deleteOffer(id.parse(req.params.offerId)));
}

export async function grant(req: Request, res: Response) {
  const body = z
    .object({
      user: z.string().trim().min(3).optional(),
      organizationId: id.optional(),
      packageId: id.optional(),
      plan: z.enum(["free", "pro", "premium", "enterprise"]).optional(),
      monthlyTokenCap: positiveInt.nullable().optional(),
      seats: positiveInt.max(100_000).nullable().optional(),
      pooledMonthlyTokens: positiveInt.nullable().optional(),
      durationDays: positiveInt.max(3650).nullable().optional(),
      note: z.string().max(500).default(""),
    })
    .parse(req.body);
  const userId = body.user ? await plans.resolveTargetUser(body.user) : null;
  const target = { userId, organizationId: body.organizationId ?? null };
  const result = body.packageId
    ? await plans.applyPackage(body.packageId, target, body.note, req.user!.id)
    : await plans.grantAccess(
        {
          ...target,
          plan: body.plan ?? "pro",
          monthlyTokenCap: body.monthlyTokenCap ?? null,
          seats: body.seats ?? null,
          pooledMonthlyTokens: body.pooledMonthlyTokens ?? null,
          durationDays: body.durationDays ?? null,
          source: "manual",
          note: body.note,
        },
        req.user!.id,
      );
  audit(req, "console.plans.grant", userId ? "user" : "organization", (userId ?? body.organizationId) as string, { plan: result.plan, endsAt: result.ends_at });
  res.status(201).json({ grant: result });
}

export async function revoke(req: Request, res: Response) {
  const grantId = id.parse(req.params.grantId);
  await plans.revokeGrant(grantId);
  audit(req, "console.plans.revoke", "grant", grantId);
  res.json({ ok: true });
}

export async function review(req: Request, res: Response) {
  const body = z.object({ approve: z.boolean(), note: z.string().max(1000).default("") }).parse(req.body);
  const { userId, offer } = await plans.reviewRedemption(id.parse(req.params.redemptionId), body.approve, body.note, req.user!.id);
  audit(req, body.approve ? "console.plans.approve" : "console.plans.reject", "redemption", req.params.redemptionId, { offer: offer.code });
  if (mailConfigured()) {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = data?.user?.email;
    if (email) {
      const message = body.approve
        ? `Good news — your request for **${offer.name}** was approved and it's active on your account now.${body.note ? `\n\n${body.note}` : ""}`
        : `We couldn't approve your request for **${offer.name}** this time.${body.note ? `\n\n${body.note}` : ""}\n\nReply to this email if you think that's a mistake.`;
      const sender = await fromAddress({ purpose: "support" });
      await sendEmail({ ...sender, to: email, subject: body.approve ? `${offer.name} is active` : `About your ${offer.name} request`, html: brandedEmail({ bodyHtml: renderMarkdown(message) }) }).catch(() => {});
    }
  }
  res.json({ ok: true });
}

// ── User side ───────────────────────────────────────────────────────────────

export async function redeem(req: Request, res: Response) {
  const body = z.object({ code: z.string().trim().min(3).max(40), proof: z.string().max(2000).default("") }).parse(req.body);
  res.json(await plans.redeem(req.user!.id, body.code, body.proof));
}

export async function mine(req: Request, res: Response) {
  res.json({ redemptions: await plans.myRedemptions(req.user!.id) });
}
