import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Puzzle, Search, X } from "lucide-react";
import { FEATURED_PLUGINS, FRIDAY_TOOLS, type PluginItem } from "@/lib/plugins";
import { PLUGIN_LOGOS, PluginLogo } from "@/components/plugin-logos";
import { useChat } from "@/lib/chat/store";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ConnectorProvider =
  | "github"
  | "google"
  | "notion"
  | "supabase"
  | "railway"
  | "finance"
  | "box"
  | "canva"
  | "razorpay"
  | "vercel";

type ConnectorField = {
  key: "token" | "secret" | "url";
  label: string;
  secret?: boolean;
  placeholder?: string;
};

type ConnectorSpec = {
  mode: "oauth" | "token";
  configured: boolean;
  pluginIds: string[];
  fields: ConnectorField[];
};

type ConnectorAccount = {
  id: string;
  provider: ConnectorProvider;
  accountLogin: string | null;
  accountName: string | null;
  connectedAt: string;
};

export function PluginsDrawer() {
  const dialog = useChat((s) => s.dialog);
  const setDialog = useChat((s) => s.setDialog);
  const think = useChat((s) => s.think);
  const setThink = useChat((s) => s.setThink);
  const webSearch = useChat((s) => s.webSearch);
  const setWebSearch = useChat((s) => s.setWebSearch);
  const canvas = useChat((s) => s.canvas);
  const setCanvas = useChat((s) => s.setCanvas);
  const research = useChat((s) => s.research);
  const setResearch = useChat((s) => s.setResearch);
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [tab, setTab] = useState<"connectors" | "skills">("connectors");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<PluginItem | null>(null);
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([]);
  const [specs, setSpecs] = useState<Record<string, ConnectorSpec>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ title: string; subtitle?: string | null; url?: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const on = { search: webSearch, think, canvas, research };
  const toggle = { search: setWebSearch, think: setThink, canvas: setCanvas, research: setResearch };

  const pluginProvider = useMemo(() => {
    const map = new Map<string, ConnectorProvider>();
    for (const [provider, spec] of Object.entries(specs)) {
      for (const pluginId of spec.pluginIds) map.set(pluginId, provider as ConnectorProvider);
    }
    return map;
  }, [specs]);

  function refreshConnectors() {
    if (!signedIn) {
      setAccounts([]);
      return;
    }
    Promise.all([
      api.get<{ accounts: ConnectorAccount[] }>("/connectors"),
      api.get<{ connectors: Record<string, ConnectorSpec> }>("/connectors/config"),
    ])
      .then(([accountRes, configRes]) => {
        setAccounts(accountRes.accounts);
        setSpecs(configRes.connectors);
      })
      .catch(() => setAccounts([]));
  }

  useEffect(refreshConnectors, [signedIn]);

  const activeProvider = active ? pluginProvider.get(active.id) : undefined;
  const activeSpec = activeProvider ? specs[activeProvider] : undefined;
  const activeAccount = accounts.find((account) => account.provider === activeProvider);

  async function startOAuth(provider: "github" | "google") {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.get<{ url: string }>(
        `/connectors/${provider}/start?returnTo=${encodeURIComponent("/?dialog=plugins")}`,
      );
      window.location.assign(res.url);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't start connect");
      setBusy(false);
    }
  }

  async function connectToken(provider: ConnectorProvider) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.post<{ account: ConnectorAccount }>(`/connectors/${provider}`, {
        token: values.token,
        secret: values.secret,
        url: values.url,
      });
      setAccounts((current) => [res.account, ...current.filter((account) => account.provider !== provider)]);
      setValues({});
      setNotice("Connected.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't connect");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(provider: ConnectorProvider) {
    setBusy(true);
    setNotice(null);
    try {
      await api.delete(`/connectors/${provider}`);
      setAccounts((current) => current.filter((account) => account.provider !== provider));
      setPreview([]);
      setNotice("Disconnected.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't disconnect");
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview(provider: ConnectorProvider) {
    try {
      const res = await api.get<{ items: typeof preview }>(`/connectors/${provider}/preview`);
      setPreview(res.items);
    } catch {
      setPreview([]);
    }
  }

  useEffect(() => {
    if (activeAccount && activeProvider) void loadPreview(activeProvider);
    else setPreview([]);
  }, [activeAccount?.id, activeProvider]);

  const featured = FEATURED_PLUGINS.filter(
    (p) =>
      !q.trim() ||
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      p.desc.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <Dialog.Root open={dialog === "plugins"} onOpenChange={(v) => !v && setDialog(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed top-[50%] left-[50%] z-50 flex h-[min(86vh,640px)] w-[min(94vw,840px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-2xl border border-border bg-elevated shadow-[var(--shadow-composer)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <div className="flex rounded-full bg-chip p-0.5 text-sm">
                <button
                  type="button"
                  onClick={() => setTab("connectors")}
                  className={cn(
                    "rounded-full px-3 py-1",
                    tab === "connectors" ? "bg-composer text-foreground" : "text-muted",
                  )}
                >
                  Connectors
                </button>
                <button
                  type="button"
                  onClick={() => setTab("skills")}
                  className={cn(
                    "rounded-full px-3 py-1",
                    tab === "skills" ? "bg-composer text-foreground" : "text-muted",
                  )}
                >
                  Skills
                </button>
              </div>
              <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-background px-3 text-muted">
                <Search className="size-3.5" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search…"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
                />
              </label>
              <Dialog.Close className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground">
                <X className="size-4" />
              </Dialog.Close>
            </div>
            <Dialog.Title className="sr-only">Plugins</Dialog.Title>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
              {tab === "connectors" ? (
                <>
                  {notice && <p className="mb-3 text-sm text-muted">{notice}</p>}
                  <p className="mb-3 text-sm font-semibold">Connected</p>
                  <ul className="mb-8 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {FRIDAY_TOOLS.map((p) => {
                      const enabled = on[p.id as keyof typeof on];
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => {
                              toggle[p.id as keyof typeof toggle](!enabled);
                              setActive(p);
                            }}
                            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-chip"
                          >
                            <span className="grid size-9 place-items-center rounded-lg bg-chip">
                              <Puzzle className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium">{p.name}</span>
                              <span className="block truncate text-xs text-muted">{p.desc}</span>
                            </span>
                            <span
                              className={cn(
                                "rounded-full px-2.5 py-0.5 text-xs",
                                enabled ? "bg-chip text-foreground" : "border border-border text-muted",
                              )}
                            >
                              {enabled ? (
                                <span className="inline-flex items-center gap-1">
                                  <Check className="size-3" /> On
                                </span>
                              ) : (
                                "Add"
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {accounts.map((account) => {
                      const plugin = FEATURED_PLUGINS.find((item) => pluginProvider.get(item.id) === account.provider);
                      if (!plugin) return null;
                      return (
                        <li key={account.id}>
                          <button
                            type="button"
                            onClick={() => setActive(plugin)}
                            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-chip"
                          >
                            <span className="grid size-9 place-items-center rounded-lg bg-chip">
                              {PLUGIN_LOGOS[plugin.id] ? <PluginLogo id={plugin.id} className="size-4.5" /> : plugin.name.charAt(0)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium">{plugin.name}</span>
                              <span className="block truncate text-xs text-muted">
                                {account.accountLogin ?? "connected"}
                              </span>
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-full bg-chip px-2.5 py-0.5 text-xs">
                              <Check className="size-3" /> On
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mb-3 text-sm font-semibold">Featured</p>
                  <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {featured.map((p) => {
                      const provider = pluginProvider.get(p.id);
                      const connected = Boolean(provider && accounts.some((account) => account.provider === provider));
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => setActive(p)}
                            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-chip"
                          >
                            <span className="grid size-9 place-items-center rounded-lg bg-chip text-sm font-semibold">
                              {PLUGIN_LOGOS[p.id] ? <PluginLogo id={p.id} className="size-4.5" /> : p.name.charAt(0)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium">{p.name}</span>
                              <span className="block truncate text-xs text-muted">{p.desc}</span>
                            </span>
                            <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">
                              {connected ? "Connected" : "Add"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <div className="text-sm text-muted">
                  <p className="mb-2 font-semibold text-foreground">Skills</p>
                  <p>Think, Search, Canvas and Deep Research are Friday’s built-in skills. Turn them on from Connectors or the composer.</p>
                </div>
              )}
            </div>
          </div>
          {active && (
            <aside className="flex w-[min(100%,18rem)] shrink-0 flex-col border-l border-border bg-surface">
              <div className="flex items-center justify-between px-4 py-3">
                <p className="text-sm font-semibold">{active.name}</p>
                <button
                  type="button"
                  onClick={() => setActive(null)}
                  className="flex size-7 items-center justify-center rounded-full text-muted hover:bg-chip"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="scroll-thin flex-1 overflow-y-auto px-4 pb-4 text-sm leading-relaxed text-muted">
                <p>{active.desc}</p>
                {active.group === "connected" ? (
                  <p className="mt-3">This is a Friday tool. Toggle it here or from the composer.</p>
                ) : activeAccount && activeProvider ? (
                  <div className="mt-3 space-y-3">
                    <p>
                      Connected as <span className="text-foreground">{activeAccount.accountLogin}</span>.
                    </p>
                    {preview.length > 0 && (
                      <ul className="space-y-1.5">
                        {preview.map((item) => (
                          <li key={`${item.title}-${item.url ?? ""}`} className="rounded-lg bg-chip px-2 py-1.5">
                            <p className="text-foreground">{item.title}</p>
                            {item.subtitle && <p className="text-xs">{item.subtitle}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void disconnect(activeProvider)}
                      className="h-9 rounded-full border border-border px-3 text-sm text-foreground disabled:opacity-50"
                    >
                      Disconnect
                    </button>
                  </div>
                ) : activeSpec?.mode === "oauth" && (activeProvider === "github" || activeProvider === "google") ? (
                  <div className="mt-3 space-y-3">
                    <p>
                      {activeSpec.configured
                        ? `Connect ${active.name} with OAuth.`
                        : `${active.name} OAuth keys are not configured on this environment yet.`}
                    </p>
                    <button
                      type="button"
                      disabled={busy || !activeSpec.configured || !signedIn}
                      onClick={() => void startOAuth(activeProvider)}
                      className="h-9 rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                    >
                      {signedIn ? `Connect ${active.name}` : "Sign in to connect"}
                    </button>
                  </div>
                ) : activeSpec?.mode === "token" && activeProvider ? (
                  <form
                    className="mt-3 space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void connectToken(activeProvider);
                    }}
                  >
                    <p>Paste a live credential. Friday verifies it before saving, then encrypts it at rest.</p>
                    {activeSpec.fields.map((field) => (
                      <input
                        key={field.key}
                        type={field.secret ? "password" : "text"}
                        value={values[field.key] ?? ""}
                        onChange={(e) => setValues((current) => ({ ...current, [field.key]: e.target.value }))}
                        placeholder={field.placeholder || field.label}
                        className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none"
                      />
                    ))}
                    <button
                      type="submit"
                      disabled={busy || !signedIn}
                      className="h-9 rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                    >
                      {signedIn ? "Connect" : "Sign in to connect"}
                    </button>
                  </form>
                ) : (
                  <p className="mt-3">Sign in to connect this plugin.</p>
                )}
              </div>
            </aside>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
