import { z } from "zod";

/**
 * Server-side check of the structured blocks a model may put in an answer (brief §14, §36.4):
 *
 *   ```friday-chart       {"type":"bar"|"line","title"?,"x":[…],"series":[{"name","values":[…]}],"unit"?,"source"?}
 *   ```friday-experience  {"experience":"offside"|"emi"|"projectile","params":{…},"title"?}
 *
 * They carry DATA for allow-listed components — never markup or code. The final answer is checked
 * before it's saved: a block that doesn't validate is stored as a plain ```json block, so it shows as
 * readable code everywhere (and older/mobile clients never meet an unknown block). The web client
 * re-validates with the same limits (frontend/src/lib/experiences/*) — test/experiences.test.ts
 * proves the two agree.
 */

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const label = z.string().max(200);

export const chartSchema = z
  .object({
    type: z.enum(["bar", "line"]),
    title: label.optional(),
    x: z.array(z.union([z.string(), z.number()])).min(1).max(60),
    series: z.array(z.object({ name: label.optional(), values: z.array(z.number().finite()) })).min(1).max(6),
    unit: z.string().max(40).optional(),
    source: z.string().max(400).optional(),
  })
  .refine((c) => c.series.every((s) => s.values.length === c.x.length), "every series needs one value per x label");

const restart = z.enum(["open_play", "goal_kick", "throw_in", "corner_kick"]);
const PARAMS = {
  offside: z
    .object({ receiverX: num(0, 105), defenderX: num(0, 105), goalkeeperX: num(0, 105), ballX: num(0, 105), involvedInPlay: z.boolean(), restart })
    .partial()
    .strict(),
  emi: z.object({ principal: num(10_000, 100_000_000), annualRatePct: num(0, 36), months: num(1, 480) }).partial().strict(),
  projectile: z.object({ speed: num(1, 200), angleDeg: num(1, 89), planet: z.enum(["earth", "moon", "mars", "jupiter"]) }).partial().strict(),
} as const;

export const experienceSchema = z
  .object({ experience: z.enum(["offside", "emi", "projectile"]), params: z.record(z.unknown()).optional(), title: label.optional() })
  .strict()
  .superRefine((b, ctx) => {
    const r = PARAMS[b.experience].safeParse(b.params ?? {});
    if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `bad ${b.experience} params` });
  });

const MAX_BLOCK = 16_000;
const BLOCK = /```(friday-chart|friday-experience)[^\n]*\n([\s\S]*?)```/g;

export function validStructuredBlock(lang: string, body: string): boolean {
  if (body.length > MAX_BLOCK) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return false;
  }
  return (lang === "friday-chart" ? chartSchema : experienceSchema).safeParse(raw).success;
}

/** Rewrites every invalid structured block to a plain ```json block; valid ones are left untouched. */
export function sanitizeStructuredBlocks(text: string): string {
  if (!text.includes("```friday-")) return text;
  return text.replace(BLOCK, (whole, lang: string, body: string) => (validStructuredBlock(lang, body.trim()) ? whole : "```json\n" + body + "```"));
}
