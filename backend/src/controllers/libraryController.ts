import type { Request, Response } from "express";
import { z } from "zod";
import * as library from "../services/libraryService.js";

export async function list(req: Request, res: Response) {
  const { category } = z.object({ category: z.string().max(40).optional() }).parse(req.query);
  const items = await library.listLibrary(req.user!.id, category);
  res.json({ categories: ["Documents", ...library.LIBRARY_CATEGORIES, "Uploads"], items });
}

export async function get(req: Request, res: Response) {
  res.json({ item: await library.getItem(req.user!.id, req.params.id) });
}

export async function upload(req: Request, res: Response) {
  res.json(await library.uploadUrl(req.user!.id, z.string().uuid().parse(req.params.id)));
}

export async function remove(req: Request, res: Response) {
  await library.deleteItem(req.user!.id, req.params.id);
  res.status(204).end();
}
