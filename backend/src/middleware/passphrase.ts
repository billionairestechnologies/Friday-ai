import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "./errorHandler.js";
import { assertPassphrase } from "../services/air/passphrase.js";

/** Pay, send, and delete ask for the spoken passphrase once the user has set one. */
export const requirePassphrase = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  await assertPassphrase(req.user!.id, req.header("x-friday-passphrase") ?? undefined);
  next();
});
