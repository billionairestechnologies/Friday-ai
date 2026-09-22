import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { api } from "@/lib/api";
import { useChat, type ServerConversation, type ServerMessage } from "@/lib/chat/store";

let channel: RealtimeChannel | null = null;
let conversationsDebounce: ReturnType<typeof setTimeout> | null = null;
const messageDebounces = new Map<string, ReturnType<typeof setTimeout>>();

function refetchConversations() {
  if (conversationsDebounce) return;
  conversationsDebounce = setTimeout(() => {
    conversationsDebounce = null;
    api
      .get<{ conversations: ServerConversation[] }>("/chat/conversations")
      .then((res) => useChat.getState().hydrateFromServer(res.conversations))
      .catch(() => {
        /* next change event or a manual refresh will retry */
      });
  }, 400);
}

function refetchMessages(conversationId: string) {
  if (messageDebounces.has(conversationId)) return;
  const timer = setTimeout(() => {
    messageDebounces.delete(conversationId);
    const chat = useChat.getState().chats.find((c) => c.conversationId === conversationId);
    if (!chat) return;
    // Never clobber a reply this tab is actively streaming — the other device's write already
    // landed server-side, but our own in-flight optimistic message is still more current locally.
    if (chat.messages.some((m) => m.streaming)) return;
    api
      .get<{ messages: ServerMessage[] }>(`/chat/conversations/${conversationId}/messages`)
      .then((res) => useChat.getState().loadMessagesInto(chat.id, res.messages))
      .catch(() => {
        /* next change event or opening the chat will retry */
      });
  }, 400);
  messageDebounces.set(conversationId, timer);
}

/** Subscribes to Postgres changes on this user's conversations/messages so a second device
 *  signed into the same account (web tab, Android app) shows new chats/replies without polling.
 *  RLS scopes every row to auth.uid() already, so the subscription itself needs no server-side
 *  authorization beyond the user's own access token. */
export function startRealtimeSync(userId: string, accessToken: string) {
  stopRealtimeSync();
  if (!supabase) return;

  supabase.realtime.setAuth(accessToken);

  channel = supabase
    .channel(`chat-sync:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "conversations", filter: `user_id=eq.${userId}` },
      () => refetchConversations(),
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => {
      const conversationId = (payload.new as { conversation_id?: string } | null)?.conversation_id
        ?? (payload.old as { conversation_id?: string } | null)?.conversation_id;
      if (conversationId) refetchMessages(conversationId);
    })
    .subscribe();
}

/** Call whenever the access token rotates (see the proactive-refresh interval in auth/client.ts)
 *  so the Realtime socket's JWT never goes stale mid-session. */
export function setRealtimeAuth(accessToken: string) {
  supabase?.realtime.setAuth(accessToken);
}

export function stopRealtimeSync() {
  if (channel) {
    void supabase?.removeChannel(channel);
    channel = null;
  }
  if (conversationsDebounce) {
    clearTimeout(conversationsDebounce);
    conversationsDebounce = null;
  }
  for (const timer of messageDebounces.values()) clearTimeout(timer);
  messageDebounces.clear();
}
