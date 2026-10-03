import { useEffect, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import {
  AudioLines,
  Bell,
  Brain,
  Check,
  CreditCard,
  Lock,
  Palette,
  Plug,
  Shield,
  SlidersHorizontal,
  Terminal,
  Trash2,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { authEnabled, signOut, useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useModels } from "@/lib/chat/models";
import { planSatisfiesTier, usePlan } from "@/lib/usage/planStore";
import { saveFile } from "@/lib/chat/download";
import { useChat } from "@/lib/chat/store";
import { VoicePicker } from "@/components/voice-picker";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import {
  formatResetAt,
  formatTokens,
  labelForEventType,
  percentUsed,
  type QuotaBreakdownEntry,
  type QuotaResponse,
  type QuotaStatus,
} from "@/lib/usage/quota";

const NAV = [
  {
    group: "General",
    items: [
      { id: "account", label: "Account", icon: UserRound },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "behavior", label: "Behavior", icon: SlidersHorizontal },
      { id: "voice", label: "Voice", icon: AudioLines },
      { id: "notifications", label: "Notifications", icon: Bell },
      { id: "friday-x", label: "Friday X", icon: Terminal },
    ],
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
    items: [
      { id: "memory", label: "Memory", icon: Brain },
      { id: "mcp", label: "MCP servers", icon: Plug },
      { id: "data", label: "Data Controls", icon: Shield },
    ],
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
              {tab === "notifications" && <NotificationsPane />}
              {tab === "friday-x" && <FridayXPane />}
              {tab === "billing" && <BillingPane />}
              {tab === "usage" && <UsagePane />}
              {tab === "memory" && <MemoryPane />}
              {tab === "mcp" && <McpPane />}
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
  const navigate = useNavigate();
  const model = useChat((s) => s.model);
  const setModel = useChat((s) => s.setModel);
  const models = useModels((s) => s.models);
  const behavior = useChat((s) => s.behavior);
  const setBehavior = useChat((s) => s.setBehavior);
  const viewerPlan = usePlan((s) => s.plan);
  const isEnterprise = usePlan((s) => s.isEnterprise);
  const loadPlan = usePlan((s) => s.load);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

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
        {models.map((m) => {
          const locked = !planSatisfiesTier(viewerPlan, isEnterprise, m.minTier);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                if (locked) {
                  void navigate({ to: "/upgrade" });
                  return;
                }
                setModel(m.id);
              }}
              className={cn(
                "flex items-center justify-between rounded-xl px-3 py-2.5 text-left",
                locked ? "text-muted" : m.id === model ? "bg-chip" : "hover:bg-chip/60",
              )}
            >
              <span>
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-muted">
                  {locked ? `${m.minTier === "premium" ? "Premium" : "Pro"} — upgrade to unlock` : m.hint}
                </span>
              </span>
              {locked ? <Lock className="size-4 text-muted" /> : m.id === model && <Check className="size-4" />}
            </button>
          );
        })}
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

type OrderRow = {
  id: string;
  plan: string;
  amountPaise: number;
  currency: string;
  status: string;
  billingCycle: string;
  createdAt: string;
};

const PLAN_DISPLAY_NAME: Record<string, string> = {
  free: "Free",
  pro: "Friday Pro",
  premium: "Friday Premium",
  enterprise: "Friday Enterprise",
  business: "Friday Premium",
};

function BillingPane() {
  const navigate = useNavigate();
  const [currentPlan, setCurrentPlan] = useState<QuotaStatus | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<QuotaResponse>("/usage/quota")
      .then((res) => setCurrentPlan(res.status))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load your plan"));
    api
      .get<{ orders: OrderRow[] }>("/billing/orders")
      .then((res) => setOrders(res.orders))
      .catch(() => setOrders([]));
  }, []);

  const planName = currentPlan
    ? currentPlan.isEnterprise
      ? "Friday Enterprise"
      : PLAN_DISPLAY_NAME[currentPlan.plan]
    : null;
  const renewsAt = currentPlan?.isEnterprise ? currentPlan.org?.resetAt : currentPlan?.monthly?.resetAt;

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold">Billing</h2>
      <p className="mb-4 text-sm text-muted">Payments are handled through Razorpay.</p>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border bg-background p-4">
          <p className="text-xs text-muted">Current Plan</p>
          <p className="mt-1 text-lg font-semibold">{planName ?? "Loading…"}</p>
          <p className="mt-1 text-sm text-muted">
            {currentPlan && currentPlan.plan === "free" && !currentPlan.isEnterprise
              ? "Free plan — nothing to renew."
              : renewsAt
                ? `Renews ${formatResetAt(renewsAt)}`
                : ""}
          </p>
          <button
            type="button"
            onClick={() => {
              useChat.getState().setDialog(null);
              void navigate({ to: "/upgrade" });
            }}
            className="mt-4 h-9 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Manage subscription
          </button>
        </div>
        <div className="rounded-2xl border border-border bg-background p-4">
          <p className="text-xs text-muted">Usage</p>
          <p className="mt-1 text-lg font-semibold">See what you've used</p>
          <p className="mt-1 text-sm text-muted">Weekly/5-hour limits, resets, and a feature breakdown.</p>
          <button
            type="button"
            onClick={() => useChat.getState().setSettingsTab("usage")}
            className="mt-4 h-9 rounded-full border border-border px-4 text-sm font-semibold hover:bg-chip"
          >
            View Usage
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-background">
        <p className="border-b border-border px-4 py-3 text-sm font-semibold">Invoices</p>
        {orders.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-sm font-medium">No invoices yet</p>
            <p className="mt-1 text-xs text-muted">Your invoices will appear here after your first payment.</p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {orders.map((order) => (
              <div key={order.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span>
                  {PLAN_DISPLAY_NAME[order.plan] ?? order.plan}{" "}
                  <span className="text-xs text-muted">({order.billingCycle})</span>
                </span>
                <span className="text-xs text-muted">{new Date(order.createdAt).toLocaleDateString()}</span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    order.status === "paid" ? "bg-chip text-foreground" : "text-danger",
                  )}
                >
                  {order.status}
                </span>
                <span className="font-mono text-sm">₹{(order.amountPaise / 100).toLocaleString("en-IN")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const PLAN_LABEL: Record<QuotaStatus["plan"], string> = { free: "Free", pro: "Pro", premium: "Premium" };
const DOT_COLORS = ["bg-search", "bg-think", "bg-canvas", "bg-accent", "bg-muted"];

function QuotaBar({
  title,
  bucket,
  help,
  breakdown,
}: {
  title: string;
  bucket: { used: number; limit: number; resetAt: string };
  help?: string;
  breakdown?: QuotaBreakdownEntry[];
}) {
  const pct = percentUsed(bucket);
  return (
    <div className="rounded-2xl border border-border bg-background p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {help && <span title={help} className="text-xs text-subtle">ⓘ</span>}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-2xl font-semibold text-foreground">
          {pct}% <span className="text-sm font-normal text-muted">used</span>
        </p>
        <p className="text-right text-xs text-muted">
          Resets <span className="font-medium text-foreground">{formatResetAt(bucket.resetAt)}</span>
        </p>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-chip">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-canvas" : "bg-search",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {breakdown && breakdown.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3 border-t border-border pt-3">
          {breakdown.map((entry, i) => (
            <span key={entry.type} className="flex items-center gap-1.5 text-xs text-muted">
              <span className={cn("size-1.5 rounded-full", DOT_COLORS[i % DOT_COLORS.length])} />
              {labelForEventType(entry.type)} <span className="font-medium text-foreground">{Math.max(0, entry.percent)}%</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function UsagePane() {
  const navigate = useNavigate();
  const { user } = useCurrentUserState();
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(user && !user.isDevFallback);

  useEffect(() => {
    if (!signedIn) return;
    api
      .get<QuotaResponse>("/usage/quota")
      .then((res) => {
        setQuota(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load usage"));
  }, [signedIn]);

  if (!signedIn) {
    return <SimpleNote title="Usage" body="Sign in to track your token limits and usage." />;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Usage</h2>
        {quota && (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-chip px-2.5 py-1 text-xs font-medium text-foreground">
              {quota.status.isEnterprise ? "Enterprise" : PLAN_LABEL[quota.status.plan]} plan
            </span>
            {!quota.status.isEnterprise && quota.status.plan !== "premium" && (
              <button
                type="button"
                onClick={() => {
                  useChat.getState().setDialog(null);
                  void navigate({ to: "/upgrade" });
                }}
                className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Upgrade
              </button>
            )}
          </div>
        )}
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {!quota ? (
        <p className="text-sm text-muted">Loading current usage…</p>
      ) : (
        <div className="space-y-3">
          <QuotaBar title="Weekly Limit" bucket={quota.status.weekly} breakdown={quota.breakdown} />
          {quota.status.rolling && (
            <QuotaBar
              title="5-Hour Limit"
              bucket={quota.status.rolling}
              breakdown={quota.rollingBreakdown}
              help="A short rolling window on top of your weekly limit, so one burst can't use up a whole week at once."
            />
          )}
          {quota.status.monthly && (
            <QuotaBar title="Monthly Limit" bucket={quota.status.monthly} breakdown={quota.monthlyBreakdown} />
          )}
          {quota.status.org && (
            <QuotaBar
              title={`Organization Pool (${quota.status.org.seatCount} seats)`}
              bucket={quota.status.org}
            />
          )}
          {quota.status.memberCap && (
            <QuotaBar
              title="Your Monthly Cap"
              bucket={{ ...quota.status.memberCap, resetAt: quota.status.org?.resetAt ?? new Date().toISOString() }}
              help="A personal sub-limit your org admin set within the shared pool above."
            />
          )}
          {quota.entitlements && <PlanIncludes e={quota.entitlements} />}
        </div>
      )}
    </div>
  );
}

/** What the user's plan (plus any package or enterprise settings) unlocks — from GET /usage/quota. */
function PlanIncludes({ e }: { e: NonNullable<QuotaResponse["entitlements"]> }) {
  const storage = e.libraryStorageMb >= 1024 ? `${+(e.libraryStorageMb / 1024).toFixed(1)} GB` : `${e.libraryStorageMb} MB`;
  const rows: [string, string][] = [
    ["Build Mode", e.buildMode ? `${e.buildMaxRounds} rounds per run` : "Not included"],
    ["Friday X (terminal + editor)", e.fridayX === false ? "Not included" : "Included"],
    ["Deep Research", e.deepResearchPerDay ? `${e.deepResearchPerDay} per day` : "Not included"],
    ["Documents", `${e.documentsPerDay} per day`],
    ["Custom skills", String(e.customSkills)],
    ["Library storage", storage],
    ["Team Up", `Up to ${e.teamUpModels} models`],
    ["MCP servers", String(e.mcpServers)],
    ["Automations", String(e.automations)],
    ["Support", e.prioritySupport ? "Priority" : "Standard"],
  ];
  return (
    <div className="rounded-2xl border border-border p-4">
      <p className="text-sm font-semibold text-foreground">What your plan includes</p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd className="text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type CliSession = { id: string; name: string; client: string; createdAt: string; lastUsedAt: string | null };

/** Friday X: the one-line install, and the terminals/editors currently signed in (each can be signed out here). */
function FridayXPane() {
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [sessions, setSessions] = useState<CliSession[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const origin = window.location.origin;
  const installs: [string, string][] = [
    ["macOS, Linux, WSL", `curl -fsSL ${origin}/x/install.sh | bash`],
    ["Windows PowerShell", `irm ${origin}/x/install.ps1 | iex`],
  ];

  useEffect(() => {
    if (!signedIn) return;
    api
      .get<{ sessions: CliSession[] }>("/x/sessions")
      .then((r) => setSessions(r.sessions))
      .catch((err) => setNotice(err instanceof Error ? err.message : "Couldn't load signed-in devices"));
  }, [signedIn]);

  async function signOutDevice(id: string) {
    setNotice(null);
    try {
      await api.delete(`/x/sessions/${id}`);
      setSessions((prev) => (prev ?? []).filter((x) => x.id !== id));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't sign that device out");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard blocked — the command is selectable */
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-base font-semibold text-foreground">Friday X</h3>
        <p className="mt-1 text-sm text-muted">Friday's coding agent for your terminal and editor. It uses your Friday plan, models and usage — the same meter as this app.</p>
      </div>
      <div className="flex flex-col gap-3">
        {installs.map(([label, cmd]) => (
          <div key={label}>
            <p className="mb-1 text-xs text-muted">{label}</p>
            <div className="flex items-center gap-2 rounded-xl border border-border bg-chip px-3 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">{cmd}</code>
              <button type="button" onClick={() => void copy(cmd)} className="shrink-0 rounded-full px-2 py-1 text-xs text-muted hover:bg-background hover:text-foreground">
                {copied === cmd ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted">Then run <span className="font-mono">friday</span> in any project. The first run opens your browser to sign in.</p>
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold text-foreground">Signed-in devices</p>
        {!signedIn ? (
          <p className="text-sm text-muted">Sign in to see your devices.</p>
        ) : sessions === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted">No terminals or editors are signed in.</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border">
            {sessions.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate text-foreground">{x.name}</p>
                  <p className="text-xs text-muted">
                    {x.client === "ide" ? "Editor" : "Terminal"} · signed in {new Date(x.createdAt).toLocaleDateString()}
                    {x.lastUsedAt ? ` · last used ${new Date(x.lastUsedAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <button type="button" onClick={() => void signOutDevice(x.id)} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs hover:bg-chip">
                  Sign out
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {notice ? <p className="text-sm text-danger">{notice}</p> : null}
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

type Memory = { id: string; content: string; createdAt: string };

/** What Friday remembers about the user across chats (saved when they ask it to remember something). */
function MemoryPane() {
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    api
      .get<{ memories: Memory[] }>("/memory")
      .then((r) => setMemories(r.memories))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load memory"));
  }, [signedIn]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      const content = draft.trim();
      if (!content) return;
      const { memory } = await api.post<{ memory: Memory }>("/memory", { content });
      setMemories((m) => [...(m ?? []).filter((x) => x.id !== memory.id), memory]);
      setDraft("");
    });
  const remove = (id: string) =>
    run(async () => {
      await api.delete(`/memory/${id}`);
      setMemories((m) => (m ?? []).filter((x) => x.id !== id));
    });
  const clearAll = () =>
    run(async () => {
      if (!window.confirm("Delete everything Friday remembers about you?")) return;
      await api.delete("/memory");
      setMemories([]);
    });

  return (
    <div>
      <h2 className="mb-2 text-lg font-semibold">Memory</h2>
      <p className="mb-4 text-sm text-muted">
        Friday remembers things you ask it to (“remember that I prefer TypeScript”) and uses them in every new chat. You can
        add, review and delete memories here.
      </p>
      {!signedIn ? (
        <p className="text-sm text-muted">Sign in to use memory.</p>
      ) : (
        <>
          {error && <p className="mb-3 text-sm text-danger">{error}</p>}
          <form
            className="mb-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={500}
              placeholder="Add something for Friday to remember…"
              className="h-10 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm outline-none focus:border-foreground/40"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="h-10 rounded-full bg-foreground px-4 text-sm font-medium text-background disabled:opacity-40"
            >
              Add
            </button>
          </form>
          {memories === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : memories.length === 0 ? (
            <p className="text-sm text-muted">Nothing saved yet.</p>
          ) : (
            <ul className="mb-4 divide-y divide-border rounded-xl border border-border">
              {memories.map((m) => (
                <li key={m.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <span className="min-w-0 flex-1 break-words">{m.content}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(m.id)}
                    aria-label="Delete memory"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {memories && memories.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void clearAll()}
              className="h-10 rounded-full border border-danger/60 px-4 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
            >
              Clear all memories
            </button>
          )}
        </>
      )}
    </div>
  );
}

type McpServer = { id: string; name: string; url: string; hasAuth: boolean; enabled: boolean; createdAt: string };

/** Remote MCP servers (Model Context Protocol) whose tools Friday can use in chat. */
function McpPane() {
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [form, setForm] = useState({ name: "", url: "", authorization: "" });
  const [tools, setTools] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    api
      .get<{ servers: McpServer[] }>("/mcp")
      .then((r) => setServers(r.servers))
      .catch((err) => setNotice(err instanceof Error ? err.message : "Couldn't load servers"));
  }, [signedIn]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      const res = await api.post<{ server: McpServer; tools: string[] }>("/mcp", {
        name: form.name.trim(),
        url: form.url.trim(),
        ...(form.authorization.trim() ? { authorization: form.authorization.trim() } : {}),
      });
      setServers((s) => [...(s ?? []), res.server]);
      setTools((t) => ({ ...t, [res.server.id]: res.tools }));
      setForm({ name: "", url: "", authorization: "" });
      setNotice(`Connected — ${res.tools.length} tool${res.tools.length === 1 ? "" : "s"} available in chat.`);
    });
  const toggle = (s: McpServer) =>
    run(async () => {
      const { server } = await api.patch<{ server: McpServer }>(`/mcp/${s.id}`, { enabled: !s.enabled });
      setServers((list) => (list ?? []).map((x) => (x.id === s.id ? server : x)));
    });
  const remove = (s: McpServer) =>
    run(async () => {
      await api.delete(`/mcp/${s.id}`);
      setServers((list) => (list ?? []).filter((x) => x.id !== s.id));
    });
  const inspect = (s: McpServer) =>
    run(async () => {
      const res = await api.get<{ tools: { name: string }[] }>(`/mcp/${s.id}/tools`);
      setTools((t) => ({ ...t, [s.id]: res.tools.map((x) => x.name) }));
    });

  const input = "h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-foreground/40";
  return (
    <div>
      <h2 className="mb-2 text-lg font-semibold">MCP servers</h2>
      <p className="mb-4 text-sm text-muted">
        Connect any remote <span className="font-medium text-foreground">Model Context Protocol</span> server (Streamable HTTP) and
        Friday can use its tools in chat — Linear, Sentry, Stripe, your own internal tools, and more.
      </p>
      {!signedIn ? (
        <p className="text-sm text-muted">Sign in to add MCP servers.</p>
      ) : (
        <>
          {notice && <p className="mb-3 text-sm text-muted">{notice}</p>}
          <form
            className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input className={input} placeholder="Name (e.g. Linear)" maxLength={40} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className={input} placeholder="https://…/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            <input
              className={cn(input, "sm:col-span-2")}
              placeholder="Authorization (optional) — token or “Bearer …”"
              type="password"
              value={form.authorization}
              onChange={(e) => setForm({ ...form, authorization: e.target.value })}
            />
            <button
              type="submit"
              disabled={busy || !form.name.trim() || !form.url.trim()}
              className="h-10 rounded-full bg-foreground px-4 text-sm font-medium text-background disabled:opacity-40 sm:col-span-2 sm:justify-self-start"
            >
              {busy ? "Connecting…" : "Add server"}
            </button>
          </form>
          {servers && servers.length === 0 && <p className="text-sm text-muted">No servers yet.</p>}
          <ul className="flex flex-col gap-2">
            {(servers ?? []).map((s) => (
              <li key={s.id} className={cn("rounded-xl border border-border px-4 py-3 text-sm", !s.enabled && "opacity-60")}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{s.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {s.url}
                      {s.hasAuth ? " · auth set" : ""}
                    </span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => void inspect(s)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-chip">
                    Tools
                  </button>
                  <button type="button" disabled={busy} onClick={() => void toggle(s)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-chip">
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(s)}
                    aria-label="Remove server"
                    className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                {tools[s.id] && (
                  <p className="mt-2 text-xs text-muted">{tools[s.id]!.length ? tools[s.id]!.join(", ") : "This server exposes no tools."}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Email preferences: product/offer email is opt-out; account email (codes, receipts, support) always goes. */
function NotificationsPane() {
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [marketing, setMarketing] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    api.get<{ marketing: boolean }>("/email/preferences").then((r) => setMarketing(r.marketing)).catch(() => setError("Couldn't load your email preferences"));
  }, [signedIn]);
  async function toggle() {
    if (marketing === null) return;
    const next = !marketing;
    setMarketing(next);
    try {
      await api.post("/email/preferences", { marketing: next });
    } catch {
      setMarketing(!next);
      setError("Couldn't save — try again");
    }
  }
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">Notifications</h2>
      {!signedIn ? (
        <p className="text-sm text-muted">Sign in to manage your email preferences.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start gap-4 rounded-2xl border border-border p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Product updates & offers</p>
              <p className="mt-0.5 text-sm text-muted">New features, tips and occasional offers by email. Every email also has a one-click unsubscribe link.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(marketing)}
              disabled={marketing === null}
              onClick={() => void toggle()}
              className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", marketing ? "bg-primary" : "bg-border")}
            >
              <span className={cn("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform", marketing && "translate-x-5")} />
            </button>
          </div>
          <p className="text-xs leading-relaxed text-subtle">Account emails — sign-in codes, receipts, replies to your support requests and important notices — are always sent.</p>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}
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
