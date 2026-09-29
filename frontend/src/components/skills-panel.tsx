import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useChat } from "@/lib/chat/store";
import { cn } from "@/lib/utils";

/**
 * Skills tab of the Plugins drawer: Friday's built-in expert playbooks (grouped by category, each
 * switchable) plus the user's own. "Use in chat" pins a skill to the composer; otherwise Friday
 * loads a matching enabled skill by itself when a request calls for it.
 */

type Skill = { id: string; source: "builtin" | "user"; name: string; description: string; icon: string; category: string; enabled: boolean; instructions?: string };
type SkillsResponse = { categories: string[]; skills: Skill[]; limits: { customSkills: number } };

const ICONS = ["✨", "🧠", "📊", "📝", "💼", "🧑‍💻", "🎯", "📈", "🎨", "📚", "⚡", "🔍"];

export function SkillsPanel({ query }: { query: string }) {
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const activeSkill = useChat((s) => s.activeSkill);
  const setActiveSkill = useChat((s) => s.setActiveSkill);
  const setDialog = useChat((s) => s.setDialog);
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<Skill | "new" | null>(null);

  function load() {
    if (!signedIn) return;
    api.get<SkillsResponse>("/skills").then(setData).catch((err) => setError(err instanceof Error ? err.message : "Couldn't load skills"));
  }
  useEffect(load, [signedIn]);

  const q = query.trim().toLowerCase();
  const grouped = useMemo(() => {
    const skills = (data?.skills ?? []).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
    return (data?.categories ?? []).map((c) => ({ category: c, skills: skills.filter((s) => s.category === c) })).filter((g) => g.skills.length || g.category === "My skills");
  }, [data, q]);

  async function toggle(skill: Skill) {
    setData((d) => d && { ...d, skills: d.skills.map((s) => (s.id === skill.id ? { ...s, enabled: !s.enabled } : s)) });
    try {
      await api.post(`/skills/${encodeURIComponent(skill.id)}/enabled`, { enabled: !skill.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the skill");
      load();
    }
  }

  function use(skill: Skill) {
    setActiveSkill({ id: skill.id, name: skill.name, icon: skill.icon });
    setDialog(null);
  }

  if (!signedIn) return <p className="text-sm text-muted">Sign in to use and create skills.</p>;
  if (view) return <SkillDetail skill={view} onBack={() => setView(null)} onSaved={() => { setView(null); load(); }} onUse={use} />;

  const mine = data?.skills.filter((s) => s.source === "user").length ?? 0;
  return (
    <div>
      <div className="mb-5 flex items-start gap-3 rounded-2xl border border-border bg-background/60 p-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-canvas/15 text-canvas"><Sparkles className="size-4.5" /></span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-foreground">Skills are expert playbooks</p>
          <p className="mt-0.5 text-muted">Friday picks the right one automatically when your request matches — or choose one to use for this chat.</p>
        </div>
        <button type="button" onClick={() => setView("new")} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-semibold text-primary-foreground">
          <Plus className="size-4" /> New skill
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {!data ? (
        <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: 6 }, (_, i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-chip/60" />)}</div>
      ) : (
        grouped.map((group) => (
          <section key={group.category} className="mb-6">
            <div className="mb-2 flex items-center gap-2">
              <p className="text-sm font-semibold">{group.category}</p>
              {group.category === "My skills" && <span className="text-xs text-subtle">{mine} / {data.limits.customSkills}</span>}
            </div>
            {group.skills.length === 0 ? (
              <button type="button" onClick={() => setView("new")} className="w-full rounded-xl border border-dashed border-border px-4 py-4 text-left text-sm text-muted hover:bg-chip">
                Teach Friday your way of doing something — your writing voice, a checklist, a company format.
              </button>
            ) : (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.skills.map((skill) => {
                  const inUse = activeSkill?.id === skill.id;
                  return (
                    <li key={skill.id} className={cn("group flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors", inUse ? "border-canvas/50 bg-canvas/5" : "border-transparent hover:bg-chip")}>
                      <button type="button" onClick={() => setView(skill)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                        <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg bg-chip text-lg", !skill.enabled && "opacity-40 grayscale")} aria-hidden>{skill.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate text-sm font-medium", !skill.enabled && "text-muted")}>{skill.name}</span>
                          <span className="line-clamp-2 block text-xs text-muted">{skill.description}</span>
                        </span>
                      </button>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={skill.enabled}
                          aria-label={skill.enabled ? `Turn off ${skill.name}` : `Turn on ${skill.name}`}
                          onClick={() => void toggle(skill)}
                          className={cn("relative h-5 w-9 rounded-full transition-colors", skill.enabled ? "bg-primary" : "bg-border")}
                        >
                          <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform", skill.enabled && "translate-x-4")} />
                        </button>
                        <button type="button" disabled={!skill.enabled} onClick={() => use(skill)} className="text-[11px] font-medium text-canvas opacity-0 transition-opacity group-hover:opacity-100 disabled:hidden">
                          {inUse ? <span className="inline-flex items-center gap-0.5"><Check className="size-3" /> In use</span> : "Use in chat"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))
      )}
    </div>
  );
}

function SkillDetail({ skill, onBack, onSaved, onUse }: { skill: Skill | "new"; onBack: () => void; onSaved: () => void; onUse: (s: Skill) => void }) {
  const creating = skill === "new";
  const [full, setFull] = useState<Skill | null>(creating ? null : skill);
  const [editing, setEditing] = useState(creating);
  const [form, setForm] = useState({ name: "", description: "", instructions: "", icon: "✨" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (creating) return;
    api.get<{ skill: Skill }>(`/skills/${encodeURIComponent(skill.id)}`).then((r) => {
      setFull(r.skill);
      setForm({ name: r.skill.name, description: r.skill.description, instructions: r.skill.instructions ?? "", icon: r.skill.icon });
    }).catch(() => {});
  }, [creating, skill]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (creating) await api.post("/skills", form);
      else await api.patch(`/skills/${encodeURIComponent((skill as Skill).id)}`, form);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the skill");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (creating || !window.confirm("Delete this skill?")) return;
    try {
      await api.delete(`/skills/${encodeURIComponent((skill as Skill).id)}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the skill");
    }
  }

  const own = creating || (skill as Skill).source === "user";
  return (
    <AnimatePresence mode="wait">
      <motion.div key={editing ? "edit" : "view"} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }}>
        <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> All skills
        </button>
        {editing ? (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="flex gap-2">
              <div className="flex flex-wrap gap-1">
                {ICONS.map((icon) => (
                  <button key={icon} type="button" onClick={() => setForm({ ...form, icon })} className={cn("grid size-9 place-items-center rounded-lg text-lg transition-colors", form.icon === icon ? "bg-chip-on ring-1 ring-foreground/20" : "hover:bg-chip")}>{icon}</button>
                ))}
              </div>
            </div>
            <label className="grid gap-1 text-xs text-muted">Name
              <input required minLength={2} maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Our brand voice" className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-foreground/40" />
            </label>
            <label className="grid gap-1 text-xs text-muted">When should Friday use it?
              <input maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Any marketing copy, posts or emails for our company" className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-foreground/40" />
            </label>
            <label className="grid gap-1 text-xs text-muted">Instructions (the playbook)
              <textarea required minLength={20} maxLength={12000} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder={"1. Always write in a warm, direct tone…\n2. Use Indian English spellings…\n3. End with one clear call to action…"} className="min-h-[180px] rounded-xl border border-border bg-background px-3 py-2 font-mono text-[13px] text-foreground outline-none focus:border-foreground/40" />
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className="h-10 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Saving…" : creating ? "Create skill" : "Save"}</button>
              <button type="button" onClick={creating ? onBack : () => setEditing(false)} className="h-10 rounded-full border border-border px-4 text-sm hover:bg-chip">Cancel</button>
            </div>
          </form>
        ) : full ? (
          <div>
            <div className="flex items-start gap-3">
              <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-chip text-2xl" aria-hidden>{full.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold">{full.name}</p>
                <p className="text-sm text-muted">{full.description}</p>
                <p className="mt-1 text-xs text-subtle">{full.source === "builtin" ? `Built-in · ${full.category}` : "Your skill"}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => onUse(full)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground"><Sparkles className="size-4" /> Use in chat</button>
              {own && <button type="button" onClick={() => setEditing(true)} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-3.5 text-sm hover:bg-chip"><Pencil className="size-3.5" /> Edit</button>}
              {own && <button type="button" onClick={() => void remove()} className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm text-danger hover:bg-danger/10"><Trash2 className="size-3.5" /> Delete</button>}
            </div>
            {error && <p className="mt-3 text-sm text-danger">{error}</p>}
            <p className="mt-6 mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">Playbook</p>
            <pre className="scroll-thin max-h-[320px] overflow-auto rounded-xl bg-chip p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap text-foreground">{full.instructions ?? "Loading…"}</pre>
          </div>
        ) : null}
      </motion.div>
    </AnimatePresence>
  );
}
