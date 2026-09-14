import { useRef, useState } from "react";
import { api } from "../lib/api";

interface Props {
  onTranscribed: (text: string) => void;
  disabled?: boolean;
}

export function MicButton({ onTranscribed, disabled }: Props) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing" | "error">("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setState("transcribing");
        try {
          const form = new FormData();
          form.append("audio", blob, "recording.webm");
          const res = await api.post<{ text: string }>("/voice/transcribe", form);
          onTranscribed(res.text);
          setState("idle");
        } catch {
          setState("error");
          setTimeout(() => setState("idle"), 2000);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setState("recording");
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  const label = { idle: "🎤", recording: "⏹", transcribing: "…", error: "⚠️" }[state];
  const title = {
    idle: "Speak to type",
    recording: "Stop recording",
    transcribing: "Transcribing…",
    error: "Couldn't transcribe — try again",
  }[state];

  return (
    <button
      type="button"
      className={`mic-button mic-button--${state}`}
      title={title}
      disabled={disabled || state === "transcribing"}
      onClick={state === "recording" ? stopRecording : startRecording}
    >
      {label}
    </button>
  );
}
