import { memo, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Check, Copy, Download, FileText, Loader2, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { useBuildCheckpoints } from "@/lib/build-mode/checkpoints";
import { useBuildSessions } from "@/lib/build-mode/sessions";
import { LiveChainOfThought } from "@/components/chain-of-thought-live";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { saveFile } from "@/lib/chat/download";
import { StreamingMarkdown } from "@/lib/chat/markdown";
import { overlayLive, useLiveStream } from "@/lib/chat/live-stream";
import { shouldShowPlan, toolOnlySteps } from "@/lib/chat/planning";
import { useChat, type ServerMessage } from "@/lib/chat/store";
import { AskCard } from "@/components/ask-panel";
import { PLAN_MARKER, SuggestBuildCard } from "@/components/plan-approval";
import { BuildBanner, BuildSteps, ProjectZipCard } from "@/components/build-steps";
import { FridayThinking } from "@/components/friday-presence";
import { FileCards } from "@/components/file-card";
import { useRotatingThinkingLine } from "@/lib/chat/thinking-lines";
import { stripVisualArtifactForChat } from "@/lib/chat/artifact";
import type { ChatMessage } from "@/lib/chat/types";

const EMPTY: ChatMessage[] = [];
const ease = [0.22, 1, 0.36, 1] as const;

export function MessageThread() {
  const stored = useChat((s) => {
    const chat = s.chats.find((c) => c.id === s.activeId);
    return chat?.messages ?? EMPTY;
  });
  const activeId = useChat((s) => s.activeId);
  const live = useLiveStream(activeId);
  const messages = useMemo(() => overlayLive(stored, live), [stored, live]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { away, onScroll, jump } = useStickToBottom(scroller, content);
  // Build sessions: user messages with a restore point get "Restore to before this".
  const buildMode = useChat((s) => s.workspace === "build");
  const conversationId = useChat((s) => s.chats.find((c) => c.id === s.activeId)?.conversationId);
  const checkpointIds = useBuildCheckpoints((s) => (conversationId ? s.byConversation[conversationId] : undefined));
  const restorable = useMemo(() => new Set(buildMode ? (checkpointIds ?? []) : []), [buildMode, checkpointIds]);
  const busy = messages.some((m) => m.streaming);

  return (
    <div className="relative z-20 min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="thread-scroll scroll-thin mx-auto h-full w-full max-w-3xl px-4 py-6 md:px-6 lg:max-w-4xl 2xl:max-w-5xl"
      >
        <div ref={content} className="flex flex-col gap-6">
          {messages.map((m) =>
            m.role === "user" ? (
              <UserBubble
                key={m.id}
                message={m}
                restore={restorable.has(m.id) && conversationId && !busy ? { conversationId, chatId: activeId! } : undefined}
              />
            ) : (
              <AssistantBlock key={m.id} message={m} />
            ),
          )}
        </div>
      </div>
      <AnimatePresence>
        {away && (
          <motion.button
            type="button"
            key="jump"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.16, ease }}
            onClick={jump}
            aria-label="Scroll to bottom"
            className="absolute bottom-4 left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-composer text-foreground shadow-[var(--shadow-composer)] transition-transform duration-150 hover:scale-105 active:scale-[0.96]"
          >
            <ArrowDown className="size-4" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/** "Restore to before this message": files back to that point, conversation rewound (Build only). */
function RestoreAction({ messageId, conversationId, chatId }: { messageId: string; conversationId: string; chatId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function restore() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/build/${conversationId}/restore`, { messageId });
      const res = await api.get<{ messages: ServerMessage[] }>(`/chat/conversations/${conversationId}/messages`);
      useChat.getState().loadMessagesInto(chatId, res.messages);
      void useBuildCheckpoints.getState().load(conversationId);
      void useBuildSessions.getState().load();
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't restore — try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-subtle opacity-100 transition-opacity hover:bg-chip hover:text-foreground sm:opacity-0 sm:group-hover/user:opacity-100"
      >
        <RotateCcw className="size-3" /> Restore to before this
      </button>
    );
  }
  return (
    <div className="flex max-w-md flex-col items-end gap-1.5 rounded-xl border border-border bg-composer px-3 py-2 text-xs">
      <p className="text-right text-muted">Put the project files back to how they were before this message and remove this message and everything after it?</p>
      {error && <p className="text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="rounded-full border border-border px-3 py-1 text-foreground hover:bg-chip">
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void restore()} className="inline-flex items-center gap-1 rounded-full bg-foreground px-3 py-1 font-medium text-background">
          {busy && <Loader2 className="size-3 animate-spin" />} Restore
        </button>
      </div>
    </div>
  );
}

const UserBubble = memo(function UserBubble({ message, restore }: { message: ChatMessage; restore?: { conversationId: string; chatId: string } }) {
  return (
    <div className="msg-enter group/user flex flex-col items-end gap-2">
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {message.attachments.map((a) =>
            a.kind === "image" && a.dataUrl ? (
              <div key={a.id} className="group/img relative">
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className="h-36 max-w-[240px] rounded-md object-cover outline outline-1 -outline-offset-1 outline-white/10"
                />
                <button
                  type="button"
                  aria-label={`Download ${a.name}`}
                  onClick={() => void saveFile(a.name || "image.png", a.dataUrl, a.mime)}
                  className="absolute top-1.5 right-1.5 flex size-8 items-center justify-center rounded-full bg-background/85 text-foreground opacity-100 shadow-sm transition-opacity duration-150 sm:opacity-0 sm:group-hover/img:opacity-100"
                >
                  <Download className="size-3.5" />
                </button>
              </div>
            ) : (
              <button
                key={a.id}
                type="button"
                onClick={() => void saveFile(a.name, a.dataUrl, a.mime)}
                className="inline-flex items-center gap-1.5 rounded-md bg-elevated px-2.5 py-1.5 text-xs text-muted hover:text-foreground"
              >
                <FileText className="size-3.5" />
                {a.name}
                <Download className="size-3" />
              </button>
            ),
          )}
        </div>
      )}
      {message.content.trim() && (
        <div className="max-w-[min(100%,36rem)] rounded-[var(--radius-bubble)] bg-chip px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap text-foreground">
          {message.content}
        </div>
      )}
      {restore && <RestoreAction messageId={message.id} conversationId={restore.conversationId} chatId={restore.chatId} />}
    </div>
  );
});

const AssistantBlock = memo(function AssistantBlock({ message }: { message: ChatMessage }) {
  const conversationId = useChat((s) => s.chats.find((c) => c.id === s.activeId)?.conversationId);
  const plan = shouldShowPlan(message);
  const { user } = useCurrentUserState();
  // The backend sends `status: "thinking"` almost immediately after a plain (no Think/Search/
  // Canvas) send starts — before that fix this excluded "thinking", so the typing-dots appeared
  // for a "working" instant and then vanished the moment that status event landed, leaving
  // nothing visible until the first token of real content arrived (which can be several seconds
  // on a slow model). "thinking" now keeps the dots up through that whole gap.
  // Reasoning models (Sarvam, o-series…) stream their thinking before the answer even when the user
  // didn't switch Think on. That text is only SHOWN inside the plan card, so it must only hide the
  // pill when the card is up — otherwise the pill vanished after ~1s and the thread sat empty until
  // the first answer token a few seconds later. "writing" with no text yet is still waiting.
  const waiting = Boolean(
    message.streaming &&
      !message.content &&
      !(message.thinking && plan) &&
      (message.status === "working" || message.status === "thinking" || message.status === "writing" || !message.status),
  );
  const done = !message.streaming;
  // Rotates every ~2.6s while actually waiting, so a slow reply doesn't sit on one static line.
  // "searching" is handled by LiveChainOfThought's own step instead (see chain-of-thought-live.tsx)
  // — this plain pill only ever needs "working" or "thinking".
  const thinkingLine = useRotatingThinkingLine(
    waiting,
    user?.birthday,
    message.status === "thinking" ? "thinking" : "working",
  );

  return (
    <div
      className="msg-enter group/msg relative flex min-h-[1.75rem] flex-col items-start gap-3"
      style={done ? { contentVisibility: "auto", containIntrinsicSize: "auto 120px" } : undefined}
    >
      {message.streaming && message.build && message.build.steps.length === 0 && !message.build.plan && <BuildBanner />}

      {message.build?.ask?.length ? <AskCard questions={message.build.ask} /> : null}
      {message.build && (message.build.steps.length > 0 || message.build.plan) && toolOnlySteps(message).length === 0 && (
        <BuildSteps build={message.build} streaming={Boolean(message.streaming)} />
      )}

      {plan && (
        <div className="min-h-[1.75rem] w-full">
          <LiveChainOfThought message={message} />
        </div>
      )}

      {/* popLayout: the exiting pill is lifted out of the flow immediately, so the first streamed
          words take its place instead of appearing below it and then jumping up when it finishes
          fading — that jump was the visible "glitch" at the start of every reply. */}
      <AnimatePresence initial={false} mode="popLayout">
        {waiting && (
          <motion.div
            key="ttft"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16 }}
            className="typing-pill"
          >
            <FridayThinking status={message.status} />
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={thinkingLine}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="text-xs font-medium tracking-wide text-muted italic"
              >
                {thinkingLine}
              </motion.span>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {message.modelLabel && (
        <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-medium text-muted">
          {message.modelLabel}
        </span>
      )}

      {/* A visual artifact (html/jsx/tsx) is fully shown in Canvas — dumping the same raw code
          into the chat bubble too was redundant clutter, so it's cut out here (see
          stripVisualArtifactForChat's own comment; no-op for any other kind of reply). */}
      {(() => {
        // A plan-round message stores the marker + the plan as text (so the model sees it on later
        // turns); the plan card above already shows all of it, so the text itself isn't repeated.
        if (message.build?.plan?.status && message.content.startsWith(PLAN_MARKER)) return null;
        const displayContent = message.content ? stripVisualArtifactForChat(message.content) : "";
        if (displayContent) {
          return <StreamingMarkdown text={displayContent} streaming={Boolean(message.streaming)} />;
        }
        if (message.content) {
          return <p className="text-sm text-muted">Built in Canvas — see the panel →</p>;
        }
        return null;
      })()}

      {message.error && (!plan || message.streaming) && (
        <p className="rounded-md border border-border bg-elevated px-3 py-2 text-sm text-danger">
          {message.error}
        </p>
      )}

      {message.files?.length ? <FileCards files={message.files} /> : null}

      {message.build?.suggestBuild && !message.streaming && <SuggestBuildCard prompt={message.build.suggestBuild.prompt} />}

      {message.build?.zipBytes && !message.streaming && <ProjectZipCard build={message.build} conversationId={conversationId} />}

      {message.content && !message.streaming && <MessageActions text={message.content} />}
    </div>
  );
});

function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Copy response"
        className="flex size-8 items-center justify-center rounded-md text-subtle opacity-0 transition-[opacity,background-color,color] duration-150 group-hover/msg:opacity-100 hover:bg-chip hover:text-foreground"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="Download response"
        className="flex size-8 items-center justify-center rounded-md text-subtle opacity-0 transition-[opacity,background-color,color] duration-150 group-hover/msg:opacity-100 hover:bg-chip hover:text-foreground"
        onClick={async () => {
          const ok = await saveFile("friday-reply.md", text, "text/markdown;charset=utf-8");
          if (ok) {
            setSaved(true);
            window.setTimeout(() => setSaved(false), 1200);
          }
        }}
      >
        {saved ? <Check className="size-3.5" /> : <Download className="size-3.5" />}
      </button>
    </div>
  );
}
