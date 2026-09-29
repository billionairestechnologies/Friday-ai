import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError, asyncHandler } from "./errorHandler.js";
import { memoAsync } from "../utils/ttlMemo.js";

export interface AuthedUser {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  /** ISO date (YYYY-MM-DD), optional — powers the birthday greeting and age-banded thinking lines. */
  birthday: string | null;
  role: "user" | "admin";
  /** The Privacy Policy/Terms version this account last agreed to, or null if never. Compared
   *  against POLICY_VERSION (backend/src/services/policyService.ts) by every client to decide
   *  whether to show the blocking "I agree" gate. */
  policyVersion: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
      authToken?: string;
    }
  }
}

async function loadUserForToken(token: string): Promise<AuthedUser> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid or expired session");

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name, phone, birthday, role, policy_version")
    .eq("id", data.user.id)
    .single();

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    name: profile?.full_name ?? (data.user.user_metadata?.full_name as string | undefined) ?? null,
    phone: profile?.phone ?? null,
    birthday: profile?.birthday ?? null,
    role: (profile?.role as "user" | "admin") ?? "user",
    policyVersion: profile?.policy_version ?? null,
  };
}

// Verifying a token is two network round trips (Supabase Auth + the profile row) — ~300ms paid by EVERY
// request, including each message of a busy chat. The same token is presented repeatedly, so a short
// memo (single-flight, failures never cached) removes that from the critical path. Trade-off: a token
// revoked or a role changed is honoured for at most this long.
const loadUserCached = memoAsync(45_000, loadUserForToken, (token) => token);

/** Drops a token's cached profile immediately — call right after a mutation to a field this
 *  cache serves (role, policy acceptance) so the next request doesn't see a stale value for up
 *  to the cache's TTL. The token is the same bearer value requireAuth cached it under. */
export function invalidateAuthedUser(token: string) {
  loadUserCached.invalidate(token);
}

/** Verifies the Supabase access token from the Authorization header and loads the user's profile/role. */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Missing bearer token");
  req.authToken = token;
  req.user = await loadUserCached(token);
  next();
});

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") throw new HttpError(403, "Admin access required");
  next();
}
