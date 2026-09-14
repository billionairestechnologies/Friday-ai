import { useEffect, useRef, useState } from "react";
import { MicButton } from "../components/MicButton";
import { ModelSelector } from "../components/ModelSelector";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import type { Conversation, Message, ModelOption } from "../lib/types";

const PREFERRED_MODEL_KEY = "friday-ai-preferred-model";

export function ChatPage() {
  const { user, logout } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
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

  async function startNewChat(model: ModelOption | null) {
    if (!model) return;
    const res = await api.post<{ conversation: Conversation }>("/chat/conversations", {
      providerSlug: model.providers.slug,
      modelId: model.model_id,
      title: `${model.display_name} chat`,
    });
    setConversations((prev) => [res.conversation, ...prev]);
    setActiveId(res.conversation.id);
  }

  async function handleSend() {
    if (!draft.trim() || !activeId || sending) return;
    const content = draft.trim();
    setDraft("");
    setSending(true);
    setError(null);
    setMessages((prev) => [
      ...prev,
      { id: `pending-${Date.now()}`, role: "user", content, input_mode: "text", created_at: new Date().toISOString() },
    ]);
    try {
      const res = await api.post<{ message: Message }>(`/chat/conversations/${activeId}/messages`, { content });
      setMessages((prev) => [...prev, res.message]);
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
              startNewChat(model);
            }}
          />
        </div>

        <div className="conversation-list">
          {conversations.map((c) => (
            <div key={c.id} className={`conversation-item ${c.id === activeId ? "active" : ""}`}>
              <button className="conversation-select" onClick={() => setActiveId(c.id)}>
                <span className="conversation-title">{c.title}</span>
                <span className="conversation-meta">{c.providers.display_name}</span>
              </button>
              <button className="conversation-delete" title="Delete" onClick={() => deleteConversation(c.id)}>
                ✕
              </button>
            </div>
          ))}
          {conversations.length === 0 && <p className="empty-hint">Pick a model above to start your first chat.</p>}
        </div>

        {user?.role === "admin" && (
          <a className="admin-link" href="/admin">
            Admin panel →
          </a>
        )}
      </aside>

      <main className="chat-main">
        {!activeId ? (
          <div className="chat-empty">Select or start a conversation to begin.</div>
        ) : (
          <>
            <div className="message-list">
              {messages.map((m) => (
                <div key={m.id} className={`message message--${m.role}`}>
                  <div className="message-bubble">{m.content}</div>
                </div>
              ))}
              <div ref={listEndRef} />
            </div>

            {error && <div className="form-error">{error}</div>}

            <div className="chat-input-row">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Type a message, or use the mic…"
                rows={2}
              />
              <MicButton onTranscribed={(text) => setDraft((prev) => (prev ? `${prev} ${text}` : text))} />
              <button className="btn-primary" onClick={handleSend} disabled={sending || !draft.trim()}>
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
