import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { SKILL_CATEGORIES } from "../services/skills/catalog.js";
import { createSkill, deleteSkill, getSkill, listSkills, publishDraft, rollbackSkill, runSkillEvals, saveDraft, setSkillEnabled, setSkillStatus, skillDetail, updateSkill } from "../services/skills/skillService.js";
import { CAPABILITIES } from "../services/skills/manifest.js";
import { checkAndReserve, canUseModelTier } from "../services/quota/tokenQuotaService.js";
import { UsageMeter } from "../services/quota/usageMeter.js";
import { meteredChat, withMeter } from "../services/quota/meterContext.js";
import { getWorkingKeyForProvider, listChatCandidates } from "../services/providerService.js";
import { getProviderAdapter } from "../services/providers/registry.js";
import { HttpError } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { entitlementsFor } from "../services/quota/entitlements.js";

/** /api/skills — the signed-in user's skills: built-in catalog + their own. */
export const skillsRouter = Router();
skillsRouter.use(requireAuth);

const skillId = z.string().trim().min(1).max(80);
const skillBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  instructions: z.string().trim().min(20, "Write at least a sentence or two of instructions").max(12000),
  icon: z.string().trim().max(8).optional(),
  enabled: z.boolean().optional(),
});

skillsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const [skills, entitlements] = await Promise.all([listSkills(req.user!.id), entitlementsFor(req.user!.id)]);
    res.json({ categories: [...SKILL_CATEGORIES, "My skills"], skills, limits: { customSkills: entitlements.customSkills } });
  }),
);
// ── Skill Builder (supabase 0065, services/skills/manifest.ts) ──────────────────────────────────
skillsRouter.get("/builder/capabilities", (_req, res) => {
  res.json({ capabilities: Object.entries(CAPABILITIES).map(([id, c]) => ({ id, label: c.label, risk: c.risk })) });
});
skillsRouter.post("/builder/draft", asyncHandler(async (req, res) => res.status(201).json(await saveDraft(req.user!.id, null, req.body))));
skillsRouter.patch("/:id/draft", asyncHandler(async (req, res) => res.json(await saveDraft(req.user!.id, skillId.parse(req.params.id), req.body))));
skillsRouter.get("/:id/builder", asyncHandler(async (req, res) => res.json(await skillDetail(req.user!.id, skillId.parse(req.params.id)))));
skillsRouter.post(
  "/:id/publish",
  asyncHandler(async (req, res) => res.json(await publishDraft(req.user!.id, skillId.parse(req.params.id), z.object({ changelog: z.string().trim().max(500).default("") }).parse(req.body).changelog))),
);
skillsRouter.post("/:id/rollback", asyncHandler(async (req, res) => res.json(await rollbackSkill(req.user!.id, skillId.parse(req.params.id), z.object({ version: z.number().int().positive() }).parse(req.body).version))));
skillsRouter.post(
  "/:id/status",
  asyncHandler(async (req, res) => {
    await setSkillStatus(req.user!.id, skillId.parse(req.params.id), z.object({ status: z.enum(["published", "disabled"]) }).parse(req.body).status);
    res.json({ ok: true });
  }),
);
/**
 * Runs the draft's test cases: one model call each, the skill active, no tools. Charged to the
 * user's own allowance like any chat (reserve → meter → settle), so testing can't run past it.
 */
skillsRouter.post(
  "/:id/evals",
  rateLimit({ name: "skill-evals", limit: 20, windowMs: 60 * 60_000 }),
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const pool = await listChatCandidates();
    let candidate = null;
    for (const c of pool) if (await canUseModelTier(userId, c.minTier)) { candidate = c; break; }
    if (!candidate) throw new HttpError(503, "No model is available to run the tests.");
    const reserved = await checkAndReserve(userId, 20_000, { feature: "chat" });
    if (!reserved.allowed) throw new HttpError(429, "You don't have enough tokens left this month to run the tests.");
    const meter = new UsageMeter(reserved.reservation, { userId, organizationId: reserved.reservation.organizationId, feature: "chat" });
    try {
      const adapter = getProviderAdapter(candidate.slug);
      const apiKey = await getWorkingKeyForProvider(candidate.slug);
      const out = await withMeter(meter, () =>
        runSkillEvals(userId, skillId.parse(req.params.id), (system, prompt) => {
          const messages = [{ role: "system" as const, content: system }, { role: "user" as const, content: prompt }];
          return meteredChat(candidate!, messages, () => adapter.chat(apiKey, candidate!.modelId, messages), { chargeable: true });
        }),
      );
      res.json({ ...out, model: candidate.displayName });
    } finally {
      await meter.settle();
    }
  }),
);

skillsRouter.get("/:id", asyncHandler(async (req, res) => res.json({ skill: await getSkill(req.user!.id, skillId.parse(req.params.id)) })));
skillsRouter.post("/", asyncHandler(async (req, res) => res.status(201).json({ skill: await createSkill(req.user!.id, skillBody.parse(req.body)) })));
skillsRouter.patch("/:id", asyncHandler(async (req, res) => res.json({ skill: await updateSkill(req.user!.id, skillId.parse(req.params.id), skillBody.partial().parse(req.body)) })));
skillsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteSkill(req.user!.id, skillId.parse(req.params.id));
    res.status(204).end();
  }),
);
skillsRouter.post(
  "/:id/enabled",
  asyncHandler(async (req, res) => {
    await setSkillEnabled(req.user!.id, skillId.parse(req.params.id), z.object({ enabled: z.boolean() }).parse(req.body).enabled);
    res.json({ ok: true });
  }),
);
