import type { Request, Response } from "express";
import { z } from "zod";
import * as library from "../services/libraryService.js";

export async function list(req: Request, res: Response) {
  const { category } = z.object({ category: z.string().max(40).optional() }).parse(req.query);
  const items = await library.listItems(req.user!.id, category);
  res.json({ categories: library.LIBRARY_CATEGORIES, items });
}

export async function get(req: Request, res: Response) {
  res.json({ item: await library.getItem(req.user!.id, req.params.id) });
}

export async function remove(req: Request, res: Response) {
  await library.deleteItem(req.user!.id, req.params.id);
  res.status(204).end();
}
