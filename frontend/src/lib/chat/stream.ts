import { API_BASE_URL, getAccessToken } from "@/lib/api";
import { useAuthStore } from "@/lib/auth/client";
import type { StreamEvent } from "./types";

export type OutgoingAttachment = {
  mime: string;
  dataUrl: string;
  name?: string;
  size?: number;
  kind?: "image" | "file";
};

/** Per-turn options beyond the classic toggles. */
export type StreamOptions = { research?: boolean; skillId?: string };

async function fetchStream(
  conversationId: string,
  content: string,
  inputMode: "text" | "voice",
  think: boolean,
  behavior: string,
  webSearch: boolean,
  canvas: boolean,
  attachments: OutgoingAttachment[],
  signal: AbortSignal,
  isRetry = false,
  isNetworkRetry = false,
  extra: StreamOptions = {},
): Promise<Response> {
  const token = getAccessToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/chat/conversations/${conversationId}/messages/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ content, inputMode, think, behavior, webSearch, canvas, attachments, ...extra }),
      signal,
    });
  } catch (err) {
    // fetch() itself (not the response) can throw on a dropped connection — most visibly on
    // mobile Safari/WebKit, where a brief network blip surfaces as a bare "TypeError: Load
    // failed" before any bytes come back. That's usually transient, so retry once before
    // giving up and showing the user an opaque network error.
    if (isNetworkRetry || (err as { name?: string }).name === "AbortError") throw err;
    return fetchStream(conversationId, content, inputMode, think, behavior, webSearch, canvas, attachments, signal, isRetry, true, extra);
  }
  // Same short-lived-token gap as fetchSpeech in voices.ts: a raw 401 here surfaces the
  // backend's literal "Missing bearer token"/"Invalid or expired session" text to the user
  // instead of quietly refreshing and retrying like the shared `api` client does.
  if (res.status === 401 && !isRetry) {
    const refreshed = await useAuthStore.getState().refresh();
    if (refreshed) {
      return fetchStream(conversationId, content, inputMode, think, behavior, webSearch, canvas, attachments, signal, true, false, extra);
    }
  }
  return res;
}

/** Single/Auto mode: real token streaming from the backend's SSE endpoint. */
export async function streamMessage(
  conversationId: string,
  content: string,
  inputMode: "text" | "voice",
  think: boolean,
  behavior: string,
  webSearch: boolean,
  canvas: boolean,
  attachments: OutgoingAttachment[],
  onEvent: (ev: StreamEvent) => void,
  signal: AbortSignal,
  extra: StreamOptions = {},
) {
  const res = await fetchStream(conversationId, content, inputMode, think, behavior, webSearch, canvas, attachments, signal, false, false, extra);

  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* ignore */
    }
    onEvent({ t: "err", c: message });
    onEvent({ t: "done" });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as StreamEvent);
      } catch {
        /* skip malformed */
      }
    }
  }
}
