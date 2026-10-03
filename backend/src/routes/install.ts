import { Router } from "express";
import { env } from "../config/env.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { installCmd, installPowerShell, installShell } from "../services/cli/installScripts.js";
import { assetSha256, assetUrl, latestVersion } from "../services/cli/releases.js";

/**
 * /x/* — the public, unauthenticated install surface for Friday X (mounted outside /api so the one-liner
 * stays short): the three installer scripts plus the plain-text endpoints they call.
 */
export const installRouter = Router();

installRouter.use(rateLimit({ name: "x-install", limit: 120, windowMs: 10 * 60_000 }));

// The scripts must say which server to call; PUBLIC_APP_URL is the canonical public origin (the request's
// own Host can be an internal proxy name behind the load balancer).
const origin = () => env.publicAppUrl;

installRouter.get("/install.sh", (_req, res) => {
  res.type("text/x-shellscript").setHeader("Cache-Control", "no-cache").send(installShell(origin()));
});
installRouter.get("/install.ps1", (_req, res) => {
  res.type("text/plain").setHeader("Cache-Control", "no-cache").send(installPowerShell(origin()));
});
installRouter.get("/install.cmd", (_req, res) => {
  res.type("text/plain").setHeader("Cache-Control", "no-cache").send(installCmd(origin()));
});

installRouter.get(
  "/version",
  asyncHandler(async (_req, res) => {
    res.type("text/plain").setHeader("Cache-Control", "no-cache").send(await latestVersion());
  }),
);

const versionOf = async (raw: unknown) => (typeof raw === "string" && raw && raw !== "latest" ? raw : latestVersion());

// Release notes the client shows after an update (`<version>.external.md` / `.external.json`). Served from the
// releases store when it has them; a missing file is a plain 404 (the client treats that as "no notes").
installRouter.get("/changelogs/:file", (req, res) => {
  const file = String(req.params.file);
  if (!/^[0-9A-Za-z._-]{1,80}\.external\.(md|json)$/.test(file) || !env.fridayXReleasesUrl) {
    res.status(404).end();
    return;
  }
  res.redirect(302, `${env.fridayXReleasesUrl}/changelogs/${file}`);
});

installRouter.get(
  "/download/:platform",
  asyncHandler(async (req, res) => {
    res.redirect(302, assetUrl(String(req.params.platform), await versionOf(req.query.version)));
  }),
);

installRouter.get(
  "/sha256/:platform",
  asyncHandler(async (req, res) => {
    res.type("text/plain").send(await assetSha256(String(req.params.platform), await versionOf(req.query.version)));
  }),
);
