import { useEffect, useRef, useState } from "react";
import { MicButton } from "../components/MicButton";
import { ModelSelector } from "../components/ModelSelector";
import { PromptInputBox } from "../components/ui/ai-prompt-box";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { isSpecialMode } from "../lib/modelSelection";
import type { Conversation, Message, ModelOption } from "../lib/types";

const PREFERRED_MODEL_KEY = "friday-ai-preferred-model";

export function ChatPage() {
  const { user, logout } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedModel, setSelectedModel] = useState(localStorage.getItem(PREFERRED_MODEL_KEY) ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  function refreshConversations() {
    api.get<{ conversations: Conversation[] }>("/chat/conversations").then((res) => setConversations(res.conversations));
  }

  useEffect(refreshConversations, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    api.get<{ messages: Message[] }>(`/chat/conversations/${activeId}/messages`).then((res) => setMessages(res.messages));
  }, [activeId]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function startNewChat(value: string, model: ModelOption | null) {
    const specialMode = isSpecialMode(value);
    const body = specialMode
      ? { mode: specialMode, title: specialMode === "auto" ? "Auto chat" : "Team Up chat" }
      : model
        ? { mode: "single" as const, providerSlug: model.providers.slug, modelId: model.model_id, title: `${model.display_name} chat` }
        : null;
    if (!body) return;

    const res = await api.post<{ conversation: Conversation }>("/chat/conversations", body);
    setConversations((prev) => [res.conversation, ...prev]);
    setActiveId(res.conversation.id);
  }

  async function handleSend(rawContent: string, inputMode: "text" | "voice" = "text") {
    const content = rawContent.trim();
    if (!content || !activeId || sending) return;
    setSending(true);
    setError(null);
    setMessages((prev) => [
      ...prev,
      { id: `pending-${Date.now()}`, role: "user", content, input_mode: inputMode, created_at: new Date().toISOString() },
    ]);
    try {
      const res = await api.post<{ messages: Message[] }>(`/chat/conversations/${activeId}/messages`, {
        content,
        inputMode,
      });
      setMessages((prev) => [...prev, ...res.messages]);
      refreshConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  async function deleteConversation(id: string) {
    await api.delete(`/chat/conversations/${id}`);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  }

  return (
    <div className="chat-page">
      <aside className="chat-sidebar">
        <div className="sidebar-header">
          <strong>{user?.name ?? user?.email}</strong>
          <button className="link-btn" onClick={logout}>
            Log out
          </button>
        </div>

        <div className="new-chat-block">
          <ModelSelector
            value={selectedModel}
            onChange={(v, model) => {
              setSelectedModel(v);
              localStorage.setItem(PREFERRED_MODEL_KEY, v);
              startNewChat(v, model);
            }}
          />
        </div>

        <div className="conversation-list">
          {conversations.map((c) => (
            <div key={c.id} className={`conversation-item ${c.id === activeId ? "active" : ""}`}>
              <button className="conversation-select" onClick={() => setActiveId(c.id)}>
                <span className="conversation-title">{c.title}</span>
                <span className="conversation-meta">
                  {c.mode === "auto" ? "🔀 Auto" : c.mode === "teamup" ? "👥 Team Up" : c.providers?.display_name}
                </span>
              </button>
              <button className="conversation-delete" title="Delete" onClick={() => deleteConversation(c.id)}>
                ✕
              </button>
            </div>
          ))}
          {conversations.length === 0 && <p className="empty-hint">Pick a model above to start your first chat.</p>}
        </div>
      </aside>

      <main className="chat-main">
        {!activeId ? (
          <div className="chat-empty">Select or start a conversation to begin.</div>
        ) : (
          <>
            <div className="message-list">
              {messages.map((m) => (
                <div key={m.id} className={`message message--${m.role}`}>
                  <div className="message-bubble">
                    {m.model_label && <div className="message-model-label">{m.model_label}</div>}
                    {m.content}
                  </div>
                </div>
              ))}
              <div ref={listEndRef} />
            </div>

            {error && <div className="form-error">{error}</div>}

            <div className="chat-input-row chat-input-row--composer">
              <PromptInputBox
                onSend={(message) => handleSend(message, "text")}
                isLoading={sending}
                placeholder="Type a message…"
              />
              {/* Real speech-to-text (backend-transcribed), separate from the composer's
                  built-in mic icon which is a visual-only placeholder in this component. */}
              <MicButton onTranscribed={(text) => handleSend(text, "voice")} disabled={sending} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
