import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { createProject, deleteProject, listProjects, updateProject } from "../services/projectService.js";
import { listConversations } from "../services/chat/index.js";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(["personal", "work", "developer"]).default("work"),
  description: z.string().trim().max(500).optional().default(""),
  instructions: z.string().trim().max(4_000).optional().default(""),
  repositoryUrl: z.string().trim().url().optional().or(z.literal("")).transform((value) => value || null),
});

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(["personal", "work", "developer"]).optional(),
  description: z.string().trim().max(500).optional(),
  instructions: z.string().trim().max(4_000).optional(),
  repositoryUrl: z
    .string()
    .trim()
    .url()
    .optional()
    .or(z.literal(""))
    .transform((value) => (value === undefined ? undefined : value || null)),
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
      input.description,
    );
    res.status(201).json({ project });
  }),
);

projectsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = updateProjectSchema.parse(req.body);
    const project = await updateProject(req.user!.id, req.params.id, input);
    res.json({ project });
  }),
);

projectsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteProject(req.user!.id, req.params.id);
    res.status(204).send();
  }),
);

/** A project's own chats — kept out of the main /chat/conversations list (project-scoped only). */
projectsRouter.get(
  "/:id/conversations",
  asyncHandler(async (req, res) => {
    res.json({ conversations: await listConversations(req.user!.id, {}, req.params.id) });
  }),
);
