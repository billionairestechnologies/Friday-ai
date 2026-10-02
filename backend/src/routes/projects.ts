import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { createProject, deleteProject, listProjects, updateProject } from "../services/projectService.js";
import { listConversations } from "../services/chat/index.js";
import multer from "multer";
import { MAX_FILE_BYTES, addProjectFile, deleteProjectFile, listProjectFiles, searchProject } from "../services/knowledge/projectKnowledge.js";
import { getOwnedProject } from "../services/projectService.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 10 } });

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

// Project knowledge: files every chat in the project can search (services/knowledge).
projectsRouter.get(
  "/:projectId/files",
  asyncHandler(async (req, res) => {
    res.json({ files: await listProjectFiles(req.user!.id, z.string().uuid().parse(req.params.projectId)) });
  }),
);

projectsRouter.post(
  "/:projectId/files",
  upload.array("files", 10),
  asyncHandler(async (req, res) => {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) {
      res.status(400).json({ error: "Choose at least one file" });
      return;
    }
    const added = [];
    for (const f of files) {
      // multer decodes multipart file names as latin1; restore UTF-8 names (Hindi, accents…).
      const filename = Buffer.from(f.originalname, "latin1").toString("utf8");
      added.push(await addProjectFile(req.user!.id, projectId, { filename, mime: f.mimetype, buffer: f.buffer }));
    }
    res.status(201).json({ files: added });
  }),
);

projectsRouter.delete(
  "/:projectId/files/:fileId",
  asyncHandler(async (req, res) => {
    await deleteProjectFile(req.user!.id, z.string().uuid().parse(req.params.projectId), z.string().uuid().parse(req.params.fileId));
    res.status(204).end();
  }),
);

projectsRouter.get(
  "/:projectId/search",
  asyncHandler(async (req, res) => {
    const projectId = z.string().uuid().parse(req.params.projectId);
    await getOwnedProject(req.user!.id, projectId);
    const { q } = z.object({ q: z.string().trim().min(1).max(500) }).parse(req.query);
    res.json({ results: await searchProject(projectId, q, 10) });
  }),
);
