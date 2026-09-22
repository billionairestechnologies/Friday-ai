import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";

export const appRouter = Router();

const PLATFORMS = {
  android: { version: env.latestVersionAndroid, url: env.downloadAndroid, notes: env.latestNotesAndroid },
  mac: { version: env.latestVersionMac, url: env.downloadMac, notes: env.latestNotesMac },
  windows: { version: env.latestVersionWindows, url: env.downloadWindows, notes: env.latestNotesWindows },
} as const;

// Public in-app update check — no auth needed, and clients should be able to see there's an
// update even when their session is stale. ?platform= defaults to "android" for the mobile app.
appRouter.get(
  "/version",
  asyncHandler(async (req, res) => {
    const platform = String(req.query.platform ?? "android").toLowerCase();
    const info = PLATFORMS[platform as keyof typeof PLATFORMS];
    if (!info || !info.version || !info.url) {
      res.json({ latestVersion: null, url: null, notes: null });
      return;
    }
    res.json({ latestVersion: info.version, url: info.url, notes: info.notes || null });
  }),
);
