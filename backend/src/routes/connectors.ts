import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  buildGitHubAuthorizeUrl,
  completeGitHubOAuth,
  connectorConfig,
  disconnectConnector,
  listConnectorAccounts,
  parseOAuthState,
  searchGitHubRepositories,
} from "../services/connectorService.js";
import { env } from "../config/env.js";

export const connectorsRouter = Router();

connectorsRouter.get(
  "/config",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ connectors: connectorConfig() });
  }),
);

connectorsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ accounts: await listConnectorAccounts(req.user!.id) });
  }),
);

connectorsRouter.get(
  "/github/start",
  requireAuth,
  asyncHandler(async (req, res) => {
    const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : null;
    res.json({ url: buildGitHubAuthorizeUrl(req.user!.id, returnTo) });
  }),
);

connectorsRouter.get(
  "/github/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) throw new HttpError(400, "Missing GitHub OAuth code or state");

    const { userId, returnTo } = parseOAuthState(state);
    await completeGitHubOAuth(userId, code);

    const target = new URL(returnTo, env.publicAppUrl);
    target.searchParams.set("connector", "github");
    target.searchParams.set("status", "connected");
    res.redirect(target.toString());
  }),
);

connectorsRouter.delete(
  "/:provider",
  requireAuth,
  asyncHandler(async (req, res) => {
    const provider = z.enum(["github"]).parse(req.params.provider);
    await disconnectConnector(req.user!.id, provider);
    res.status(204).send();
  }),
);

connectorsRouter.get(
  "/github/repos",
  requireAuth,
  asyncHandler(async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ repositories: await searchGitHubRepositories(req.user!.id, query) });
  }),
);
