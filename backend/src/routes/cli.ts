import express, { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../config/supabase.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { requireCliAuth } from "../middleware/cliAuth.js";
import { HttpError, asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  decideDeviceRequest,
  describeDeviceRequest,
  listCliSessions,
  pollDeviceAuthorization,
  revokeCliSession,
  startDeviceAuthorization,
} from "../services/cli/deviceAuth.js";
import { createTicket } from "../services/console/supportService.js";
import { markSeen, pendingForUser } from "../services/console/announcementService.js";
import { connectedAppsSummary, handleMcpRequest, pluginCatalog } from "../services/cli/mcpServer.js";
import { AUTO_MODEL, assertFridayX, cliSettings, cliStatus, cliUser, listCliModels, runCompletion, type CompletionRequest } from "../services/cli/gateway.js";

/**
 * FridayX API (terminal + IDE). Three audiences share one router, each behind its own gate:
 *   public   — the device-login handshake the CLI starts before it has any identity
 *   web      — the signed-in browser approving a code and managing its signed-in devices
 *   cli      — everything the harness calls with a FridayX token (/me, /models, the model gateway)
 */
export const cliRouter = Router();

// Plans, models and limits are edited in the Console at any time and must show up in every client at once,
// so nothing under /api/x that describes them is ever cached by a client or proxy.
cliRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const startLimit = rateLimit({ name: "x-device-start", limit: 20, windowMs: 10 * 60_000 });
// Polling is every 5s by design; the limit only has to stop abuse, not pace a well-behaved client.
const pollLimit = rateLimit({ name: "x-device-poll", limit: 400, windowMs: 10 * 60_000 });
const approveLimit = rateLimit({ name: "x-device-approve", limit: 30, windowMs: 10 * 60_000 });
const gatewayLimit = rateLimit({ name: "x-gateway", limit: 240, windowMs: 60_000 });

// ── public: device login ────────────────────────────────────────────────────────────────────────
cliRouter.post(
  "/auth/device",
  startLimit,
  asyncHandler(async (req, res) => {
    const body = z.object({ client_name: z.string().max(80).optional(), client_version: z.string().max(40).optional() }).parse(req.body ?? {});
    const started = await startDeviceAuthorization({ name: body.client_name, version: body.client_version });
    const base = env.publicAppUrl.replace(/\/$/, "");
    res.json({
      ...started,
      verification_uri: `${base}/device`,
      verification_uri_complete: `${base}/device?code=${encodeURIComponent(started.user_code)}`,
    });
  }),
);

cliRouter.post(
  "/auth/token",
  pollLimit,
  asyncHandler(async (req, res) => {
    const { device_code } = z.object({ device_code: z.string().min(20).max(200) }).parse(req.body ?? {});
    const result = await pollDeviceAuthorization(device_code);
    if (result.status === "approved") {
      const { data } = await supabaseAdmin.auth.admin.getUserById(result.userId);
      const { data: profile } = await supabaseAdmin.from("profiles").select("full_name").eq("id", result.userId).maybeSingle();
      res.json({
        access_token: result.token,
        token_type: "Bearer",
        user: { id: result.userId, email: data.user?.email ?? null, name: profile?.full_name ?? null },
      });
      return;
    }
    // RFC 8628 §3.5 error codes, so a stock OAuth device client understands them.
    const error = { pending: "authorization_pending", slow_down: "slow_down", expired: "expired_token", denied: "access_denied" }[result.status];
    res.status(400).json({ error });
  }),
);

// ── public: the same handshake under the standard OAuth2 names ───────────────────────────────────
// The terminal/editor client's existing device-code login speaks plain RFC 8628 (`/oauth2/device/code`,
// `/oauth2/token`, form-encoded). Serving those names means that login code runs against Friday unchanged;
// /auth/device + /auth/token above stay for clients that prefer JSON.
const CLIENT_NAMES: Record<string, string> = {
  "friday-x-cli": "FridayX (terminal)",
  "friday-x-vscode": "FridayX for VS Code",
  "friday-x-jetbrains": "FridayX for JetBrains",
  "friday-x-zed": "FridayX for Zed",
};
const clientNameFor = (clientId: unknown, fallback?: unknown) =>
  CLIENT_NAMES[String(clientId ?? "")] ?? (typeof fallback === "string" && fallback ? fallback : "FridayX");

const oauthErrorDescriptions: Record<string, string> = {
  authorization_pending: "The user hasn't approved this sign-in yet.",
  slow_down: "Polling too fast; wait before trying again.",
  expired_token: "This code expired. Run `friday login` again.",
  access_denied: "The sign-in was denied.",
};

cliRouter.post(
  "/oauth2/device/code",
  express.urlencoded({ extended: false, limit: "8kb" }),
  startLimit,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const started = await startDeviceAuthorization({ name: clientNameFor(body.client_id), version: String(req.headers["x-friday-client-version"] ?? "") || undefined });
    const base = env.publicAppUrl.replace(/\/$/, "");
    res.json({ ...started, verification_uri: `${base}/device`, verification_uri_complete: `${base}/device?code=${encodeURIComponent(started.user_code)}` });
  }),
);

cliRouter.post(
  "/oauth2/token",
  express.urlencoded({ extended: false, limit: "8kb" }),
  pollLimit,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
      res.status(400).json({ error: "unsupported_grant_type", error_description: "Only the device code grant is supported." });
      return;
    }
    const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
    if (deviceCode.length < 20 || deviceCode.length > 200) {
      res.status(400).json({ error: "invalid_request", error_description: "device_code is missing or malformed." });
      return;
    }
    const result = await pollDeviceAuthorization(deviceCode);
    if (result.status === "approved") {
      // The token doesn't expire by itself (it's revoked from Settings), so the lifetime is long and a 401 means "sign in again".
      res.json({ access_token: result.token, token_type: "Bearer", expires_in: 365 * 24 * 3600, scope: "friday-x" });
      return;
    }
    const error = { pending: "authorization_pending", slow_down: "slow_down", expired: "expired_token", denied: "access_denied" }[result.status];
    res.status(400).json({ error, error_description: oauthErrorDescriptions[error] });
  }),
);

// ── web: approve a code, manage signed-in devices ──────────────────────────────────────────────
cliRouter.get(
  "/auth/device/:code",
  requireAuth,
  approveLimit,
  asyncHandler(async (req, res) => {
    await assertFridayX(req.user!.id);
    res.json(await describeDeviceRequest(String(req.params.code)));
  }),
);

for (const decision of ["approve", "deny"] as const) {
  cliRouter.post(
    `/auth/device/${decision}`,
    requireAuth,
    approveLimit,
    asyncHandler(async (req, res) => {
      const { user_code } = z.object({ user_code: z.string().min(4).max(20) }).parse(req.body ?? {});
      if (decision === "approve") await assertFridayX(req.user!.id);
      await decideDeviceRequest(req.user!.id, user_code, decision === "approve");
      res.json({ ok: true });
    }),
  );
}

cliRouter.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ sessions: await listCliSessions(req.user!.id) });
  }),
);

cliRouter.delete(
  "/sessions/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeCliSession(req.user!.id, String(req.params.id));
    res.json({ ok: true });
  }),
);

// ── cli: everything below needs a FridayX token ───────────────────────────────────────────────
cliRouter.post(
  "/auth/logout",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    await revokeCliSession(req.user!.id, req.cliTokenId!);
    res.json({ ok: true });
  }),
);

cliRouter.get(
  "/me",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const [{ data }, profile, status] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(userId),
      supabaseAdmin.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
      cliStatus(userId),
    ]);
    res.json({ user: { id: userId, email: data.user?.email ?? null, name: profile.data?.full_name ?? null }, ...status });
  }),
);

// What's New for editors: the same published updates the web app shows (same audience rules, same "seen once per
// account" ledger), so an announcement published in the Console reaches the IDE panel without a client release.
cliRouter.get(
  "/updates",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    res.json({ updates: await pendingForUser(req.user!.id, "web") });
  }),
);

cliRouter.post(
  "/updates/seen",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ ids: z.array(z.string().uuid()).max(10), clickedId: z.string().uuid().optional() }).parse(req.body ?? {});
    await markSeen(req.user!.id, body.ids, body.clickedId);
    res.json({ ok: true });
  }),
);

cliRouter.get(
  "/models",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    res.json(await listCliModels(req.user!.id));
  }),
);

// OpenAI-style listing, for editor integrations that probe `/v1/models`.
cliRouter.get(
  "/v1/models",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    const { models } = await listCliModels(req.user!.id);
    // Extra fields beyond the OpenAI shape are what the harness reads to budget context and pick the wire format;
    // plan-locked models are simply absent here (the richer /models above flags them for a picker that wants to upsell).
    res.json({
      object: "list",
      data: [
        // The server-side router: whatever coding model this user's plan allows right now. Listed first so it is the default.
        {
          id: AUTO_MODEL,
          object: "model",
          owned_by: "friday",
          name: "FridayX (auto)",
          description: "The best coding model your Friday plan allows. The server picks it, so it improves without an update.",
          context_window: 200_000,
          api_backend: "chat_completions",
          supports_vision: false,
        },
        ...models
        .filter((m) => !m.locked)
        .map((m) => ({
          id: m.id,
          object: "model",
          // Never the vendor: FridayX shows model names only (the provider is Friday's business, not the user's).
          owned_by: "friday",
          name: m.name,
          description: m.recommended ? "Recommended for coding" : "",
          context_window: m.contextWindow,
          api_backend: "chat_completions",
          supports_vision: m.vision,
        })),
      ],
    });
  }),
);

// Friday's connectors as an MCP server (stateless JSON-RPC over Streamable HTTP); see services/cli/mcpServer.ts.
cliRouter.post(
  "/mcp",
  requireCliAuth,
  gatewayLimit,
  asyncHandler(async (req, res) => {
    const body = req.body;
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map((m) => handleMcpRequest(req.user!.id, m ?? {})))).filter(Boolean);
      return replies.length ? res.json(replies) : res.status(202).end();
    }
    const reply = await handleMcpRequest(req.user!.id, body ?? {});
    return reply ? res.json(reply) : res.status(202).end();
  }),
);
cliRouter.get("/mcp", (_req, res) => res.status(405).setHeader("Allow", "POST").end());

// Feedback from the terminal lands in the Team Console as a support ticket (category "feedback"), like every other channel.
const feedbackLimit = rateLimit({ name: "x-feedback", limit: 20, windowMs: 60 * 60_000 });
cliRouter.post(
  "/v1/feedback",
  requireCliAuth,
  feedbackLimit,
  asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = String(b.feedbackText ?? b.feedback_text ?? "").trim().slice(0, 8000);
    const rating = typeof b.ratingValue === "number" ? b.ratingValue : typeof b.rating_value === "number" ? b.rating_value : null;
    const cats = Array.isArray(b.feedbackCategories) ? b.feedbackCategories.map(String).slice(0, 8).join(", ") : "";
    const userId = req.user!.id;
    const [{ data }, profile] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(userId),
      supabaseAdmin.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
    ]);
    const lines = [
      text || "(no text — rating only)",
      "",
      `— from FridayX${typeof b.shellVersion === "string" ? ` ${b.shellVersion.slice(0, 20)}` : ""}`,
      rating !== null ? `Rating: ${rating}` : "",
      cats ? `Categories: ${cats}` : "",
      typeof b.modelId === "string" ? `Model: ${b.modelId.slice(0, 80)}` : "",
    ].filter((l, i) => i < 2 || l);
    const ticket = await createTicket({
      userId,
      email: data.user?.email ?? "unknown@friday.local",
      name: profile.data?.full_name ?? "FridayX user",
      subject: `FridayX feedback: ${(text || "rating").replace(/\s+/g, " ").slice(0, 80)}`,
      body: lines.join("\n"),
      category: "feedback",
      channel: "app",
    });
    res.json({ feedbackId: String(ticket.id), createdAt: new Date().toISOString() });
  }),
);

// The plugin catalog the terminal mirrors into its Plugins / Marketplace tabs (see services/cli/mcpServer.ts).
cliRouter.get(
  "/v1/plugins",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    res.json(await pluginCatalog(req.user!.id));
  }),
);

cliRouter.get(
  "/v1/connectors",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    res.json(await connectedAppsSummary(req.user!.id));
  }),
);

cliRouter.get(
  "/v1/user",
  requireCliAuth,
  asyncHandler(async (req, res) => {
    res.json(await cliUser(req.user!.id));
  }),
);

cliRouter.get(
  "/v1/settings",
  requireCliAuth,
  asyncHandler(async (_req, res) => {
    res.json(cliSettings());
  }),
);

cliRouter.post(
  "/v1/chat/completions",
  requireCliAuth,
  gatewayLimit,
  asyncHandler(async (req, res) => {
    if (typeof req.body !== "object" || req.body === null) throw new HttpError(400, "Send a JSON body.");
    // Aborts the provider call when the terminal closes or Ctrl-C's — otherwise a cancelled turn keeps spending credits.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    await runCompletion(req.user!.id, req.body as CompletionRequest, res, controller.signal);
  }),
);
