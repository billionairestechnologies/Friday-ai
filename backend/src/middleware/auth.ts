import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError, asyncHandler } from "./errorHandler.js";

export interface AuthedUser {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
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

/** Verifies the Supabase access token from the Authorization header and loads the user's profile/role. */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new HttpError(401, "Missing bearer token");

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid or expired session");

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name, phone, role")
    .eq("id", data.user.id)
    .single();

  req.user = {
    id: data.user.id,
    email: data.user.email ?? null,
    name: profile?.full_name ?? (data.user.user_metadata?.full_name as string | undefined) ?? null,
    phone: profile?.phone ?? null,
    role: (profile?.role as "user" | "admin") ?? "user",
  };
  next();
});

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") throw new HttpError(403, "Admin access required");
  next();
}
