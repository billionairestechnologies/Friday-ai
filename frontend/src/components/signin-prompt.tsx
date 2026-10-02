import { motion } from "framer-motion";
import { ImageIcon, MessageCircle, X } from "lucide-react";
import { setAuthIntent } from "@/lib/auth/intent";
import { useChat } from "@/lib/chat/store";

/** What a signed-out person asked for — decides the wording; the message itself stays in the box. */
export type GuestGateKind = "image" | "chat";

// Same cheap shape as the server's image shortcut: a short ask with a make/draw verb right before an image word.
const IMAGE_ASK =
  /\b(draw|generate|create|make|design|paint|sketch|render|illustrate|produce)\b[^.\n]{0,40}?\b(image|picture|photo|illustration|logo|icon|artwork|drawing|poster|wallpaper|avatar|portrait|painting|graphic|thumbnail|banner)\b/i;

export function guestGateKind(text: string): GuestGateKind {
  return text.length <= 600 && IMAGE_ASK.test(text) ? "image" : "chat";
}

const COPY: Record<GuestGateKind, { title: string; body: string; icon: typeof ImageIcon }> = {
  image: {
    title: "Log in to create images for free",
    body: "Image creation is available once you're signed in. Your prompt is saved right here, so you can pick up where you left off.",
    icon: ImageIcon,
  },
  chat: {
    title: "Log in to chat with Friday",
    body: "Sign in to get answers, keep your chats, and use tools like search, Canvas and Build. Your message is saved in the box.",
    icon: MessageCircle,
  },
};

/** Slow, soft card above the composer asking a signed-out person to log in or create an account. */
export function SignInPrompt({ kind, onClose }: { kind: GuestGateKind; onClose: () => void }) {
  const setDialog = useChat((s) => s.setDialog);
  const { title, body, icon: Icon } = COPY[kind];
  const open = (intent: "login" | "signup") => {
    setAuthIntent(intent);
    setDialog("login");
  };
  return (
    <motion.div
      role="region"
      aria-label="Sign in required"
      initial={{ opacity: 0, y: 18, scale: 0.985, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: 10, filter: "blur(4px)" }}
      transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
      className="relative mb-3 overflow-hidden rounded-3xl border border-border bg-elevated px-5 py-5 shadow-[var(--shadow-soft)]"
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-10 size-44 rounded-full bg-sky-400/10 blur-3xl"
        animate={{ opacity: [0.5, 1, 0.5], scale: [1, 1.12, 1] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
      >
        <X className="size-4" />
      </button>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="flex items-start gap-3"
      >
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-chip">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 pr-6">
          <h2 className="text-[17px] font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
        </div>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.45, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="mt-4 flex flex-col gap-2 sm:flex-row"
      >
        <button
          type="button"
          onClick={() => open("login")}
          className="inline-flex h-11 flex-1 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition hover:opacity-90"
        >
          Log in
        </button>
        <button
          type="button"
          onClick={() => open("signup")}
          className="inline-flex h-11 flex-1 items-center justify-center rounded-full border border-border px-5 text-sm font-medium text-foreground transition hover:bg-chip"
        >
          Create a free account
        </button>
      </motion.div>
    </motion.div>
  );
}
