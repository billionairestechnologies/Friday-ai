import { API_BASE_URL, api, getAccessToken } from "@/lib/api";
import type { ServerMessage } from "./store";
import type { StreamEvent } from "./types";

/** Single/Auto mode: real token streaming from the backend's SSE endpoint. */
export async function streamMessage(
  conversationId: string,
  content: string,
  inputMode: "text" | "voice",
  think: boolean,
  behavior: string,
  webSearch: boolean,
  onEvent: (ev: StreamEvent) => void,
  signal: AbortSignal,
) {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE_URL}/chat/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ content, inputMode, think, behavior, webSearch }),
    signal,
  });

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

/** Team Up mode: fans out server-side, returns every reply at once (no streaming). */
export async function sendTeamUpMessage(
  conversationId: string,
  content: string,
  inputMode: "text" | "voice",
  think: boolean,
  behavior: string,
  webSearch: boolean,
): Promise<ServerMessage[]> {
  const res = await api.post<{ messages: ServerMessage[] }>(`/chat/conversations/${conversationId}/messages`, {
    content,
    inputMode,
    think,
    behavior,
    webSearch,
  });
  return res.messages;
}
