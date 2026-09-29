import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { SKILL_CATEGORIES } from "../services/skills/catalog.js";
import { createSkill, deleteSkill, getSkill, listSkills, setSkillEnabled, updateSkill } from "../services/skills/skillService.js";
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
