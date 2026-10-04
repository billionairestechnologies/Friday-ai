import type { NextFunction, Request, Response } from "express";
import { HttpError, asyncHandler } from "./errorHandler.js";
import { principalForToken } from "../services/cli/deviceAuth.js";
import { assertFridayX } from "../services/cli/gateway.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      cliTokenId?: string;
    }
  }
}

/**
 * Auth for /api/x/* — a FridayX token (`fxt_…`) issued by device login, NOT a Supabase session. A CLI token
 * only ever reaches this router, so a token lifted from a dotfile can't read chats, billing or connectors.
 * The FridayX entitlement is checked on every request, so an admin switching it off (or a plan change)
 * takes effect within the entitlement cache TTL instead of at the next login.
 */
export const requireCliAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Not signed in. Run `friday login`.");
  const principal = await principalForToken(token);
  if (!principal) throw new HttpError(401, "This session was signed out or has expired. Run `friday login`.");
  await assertFridayX(principal.userId);
  req.cliTokenId = principal.tokenId;
  // Only what rate limiting and quota keys need; profile fields are deliberately not loaded for a CLI call.
  req.user = { id: principal.userId, email: null, name: null, phone: null, birthday: null, role: "user", policyVersion: null };
  next();
});
