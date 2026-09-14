import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { transcribeAudio } from "../services/voiceService.js";

export const voiceRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Mic button: browser records audio, uploads it here, gets back the transcribed text
// to drop into the chat input (or send straight away).
voiceRouter.post(
  "/transcribe",
  requireAuth,
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "No audio file uploaded");
    const result = await transcribeAudio(req.file.buffer, req.file.originalname || "recording.webm");
    res.json(result);
  }),
);
