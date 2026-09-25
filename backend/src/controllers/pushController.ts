import type { Request, Response } from "express";
import { z } from "zod";
import * as push from "../services/pushService.js";

const registerSchema = z.object({
  platform: z.enum(["web", "android", "ios"]),
  token: z.string().min(10).max(4096),
  keys: z.object({ p256dh: z.string(), auth: z.string() }).optional(),
});

export function config(_req: Request, res: Response) {
  res.json({ vapidPublicKey: push.getVapidPublicKey() });
}

export async function register(req: Request, res: Response) {
  const { platform, token, keys } = registerSchema.parse(req.body);
  if (platform === "web" && !keys) {
    res.status(400).json({ error: "Web push subscriptions need keys" });
    return;
  }
  await push.saveSubscription(req.user!.id, platform, token, keys ?? null);
  res.status(204).end();
}

export async function unregister(req: Request, res: Response) {
  const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
  await push.removeSubscription(req.user!.id, token);
  res.status(204).end();
}
