import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  EXPORT_FORMATS,
  createPage,
  deletePage,
  exportPage,
  getPage,
  getSharedPage,
  getVersion,
  listPages,
  listVersions,
  restoreVersion,
  setSharing,
  updatePage,
  type PageKind, diffVersions, duplicatePage } from "../services/pages/pageService.js";
import type { DocFormat } from "../services/documents/render.js";
import { FORMAT_MIME } from "../services/documents/render.js";

/** Live pages (docs / sheets / slides): CRUD, versions, sharing, export. */
export const pagesRouter = Router();
const id = z.string().uuid();

// Public read-only view of a shared page — no auth, rate limited.
pagesRouter.get(
  "/shared/:token",
  rateLimit({ name: "shared-pages", limit: 300, windowMs: 15 * 60_000 }),
  asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json({ page: await getSharedPage(String(req.params.token)) });
  }),
);

pagesRouter.use(requireAuth);

pagesRouter.get("/", asyncHandler(async (req, res) => res.json({ pages: await listPages(req.user!.id) })));

pagesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = z.object({ kind: z.enum(["doc", "sheet", "slides"]), title: z.string().max(200).default("Untitled"), content: z.unknown().optional() }).parse(req.body);
    res.status(201).json({ page: await createPage(req.user!.id, { kind: input.kind as PageKind, title: input.title, content: input.content }) });
  }),
);

pagesRouter.get("/:pageId", asyncHandler(async (req, res) => res.json({ page: await getPage(req.user!.id, id.parse(req.params.pageId)) })));

pagesRouter.patch(
  "/:pageId",
  asyncHandler(async (req, res) => {
    const input = z.object({ title: z.string().max(200).optional(), content: z.unknown().optional(), baseVersion: z.number().int().positive() }).parse(req.body);
    res.json({ page: await updatePage(req.user!.id, id.parse(req.params.pageId), { ...input, author: "user" }) });
  }),
);

pagesRouter.delete(
  "/:pageId",
  asyncHandler(async (req, res) => {
    await deletePage(req.user!.id, id.parse(req.params.pageId));
    res.status(204).end();
  }),
);

pagesRouter.get("/:pageId/versions", asyncHandler(async (req, res) => res.json({ versions: await listVersions(req.user!.id, id.parse(req.params.pageId)) })));

pagesRouter.get(
  "/:pageId/versions/:version",
  asyncHandler(async (req, res) => res.json({ version: await getVersion(req.user!.id, id.parse(req.params.pageId), z.coerce.number().int().positive().parse(req.params.version)) })),
);

pagesRouter.post(
  "/:pageId/versions/:version/restore",
  asyncHandler(async (req, res) => res.json({ page: await restoreVersion(req.user!.id, id.parse(req.params.pageId), z.coerce.number().int().positive().parse(req.params.version)) })),
);

// What changed between two versions (`to` omitted = the current page).
pagesRouter.get(
  "/:pageId/diff",
  asyncHandler(async (req, res) => {
    const q = z.object({ from: z.coerce.number().int().positive(), to: z.coerce.number().int().positive().optional() }).parse(req.query);
    res.json(await diffVersions(req.user!.id, id.parse(req.params.pageId), q.from, q.to));
  }),
);

pagesRouter.post("/:pageId/duplicate", asyncHandler(async (req, res) => res.status(201).json({ page: await duplicatePage(req.user!.id, id.parse(req.params.pageId)) })));

pagesRouter.post(
  "/:pageId/share",
  asyncHandler(async (req, res) => {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    res.json({ page: await setSharing(req.user!.id, id.parse(req.params.pageId), on) });
  }),
);

pagesRouter.get(
  "/:pageId/export",
  asyncHandler(async (req, res) => {
    const all = [...new Set(Object.values(EXPORT_FORMATS).flat())] as [DocFormat, ...DocFormat[]];
    const { format } = z.object({ format: z.enum(all) }).parse(req.query);
    const out = await exportPage(req.user!.id, id.parse(req.params.pageId), format);
    res.setHeader("Content-Type", FORMAT_MIME[format]);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
    res.send(out.bytes);
  }),
);
