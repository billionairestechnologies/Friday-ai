import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { createProject, listProjects } from "../services/projectService.js";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(["personal", "work", "developer"]).default("work"),
  instructions: z.string().trim().max(4_000).optional().default(""),
  repositoryUrl: z.string().trim().url().optional().or(z.literal("")).transform((value) => value || null),
});

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ projects: await listProjects(req.user!.id) });
  }),
);

projectsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    const project = await createProject(
      req.user!.id,
      input.name,
      input.mode,
      input.instructions,
      input.repositoryUrl,
    );
    res.status(201).json({ project });
  }),
);
