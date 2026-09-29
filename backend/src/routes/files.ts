import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { deleteFile, fileBytes, listFiles, storageUsedBytes } from "../services/documents/documentService.js";
import { entitlementsFor } from "../services/quota/entitlements.js";

/** /api/files — the signed-in user's generated documents (also listed in the Library). */
export const filesRouter = Router();
filesRouter.use(requireAuth);

const id = z.string().uuid();

filesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const [files, used, entitlements] = await Promise.all([listFiles(req.user!.id), storageUsedBytes(req.user!.id).catch(() => 0), entitlementsFor(req.user!.id)]);
    res.json({ files, storage: { usedBytes: used, limitBytes: entitlements.libraryStorageMb * 1024 * 1024 } });
  }),
);

filesRouter.get(
  "/:id/download",
  asyncHandler(async (req, res) => {
    const file = await fileBytes(req.user!.id, id.parse(req.params.id));
    const ascii = file.filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Length", String(file.bytes.length));
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(file.bytes);
  }),
);

filesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteFile(req.user!.id, id.parse(req.params.id));
    res.status(204).end();
  }),
);
