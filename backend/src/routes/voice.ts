import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { listVoices, synthesizeSpeech, transcribeAudio } from "../services/voiceService.js";

export const voiceRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

voiceRouter.use(requireAuth);

// Mic button: browser records audio, uploads it here, gets back the transcribed text
// to drop into the chat input (or send straight away).
voiceRouter.post(
  "/transcribe",
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "No audio file uploaded");
    const result = await transcribeAudio(req.file.buffer, req.file.originalname || "recording.webm");
    res.json(result);
  }),
);

// Voice mode's picker + Settings → Voice: list of selectable voices with a ready preview clip.
voiceRouter.get(
  "/voices",
  asyncHandler(async (_req, res) => {
    res.json({ voices: await listVoices() });
  }),
);

const speakSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  voiceId: z.string().trim().min(1).optional(),
});

// Voice mode speaking a reply aloud, or previewing a voice with a custom line.
voiceRouter.post(
  "/speak",
  asyncHandler(async (req, res) => {
    const { text, voiceId } = speakSchema.parse(req.body);
    const { audio, mime } = await synthesizeSpeech(text, voiceId);
    res.setHeader("Content-Type", mime);
    res.send(audio);
  }),
);
