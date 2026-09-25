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
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

async function loadUserForToken(token: string): Promise<AuthedUser> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid or expired session");

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name, phone, birthday, role")
    .eq("id", data.user.id)
    .single();

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    name: profile?.full_name ?? (data.user.user_metadata?.full_name as string | undefined) ?? null,
    phone: profile?.phone ?? null,
    birthday: profile?.birthday ?? null,
    role: (profile?.role as "user" | "admin") ?? "user",
  };
}

// Verifying a token is two network round trips (Supabase Auth + the profile row) — ~300ms paid by EVERY
// request, including each message of a busy chat. The same token is presented repeatedly, so a short
// memo (single-flight, failures never cached) removes that from the critical path. Trade-off: a token
// revoked or a role changed is honoured for at most this long.
const loadUserCached = memoAsync(45_000, loadUserForToken, (token) => token);

/** Verifies the Supabase access token from the Authorization header and loads the user's profile/role. */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Missing bearer token");
  req.user = await loadUserCached(token);
  next();
});

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") throw new HttpError(403, "Admin access required");
  next();
}
