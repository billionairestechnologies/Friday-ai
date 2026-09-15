import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Puzzle, Search, X } from "lucide-react";
import { FEATURED_PLUGINS, FRIDAY_TOOLS, type PluginItem } from "@/lib/plugins";
import { useChat } from "@/lib/chat/store";
import { cn } from "@/lib/utils";

export function PluginsDrawer() {
  const dialog = useChat((s) => s.dialog);
  const setDialog = useChat((s) => s.setDialog);
  const think = useChat((s) => s.think);
  const setThink = useChat((s) => s.setThink);
  const webSearch = useChat((s) => s.webSearch);
  const setWebSearch = useChat((s) => s.setWebSearch);
  const canvas = useChat((s) => s.canvas);
  const setCanvas = useChat((s) => s.setCanvas);
  const [tab, setTab] = useState<"connectors" | "skills">("connectors");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<PluginItem | null>(null);

  const on = { search: webSearch, think, canvas };
  const toggle = {
    search: setWebSearch,
    think: setThink,
    canvas: setCanvas,
  };

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
                  </ul>
                  <p className="mb-3 text-sm font-semibold">Featured</p>
                  <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {featured.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => setActive(p)}
                          className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-chip"
                        >
                          <span className="grid size-9 place-items-center rounded-lg bg-chip text-sm font-semibold">
                            {p.name.charAt(0)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{p.name}</span>
                            <span className="block truncate text-xs text-muted">{p.desc}</span>
                          </span>
                          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">
                            Add
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="text-sm text-muted">
                  <p className="mb-2 font-semibold text-foreground">Skills</p>
                  <p>Think, Search, and Canvas are Friday’s built-in skills. Turn them on from Connectors or the composer.</p>
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
              <div className="px-4 text-sm leading-relaxed text-muted">
                <p>{active.desc}</p>
                {active.group === "connected" ? (
                  <p className="mt-3">This is a Friday tool. Toggle it here or from the composer.</p>
                ) : (
                  <p className="mt-3">External connectors aren’t wired in this preview. Search, Think, and Canvas work now.</p>
                )}
              </div>
            </aside>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
