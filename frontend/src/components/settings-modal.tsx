import { useEffect, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AudioLines,
  Bell,
  Check,
  CreditCard,
  Palette,
  Shield,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { authEnabled, signOut, useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useModels } from "@/lib/chat/models";
import { saveFile } from "@/lib/chat/download";
import { useChat } from "@/lib/chat/store";
import { VoicePicker } from "@/components/voice-picker";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

const NAV = [
  {
    group: "General",
    items: [
      { id: "account", label: "Account", icon: UserRound },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "behavior", label: "Behavior", icon: SlidersHorizontal },
      { id: "voice", label: "Voice", icon: AudioLines },
      { id: "notifications", label: "Notifications", icon: Bell },
    ],
  },
  {
    group: "Friday",
    items: [{ id: "customize", label: "Customize", icon: Sparkles }],
  },
  {
    group: "Payments",
    items: [
      { id: "billing", label: "Billing", icon: CreditCard },
      { id: "usage", label: "Usage", icon: Zap },
    ],
  },
  {
    group: "Data & Information",
    items: [{ id: "data", label: "Data Controls", icon: Shield }],
  },
];

export function SettingsModal() {
  const dialog = useChat((s) => s.dialog);
  const setDialog = useChat((s) => s.setDialog);
  const tab = useChat((s) => s.settingsTab);
  const setTab = useChat((s) => s.setSettingsTab);

  return (
    <Dialog.Root open={dialog === "settings"} onOpenChange={(v) => !v && setDialog(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed top-[50%] left-[50%] z-50 flex h-[min(84vh,560px)] w-[min(94vw,720px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-2xl border border-border bg-elevated shadow-[var(--shadow-composer)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <nav className="hidden w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-3 sm:flex">
            {NAV.map((g) => (
              <div key={g.group}>
                <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
                  {g.group}
                </p>
                {g.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={cn(
                        "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm",
                        tab === item.id
                          ? "bg-chip text-foreground"
                          : "text-muted hover:bg-chip/60 hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between px-5 py-3 sm:hidden">
              <select
                value={tab}
                onChange={(e) => setTab(e.target.value)}
                className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
              >
                {NAV.flatMap((g) => g.items).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </select>
              <Dialog.Close className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip">
                <X className="size-4" />
              </Dialog.Close>
            </div>
            <div className="hidden items-center justify-end px-4 py-3 sm:flex">
              <Dialog.Close className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground">
                <X className="size-4" />
              </Dialog.Close>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6">
              {tab === "account" && <AccountPane />}
              {tab === "appearance" && <AppearancePane />}
              {tab === "behavior" && <BehaviorPane />}
              {tab === "voice" && <VoicePane />}
              {tab === "notifications" && <SimpleNote title="Notifications" body="Friday doesn’t send push mail in this preview. Replies stay in this tab." />}
              {tab === "customize" && <SimpleNote title="Customize" body="Search, Think, and Canvas live in the composer. Personality stays direct and truthful." />}
              {tab === "billing" && <BillingPane />}
              {tab === "usage" && <UsagePane />}
              {tab === "data" && <DataPane />}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ label, value, action }: { label: ReactNode; value?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {value && <p className="text-xs text-muted">{value}</p>}
      </div>
      {action}
    </div>
  );
}

function AccountPane() {
  const { user } = useCurrentUserState();
  const setDialog = useChat((s) => s.setDialog);
  const signedIn = Boolean(user && !user.isDevFallback);
  const [signingOut, setSigningOut] = useState(false);
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Account</h2>
      <div className="flex items-center justify-between gap-3 border-b border-border py-3">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-full bg-chip text-sm font-semibold">
            {(user?.displayName ?? "G").charAt(0).toUpperCase()}
          </span>
          <div>
            <p className="text-sm font-medium">{signedIn ? user?.displayName : "Guest"}</p>
            <p className="text-xs text-muted">{signedIn ? user?.primaryEmail : "Not signed in"}</p>
          </div>
        </div>
        {signedIn && authEnabled ? (
          <button
            type="button"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOut().catch(() => setSigningOut(false));
            }}
            className="h-8 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip disabled:opacity-60"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setDialog("login")}
            className="h-8 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip"
          >
            Sign in
          </button>
        )}
      </div>
      <Row label="Plan" value="Friday" action={<span className="text-xs text-muted">Active</span>} />
      {signedIn && <BirthdayRow />}
    </div>
  );
}

/** Optional — powers the birthday greeting and age-banded "thinking" one-liners. Fully removable:
 *  delete this component, its <BirthdayRow /> call above, and the birthday plumbing in
 *  lib/auth/client.ts / lib/types.ts with no other cleanup needed. */
function BirthdayRow() {
  const { user } = useCurrentUserState();
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const [value, setValue] = useState(user?.birthday ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== (user?.birthday ?? "");

  async function save() {
    if (!value || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ birthday: value });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div>
        <p className="text-sm font-medium">Birthday</p>
        <p className="text-xs text-muted">Used for a birthday greeting — optional.</p>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
        />
        <button
          type="button"
          disabled={!dirty || saving || !value}
          onClick={() => void save()}
          className="h-8 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip disabled:opacity-60"
        >
          {saving ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

function AppearancePane() {
  const appearance = useChat((s) => s.appearance);
  const setAppearance = useChat((s) => s.setAppearance);
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Appearance</h2>
      <div className="flex gap-2">
        {(["dark", "light"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setAppearance(mode)}
            className={cn(
              "flex h-20 flex-1 flex-col items-center justify-center rounded-xl border text-sm capitalize",
              appearance === mode ? "border-foreground bg-chip" : "border-border hover:bg-chip/50",
            )}
          >
            {appearance === mode && <Check className="mb-1 size-3.5" />}
            {mode}
          </button>
        ))}
      </div>
    </div>
  );
}

const PERSONALITY_PRESETS = [
  { label: "Default", prompt: "" },
  { label: "Friendly", prompt: "Be warm, encouraging, and conversational. Use a friendly, approachable tone." },
  {
    label: "Professional",
    prompt: "Be formal and precise. Use professional, businesslike language and avoid slang or casual phrasing.",
  },
  {
    label: "Funny",
    prompt: "Be witty and playful. Use humor, light jokes, and a fun tone while still being genuinely helpful.",
  },
  { label: "Concise", prompt: "Be extremely concise. Answer in as few words as possible, no filler, no preamble." },
  {
    label: "Direct",
    prompt: "Be blunt and direct. Skip pleasantries, don't hedge, give the straight answer first.",
  },
] as const;

function BehaviorPane() {
  const model = useChat((s) => s.model);
  const setModel = useChat((s) => s.setModel);
  const models = useModels((s) => s.models);
  const behavior = useChat((s) => s.behavior);
  const setBehavior = useChat((s) => s.setBehavior);

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Behavior</h2>

      <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Personality</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PERSONALITY_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setBehavior(p.prompt)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              behavior === p.prompt ? "border-foreground bg-chip" : "border-border hover:bg-chip/60",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <textarea
        value={behavior}
        onChange={(e) => setBehavior(e.target.value)}
        placeholder="Or write custom instructions for how Friday should respond — e.g. “explain things like I'm a beginner” or “always answer in bullet points”."
        rows={3}
        className="mb-6 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-subtle"
      />

      <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Default model</p>
      <div className="flex flex-col gap-1">
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setModel(m.id)}
            className={cn(
              "flex items-center justify-between rounded-xl px-3 py-2.5 text-left",
              m.id === model ? "bg-chip" : "hover:bg-chip/60",
            )}
          >
            <span>
              <span className="block text-sm font-medium">{m.label}</span>
              <span className="block text-xs text-muted">{m.hint}</span>
            </span>
            {m.id === model && <Check className="size-4" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function VoicePane() {
  const voiceId = useChat((s) => s.voiceId);
  const setVoice = useChat((s) => s.setVoice);

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold">Voice</h2>
      <p className="mb-4 text-sm text-muted">
        Picked here or in Voice Mode — this is who reads Friday's replies aloud.
      </p>
      <VoicePicker selectedId={voiceId} onSelect={(v) => setVoice(v.voiceId, v.name)} />
    </div>
  );
}

function BillingPane() {
  const setDialog = useChat((s) => s.setDialog);
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Billing</h2>
      <Row
        label="Friday"
        value="Included in this workspace"
        action={
          <button
            type="button"
            onClick={() => setDialog("upgrade")}
            className="h-8 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip"
          >
            Manage
          </button>
        }
      />
    </div>
  );
}

type UsageSummary = {
  periodStart: string;
  totals: {
    chatMessages: number;
    searches: number;
    voiceSeconds: number;
    sandboxRuns: number;
    attachmentUploads: number;
    estimatedCostCents: number;
  };
};

function UsagePane() {
  const { user } = useCurrentUserState();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(user && !user.isDevFallback);

  useEffect(() => {
    if (!signedIn) return;
    api
      .get<UsageSummary>("/usage/summary")
      .then((res) => {
        setSummary(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load usage"));
  }, [signedIn]);

  if (!signedIn) {
    return <SimpleNote title="Usage" body="Sign in to track monthly chat, search, voice, attachment, and sandbox usage." />;
  }

  const rows = summary
    ? [
        ["Chat messages", summary.totals.chatMessages],
        ["Searches", summary.totals.searches],
        ["Voice seconds", summary.totals.voiceSeconds],
        ["Sandbox runs", summary.totals.sandboxRuns],
        ["Attachments", summary.totals.attachmentUploads],
      ]
    : [];

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold">Usage</h2>
      <p className="mb-4 text-sm text-muted">
        {summary
          ? `Current period started ${new Date(summary.periodStart).toLocaleDateString()}.`
          : "Loading current period usage..."}
      </p>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border bg-background p-3">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 font-mono text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DataPane() {
  const chats = useChat((s) => s.chats);
  const clearAllChats = useChat((s) => s.clearAllChats);
  const { user } = useCurrentUserState();
  const [cleared, setCleared] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<"download" | "clear" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(user && !user.isDevFallback);

  async function downloadChats() {
    setBusy("download");
    setError(null);
    try {
      const payload = signedIn
        ? await api.get<unknown>("/auth/export")
        : chats.map((c) => ({
            title: c.title,
            createdAt: c.createdAt,
            messages: c.messages.map((m) => ({
              role: m.role,
              content: m.content,
              thinking: m.thinking,
              citations: m.citations,
              agents: m.agents,
              attachments: m.attachments?.map(({ dataUrl: _dataUrl, ...attachment }) => attachment),
            })),
          }));
      const ok = await saveFile(
        "friday-chats.json",
        JSON.stringify(payload, null, 2),
        "application/json;charset=utf-8",
      );
      if (ok) {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1400);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't download chats");
    } finally {
      setBusy(null);
    }
  }

  async function clearChats() {
    setBusy("clear");
    setError(null);
    try {
      if (signedIn) await api.delete("/chat/conversations");
      clearAllChats();
      setCleared(true);
      window.setTimeout(() => setCleared(false), 1400);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't clear chats");
    } finally {
      setBusy(null);
    }
  }

  async function deleteAccount() {
    if (!signedIn) return;
    if (!window.confirm("Delete your Friday account and all saved conversations? This cannot be undone.")) return;
    setBusy("delete");
    setError(null);
    try {
      await api.delete("/auth/account");
      useAuthStore.getState().logout();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete account");
      setBusy(null);
    }
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Data Controls</h2>
      <p className="mb-4 text-sm text-muted">
        {signedIn
          ? "Chats sync to your Friday account. Export or delete the server copy here."
          : "Chats stay in this browser until you sign in. Clearing them can't be undone."}
      </p>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null || (!signedIn && chats.length === 0)}
          onClick={() => void downloadChats()}
          className="h-10 rounded-full border border-border px-4 text-sm font-medium hover:bg-chip disabled:opacity-40"
        >
          {busy === "download" ? "Preparing..." : saved ? "Downloaded" : "Download data"}
        </button>
        <button
          type="button"
          disabled={busy !== null || (!signedIn && chats.length === 0)}
          onClick={() => void clearChats()}
          className="h-10 rounded-full border border-border px-4 text-sm font-medium hover:bg-chip disabled:opacity-40"
        >
          {busy === "clear" ? "Clearing..." : cleared ? "Cleared" : "Clear all chats"}
        </button>
        {signedIn && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void deleteAccount()}
            className="h-10 rounded-full border border-danger/60 px-4 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
          >
            {busy === "delete" ? "Deleting..." : "Delete account"}
          </button>
        )}
      </div>
    </div>
  );
}

function SimpleNote({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}
