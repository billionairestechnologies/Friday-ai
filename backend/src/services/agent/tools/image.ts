import { getWorkingKeyForProvider } from "../../providerService.js";
import { editImage, generateImage } from "../../providers/scalemaxImages.js";
import { rehostGeneratedImage } from "../../providers/imageHosting.js";
import { recordUsageEvent } from "../../usageService.js";
import { consumeDailyAllowance, refundDailyAllowance } from "../../quota/entitlements.js";
import { str, type FridayTool } from "./types.js";
import { supabaseAdmin } from "../../../config/supabase.js";
import { logger } from "../../../utils/logger.js";

/**
 * generate_image: the model decides when a picture is wanted — not a keyword list. The regex
 * shortcut in chat/imageIntent.ts only catches explicit "generate an image of…" wording; anything
 * else ("show me what a Kyoto street looks like at night", "can you do a logo for my café?") used
 * to reach a text model with no image ability, which then wrote SVG/HTML/Python "image code" or an
 * error instead of an image. With this tool those turns produce a real image.
 *
 * The image is shown by Friday itself (ctx.onImage puts it into the reply), never by the model
 * re-typing the URL — a model copying a long signed URL is exactly where links get mangled.
 */
const SIZES: Record<string, string> = { square: "1024x1024", landscape: "1536x864", portrait: "864x1536" };

/** The newest image Friday generated in this conversation (from the reply markdown), for "make it blue". */
export function lastGeneratedImageUrl(history: { role: string; content: string }[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "assistant") continue;
    const all = [...m.content.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)];
    if (all.length) return all[all.length - 1]![1]!;
  }
  return null;
}

/** Every image Friday generated in this conversation, oldest first (numbered 1… for the tool). */
export function chatImages(history: { role: string; content: string }[]): Array<{ url: string; alt: string }> {
  const out: Array<{ url: string; alt: string }> = [];
  for (const m of history) {
    if (m.role !== "assistant") continue;
    for (const hit of m.content.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) out.push({ url: hit[2]!, alt: (hit[1] ?? "").trim() });
  }
  return out;
}

export type EditSource = { kind: "new" } | { kind: "attachment"; dataUrl: string } | { kind: "url"; url: string; number: number } | { kind: "error"; message: string };

/**
 * Which image an edit applies to — never a guess: "attachment" = the image on this message, "last" =
 * the newest one Friday made here, "image" + number = that one from the numbered list. With several
 * images and no number, the model is told to ask the user which one.
 */
export function resolveEditSource(edit: string, imageNumber: number | null, images: Array<{ url: string }>, attached: string | null): EditSource {
  if (!edit) return { kind: "new" };
  if (edit === "attachment") return attached ? { kind: "attachment", dataUrl: attached } : { kind: "error", message: "No image is attached to this message — ask the user to attach it, or create a new image." };
  if (images.length === 0) return { kind: "error", message: "There is no earlier generated image in this chat — create a new one instead." };
  if (edit === "last") return { kind: "url", url: images[images.length - 1]!.url, number: images.length };
  if (imageNumber == null) {
    return images.length === 1
      ? { kind: "url", url: images[0]!.url, number: 1 }
      : { kind: "error", message: `This chat has ${images.length} images — ask the user which one to change (by number) before editing.` };
  }
  if (!Number.isInteger(imageNumber) || imageNumber < 1 || imageNumber > images.length) return { kind: "error", message: `There is no image ${imageNumber} — this chat has ${images.length}.` };
  return { kind: "url", url: images[imageNumber - 1]!.url, number: imageNumber };
}

/** Records a successful image as an asset with its lineage. Best-effort: never fails the tool. */
async function recordAsset(userId: string, conversationId: string | null, url: string, op: "generate" | "edit" | "edit_upload", prompt: string, size: string, parentUrl: string | null) {
  try {
    let parentId: string | null = null;
    let version = 1;
    if (parentUrl) {
      const { data } = await supabaseAdmin.from("image_assets").select("id, version").eq("user_id", userId).eq("url", parentUrl).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (data) {
        parentId = data.id as string;
        version = Number(data.version) + 1;
      } else version = 2;
    }
    const { error } = await supabaseAdmin.from("image_assets").insert({ user_id: userId, conversation_id: conversationId, url, parent_id: parentId, version, operation: op, prompt: prompt.slice(0, 2000), size });
    if (error) logger.warn("image_asset_record_failed", { error: error.message });
  } catch (err) {
    logger.warn("image_asset_record_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export function imageTool(opts: { lastImageUrl: string | null; attachedImage: string | null; imagesPerDay: number; images?: Array<{ url: string; alt: string }> }): FridayTool {
  const images = opts.images ?? (opts.lastImageUrl ? [{ url: opts.lastImageUrl, alt: "" }] : []);
  const list = images.length
    ? `\nImages in this chat (oldest first): ${images.map((im, i) => `${i + 1}. ${im.alt.slice(0, 60) || "image"}`).join("; ")}.`
    : "";
  return {
    spec: {
      name: "generate_image",
      description:
        "Create a real image (photo, illustration, logo, icon, poster, banner, wallpaper, diagram-style art) from a text prompt, " +
        "or edit an image. Use it whenever the user wants to SEE a picture — never answer an image request with SVG, HTML, " +
        "canvas or Python drawing code, ASCII art, or a made-up image link. Write a rich, specific prompt in English (subject, " +
        "setting, style, lighting, colours, composition, any exact text to render). The image is shown to the user " +
        "automatically; afterwards add at most one short sentence — do not repeat the link or write image markdown.\n" +
        "- edit: \"attachment\" edits the image the user attached to this message; \"last\" changes the most recent image you " +
        "made in this chat (\"make it darker\", \"add a cat\"); \"image\" + image_number edits that numbered image; omit for a brand-new " +
        "image. If several images could be meant, ask the user which one first. An edit always makes a NEW image — the original stays." + list,
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed description of the image to create, or of the change to make" },
          size: { type: "string", enum: ["square", "landscape", "portrait"], description: "Aspect ratio (default square)" },
          edit: { type: "string", enum: ["attachment", "last", "image"], description: "Edit an existing image instead of creating a new one" },
          image_number: { type: "number", description: "With edit \"image\": which image from the numbered list" },
        },
        required: ["prompt"],
      },
    },
    label: (args) => `${str(args, "edit") ? "Editing the image" : "Creating an image"} · ${str(args, "prompt").slice(0, 70)}`,
    async run(args, ctx) {
      const prompt = str(args, "prompt");
      if (prompt.length < 3) throw new Error("Describe the image in the prompt.");
      const size = SIZES[str(args, "size")] ?? SIZES.square!;
      const edit = str(args, "edit");
      const source = resolveEditSource(edit, args.image_number == null ? null : Number(args.image_number), images, opts.attachedImage);
      if (source.kind === "error") throw new Error(source.message);

      const allowance = await consumeDailyAllowance(ctx.userId, "image_generation", opts.imagesPerDay);
      if (!allowance.ok) {
        throw new Error(
          allowance.limit > 0
            ? `Tell the user plainly: they've used today's ${allowance.limit} generated images on this plan — it resets at midnight UTC, or they can upgrade for more. Do not generate an image.`
            : "Tell the user plainly: image generation isn't included on their current plan — upgrading unlocks it. Do not generate an image.",
        );
      }

      let apiKey: string;
      try {
        apiKey = await getWorkingKeyForProvider("scalemax");
      } catch {
        await refundDailyAllowance(ctx.userId, "image_generation").catch(() => {});
        throw new Error("Image generation isn't set up on this Friday deployment (no image provider key). Tell the user plainly.");
      }
      let url: string;
      try {
        if (source.kind === "attachment") {
          url = await editImage(apiKey, prompt.slice(0, 4000), { dataUrl: source.dataUrl }, { size });
        } else if (source.kind === "url") {
          url = await editImage(apiKey, prompt.slice(0, 4000), { url: source.url }, { size });
        } else {
          url = await generateImage(apiKey, prompt.slice(0, 4000), { size });
        }
      } catch (err) {
        await refundDailyAllowance(ctx.userId, "image_generation").catch(() => {});
        throw err;
      }
      url = await rehostGeneratedImage(ctx.userId, url);
      await recordAsset(ctx.userId, ctx.conversationId ?? null, url, source.kind === "attachment" ? "edit_upload" : source.kind === "url" ? "edit" : "generate", prompt, size, source.kind === "url" ? source.url : null);
      ctx.onImage?.(url, prompt.slice(0, 120));
      void recordUsageEvent(ctx.userId, "image_generation", 1, { kind: edit ? "edit" : "generate", viaTools: true });
      return "Done — the image is now shown to the user above your reply. Don't repeat its link or write image markdown; add at most one short sentence.";
    },
  };
}
