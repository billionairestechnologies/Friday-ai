import type { Request, Response } from "express";
import { z } from "zod";
import { supabasePublic } from "../config/supabasePublic.js";
import { HttpError } from "../middleware/errorHandler.js";

const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export async function signup(req: Request, res: Response) {
  const { name, email, password } = signupSchema.parse(req.body);

  const { data, error } = await supabasePublic.auth.signUp({
    email,
    password,
    options: { data: { full_name: name } },
  });

  if (error) throw new HttpError(400, error.message);

  res.status(201).json({
    user: data.user ? { id: data.user.id, email: data.user.email, name } : null,
    session: data.session,
    requiresEmailConfirmation: !data.session,
  });
}

export async function login(req: Request, res: Response) {
  const { email, password } = loginSchema.parse(req.body);

  const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
  if (error) throw new HttpError(401, "Invalid email or password");

  res.json({
    user: {
      id: data.user.id,
      email: data.user.email,
      name: (data.user.user_metadata?.full_name as string | undefined) ?? null,
    },
    session: data.session,
  });
}

export async function logout(_req: Request, res: Response) {
  // Sessions are stateless JWTs on the client; logout is just discarding the token there.
  res.status(204).send();
}

export async function me(req: Request, res: Response) {
  res.json({ user: req.user });
}

/** Google sign-in is wired for later — kept locked/disabled on the frontend for now. */
export async function googleSignIn(_req: Request, res: Response) {
  throw new HttpError(501, "Google sign-in is coming soon");
}
