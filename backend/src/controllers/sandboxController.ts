import type { Request, Response } from "express";
import { z } from "zod";
import * as e2bService from "../services/e2bService.js";

const runSchema = z.object({
  language: z.enum(["python", "javascript"]),
  code: z.string().min(1, "Code cannot be empty").max(50_000),
  // Defaults on: Canvas auto-runs code the moment it lands, and a failure should self-heal
  // rather than just hand the user a stack trace — see runWithAutoFix's own comment for the
  // attempt cap. Callers doing an explicit manual re-run of unmodified code can still turn it
  // off to avoid silently rewriting code the user is looking at.
  autoFix: z.boolean().default(true),
});

export async function run(req: Request, res: Response) {
  const { language, code, autoFix } = runSchema.parse(req.body);
  if (autoFix) {
    res.json(await e2bService.runWithAutoFix(req.user!.id, language, code));
    return;
  }
  const result = await e2bService.runCode(req.user!.id, language, code);
  res.json({ ...result, code, attempts: [{ code, result }] });
}
