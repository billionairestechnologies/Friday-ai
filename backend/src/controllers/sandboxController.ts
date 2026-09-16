import type { Request, Response } from "express";
import { z } from "zod";
import * as codesandboxService from "../services/codesandboxService.js";

const runSchema = z.object({
  language: z.enum(["python", "javascript"]),
  code: z.string().min(1, "Code cannot be empty").max(50_000),
});

export async function run(req: Request, res: Response) {
  const { language, code } = runSchema.parse(req.body);
  const result = await codesandboxService.runCode(req.user!.id, language, code);
  res.json(result);
}
