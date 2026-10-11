import { getWorkingKeyForProvider } from "../../providerService.js";
import { editImage, generateImage } from "../../providers/scalemaxImages.js";
import { recordUsageEvent } from "../../usageService.js";
import { consumeDailyAllowance, refundDailyAllowance } from "../../quota/entitlements.js";
import { str, type FridayTool } from "./types.js";

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

export function imageTool(opts: { lastImageUrl: string | null; attachedImage: string | null; imagesPerDay: number }): FridayTool {
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
        "made in this chat (\"make it darker\", \"add a cat\"); omit for a brand-new image.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed description of the image to create, or of the change to make" },
          size: { type: "string", enum: ["square", "landscape", "portrait"], description: "Aspect ratio (default square)" },
          edit: { type: "string", enum: ["attachment", "last"], description: "Edit an existing image instead of creating a new one" },
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
        if (edit === "attachment") {
          if (!opts.attachedImage) throw new Error("No image is attached to this message — create a new image instead, or ask the user to attach one.");
          url = await editImage(apiKey, prompt.slice(0, 4000), { dataUrl: opts.attachedImage }, { size });
        } else if (edit === "last") {
          if (!opts.lastImageUrl) throw new Error("There is no earlier generated image in this chat — create a new one instead.");
          url = await editImage(apiKey, prompt.slice(0, 4000), { url: opts.lastImageUrl }, { size });
        } else {
          url = await generateImage(apiKey, prompt.slice(0, 4000), { size });
        }
      } catch (err) {
        await refundDailyAllowance(ctx.userId, "image_generation").catch(() => {});
        throw err;
      }
      ctx.onImage?.(url, prompt.slice(0, 120));
      void recordUsageEvent(ctx.userId, "image_generation", 1, { kind: edit ? "edit" : "generate", viaTools: true });
      return "Done — the image is now shown to the user above your reply. Don't repeat its link or write image markdown; add at most one short sentence.";
    },
  };
}
