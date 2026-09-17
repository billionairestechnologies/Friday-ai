import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  buildGitHubAuthorizeUrl,
  buildGoogleAuthorizeUrl,
  completeGitHubOAuth,
  completeGoogleOAuth,
  connectTokenConnector,
  connectorConfig,
  disconnectConnector,
  listConnectorAccounts,
  parseOAuthState,
  previewConnector,
  searchGitHubRepositories,
} from "../services/connectorService.js";
import { isTokenConnector } from "../services/tokenConnectors.js";
import { env } from "../config/env.js";

export const connectorsRouter = Router();
const providerParam = z.enum([
  "github",
  "google",
  "notion",
  "supabase",
  "railway",
  "finance",
  "box",
  "canva",
  "razorpay",
  "vercel",
]);

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
  "/google/start",
  requireAuth,
  asyncHandler(async (req, res) => {
    const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : null;
    res.json({ url: buildGoogleAuthorizeUrl(req.user!.id, returnTo) });
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

connectorsRouter.get(
  "/google/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) throw new HttpError(400, "Missing Google OAuth code or state");

    const { userId, returnTo } = parseOAuthState(state);
    await completeGoogleOAuth(userId, code);

    const target = new URL(returnTo, env.publicAppUrl);
    target.searchParams.set("connector", "google");
    target.searchParams.set("status", "connected");
    res.redirect(target.toString());
  }),
);

connectorsRouter.post(
  "/:provider",
  requireAuth,
  asyncHandler(async (req, res) => {
    const provider = providerParam.parse(req.params.provider);
    if (!isTokenConnector(provider)) {
      throw new HttpError(400, "This connector uses OAuth. Use the Connect button instead.");
    }
    const body = z
      .object({
        token: z.string().trim().min(8).max(8_000),
        secret: z.string().trim().min(8).max(8_000).optional(),
        url: z.string().trim().url().optional(),
      })
      .parse(req.body);
    res.status(201).json({ account: await connectTokenConnector(req.user!.id, provider, body) });
  }),
);

connectorsRouter.get(
  "/:provider/preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const provider = providerParam.parse(req.params.provider);
    const query = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ items: await previewConnector(req.user!.id, provider, query) });
  }),
);

connectorsRouter.delete(
  "/:provider",
  requireAuth,
  asyncHandler(async (req, res) => {
    const provider = providerParam.parse(req.params.provider);
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
