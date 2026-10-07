import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BotAvatar, type BotAvatarType } from "bot-avatars";
import { BorderBeam } from "border-beam";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { VoiceBeam, useMicrophone } from "voice-glow";
import { ArrowLeft, Monitor, Moon, Phone, Plus, Settings, Sun, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Air Dots, wired to the live runtime (backend: routes/air.ts, services/air/*).
 *
 * A dot is a named Air Dots thread with standing instructions and a mascot — one conversation on the
 * same account, memory, usage meter and machine. What used to be local preview data is now real:
 *   - the thread is the conversation's messages; sending starts an Air Dot job that keeps working
 *     until it reports done / needs you, or the person says rukho (POST /air/jobs, /stop);
 *   - "Needs you" is the job waiting for a yes (pay/send/book/delete, passphrase once set) or for a
 *     sign-in on the screen;
 *   - the computer is the browser the dot drives, live (screenshot + click/type/URL), where logins happen;
 *   - Call is a real call: the verified mobile when a trunk is set up, otherwise the browser line;
 *     either way the plan's call minutes count;
 *   - the side pane shows the dot's jobs, results and the gate's record of every action.
 * Only per-viewer conveniences stay in this browser: theme, sidebar, panel sizes, and groups.
 */

type Theme = "dark" | "light";
type Face = BotAvatarType;
type Motion = OrbState;

const PALETTE: { face: Face; color: string }[] = [
  { face: "clover" as Face, color: "#8eb7e8" },
  { face: "blob", color: "#8eb7e8" },
  { face: "cat", color: "#f0b4c8" },
  { face: "droid", color: "#c4b6e8" },
  { face: "ghost", color: "#b7d7c3" },
  { face: "star", color: "#efd3a0" },
  { face: "cloud", color: "#b9dce4" },
];
const MOTIONS: Motion[] = ["working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"];

type AirDot = { id: string; conversation_id: string; name: string; instructions: string; face: string; color: string; motion: string };
type JobStatus = "running" | "done" | "blocked" | "needs_login" | "needs_approval" | "stopped" | "failed" | "out_of_meter";
type Job = { id: string; task: string; status: JobStatus; summary: string | null; needs: string | null; rounds: number; created_at: string; finished_at?: string | null };
type Message = { id: string; role: "user" | "assistant" | "system"; content: string; created_at: string; error?: string | null };
type Note = { id: string; from: string; text: string };
type Action = { id: number; kind: string; name: string; detail: string; decision: "allowed" | "refused" | "approved"; created_at: string };
type Group = { id: string; name: string; memberIds: string[] };
type Screen =
  | { mode: "browser"; image: string; url: string | null; title: string | null; width: number; height: number }
  | { mode: "preview"; preview: string | null; width: number; height: number }
  | { mode: "idle"; width: number; height: number };

// What the job loop sends to keep going (backend air/jobs.ts CONTINUE_PROMPT) — not the person's words.
const CONTINUE = /^(Keep going on the same job|Continue until this is done|Approved (on|\.)|The person has signed in on the screen)/;
const STOP = /^\s*(rukho|ruko|stop|pause|bas)\s*[.!]?\s*$/i;

const STARTERS = [
  "Find a quiet cooling pad for a 16-inch MacBook and tell me which one to get",
  "Watch my inbox and bring me only what needs a reply today",
  "Build a one-page site for my bakery and give me the preview",
  "Order my usual from Zomato, but ask me before paying",
];

const STATUS_LABEL: Record<JobStatus, string> = {
  running: "Working",
  done: "Done",
  blocked: "Stuck",
  needs_login: "Needs you to sign in",
  needs_approval: "Waiting for your yes",
  stopped: "Stopped",
  failed: "Couldn't finish",
  out_of_meter: "Usage used up",
};

const LOCAL = "friday.air.view";
function loadView(): { theme: Theme; nav: boolean; groups: Group[]; railW: number; screenW: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL) ?? "{}") as Partial<{ theme: Theme; nav: boolean; groups: Group[]; railW: number; screenW: number }>;
    return { theme: raw.theme === "light" ? "light" : "dark", nav: raw.nav !== false, groups: Array.isArray(raw.groups) ? raw.groups : [], railW: raw.railW ?? 300, screenW: raw.screenW ?? 560 };
  } catch {
    return { theme: "dark", nav: true, groups: [], railW: 300, screenW: 560 };
  }
}

const AIR_MOTION = `
.air-stage { transition: background-color .45s ease, color .45s ease; }
.air-in { animation: air-in .45s cubic-bezier(.16,.84,.32,1) both; }
@keyframes air-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.air-pop { animation: air-pop .55s cubic-bezier(.16,.84,.32,1) both; }
@keyframes air-pop { from { opacity: 0; transform: translateY(14px) scale(.9); } to { opacity: 1; transform: none; } }
.air-call { transition: transform .25s ease, box-shadow .25s ease; }
.air-call:hover { transform: scale(1.08); }
.air-caret { display: inline-block; margin-left: 1px; animation: air-blink .7s steps(1) infinite; }
@keyframes air-blink { 50% { opacity: 0; } }
`;

/** Phones: the sidebar becomes a drawer and the computer opens full screen (finger as the cursor). */
function useNarrow() {
  const query = "(max-width: 767px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function errorText(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export function AirWorkspace({ conversationId }: { conversationId?: string } = {}) {
  const navigate = useNavigate();
  const initial = useMemo(loadView, []);
  const narrow = useNarrow();
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [nav, setNav] = useState(initial.nav && !(typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches));
  const [groups, setGroups] = useState<Group[]>(initial.groups);
  const [railW, setRailW] = useState(initial.railW);
  const [screenW, setScreenW] = useState(initial.screenW);

  const [dots, setDots] = useState<AirDot[] | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [making, setMaking] = useState<"dot" | "group" | null>(null);
  const [form, setForm] = useState({ name: "", instructions: "", face: "clover" as Face, color: "#8eb7e8", motion: "working" as Motion, members: [] as string[] });

  const [messages, setMessages] = useState<Message[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [badges, setBadges] = useState<Record<string, JobStatus | undefined>>({});
  const [arriving, setArriving] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [panel, setPanel] = useState<"work" | "settings">("work");
  const [rail, setRail] = useState(false);
  const [screen, setScreen] = useState(false);
  const [call, setCall] = useState(false);
  const [beat, setBeat] = useState(0);
  const [teamNotes, setTeamNotes] = useState<Note[]>([]);
  const [teamWorking, setTeamWorking] = useState(false);
  const lastSeen = useRef<string | null>(null);
  const [featured, setFeatured] = useState<{ id: string; title: string; body: string; ctaLabel: string | null; ctaUrl: string | null } | null>(null);

  useEffect(() => {
    void api.get<{ featured: typeof featured }>("/air/featured").then((r) => setFeatured(r.featured)).catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL, JSON.stringify({ theme, nav, groups, railW, screenW }));
    } catch {
      /* private window: the view just isn't remembered */
    }
  }, [theme, nav, groups, railW, screenW]);

  // ── Load the dots ──
  const loadDots = useCallback(async () => {
    try {
      const res = await api.get<{ dots: AirDot[] }>("/air/dots");
      setDots(res.dots);
      setLocked(null);
      return res.dots;
    } catch (err) {
      const message = errorText(err, "Couldn't load Air Dots.");
      setLocked(/plan/i.test(message) ? message : null);
      if (!/plan/i.test(message)) setError(message);
      setDots([]);
      return [];
    }
  }, []);

  useEffect(() => {
    void loadDots().then((list) => {
      if (conversationId) {
        const match = list.find((d) => d.conversation_id === conversationId);
        if (match) setOpenId(match.id);
      }
    });
  }, [loadDots, conversationId]);

  const dot = dots?.find((item) => item.id === openId) ?? null;
  const group = groups.find((item) => item.id === groupId) ?? null;
  const members = useMemo(() => (group && dots ? dots.filter((item) => group.memberIds.includes(item.id)) : []), [group, dots]);
  const working = job?.status === "running" || sending;

  // ── The open dot: messages + job, polled while it works ──
  const refresh = useCallback(async (target: AirDot) => {
    const [msgs, latest] = await Promise.all([
      api.get<{ messages: Message[] }>(`/chat/conversations/${target.conversation_id}/messages`).catch(() => ({ messages: [] as Message[] })),
      api.get<{ job: Job | null }>(`/air/jobs/${target.conversation_id}`).catch(() => ({ job: null })),
    ]);
    const visible = msgs.messages.filter((m) => m.role !== "system" && !(m.role === "user" && CONTINUE.test(m.content)));
    const newest = [...visible].reverse().find((m) => m.role === "assistant");
    if (newest && lastSeen.current && newest.id !== lastSeen.current) setArriving(newest.id);
    if (newest) lastSeen.current = newest.id;
    setMessages(visible);
    setJob(latest.job);
    setBadges((all) => ({ ...all, [target.id]: latest.job?.status }));
  }, []);

  const refreshSide = useCallback(async (target: AirDot) => {
    const [history, gate] = await Promise.all([
      api.get<{ jobs: Job[] }>(`/air/jobs/${target.conversation_id}/history`).catch(() => ({ jobs: [] as Job[] })),
      api.get<{ actions: Action[] }>(`/air/actions/${target.conversation_id}`).catch(() => ({ actions: [] as Action[] })),
    ]);
    setJobs(history.jobs);
    setActions(gate.actions);
  }, []);

  useEffect(() => {
    if (!dot) return;
    lastSeen.current = null;
    setMessages([]);
    setJob(null);
    void refresh(dot);
    void refreshSide(dot);
    void navigate({ to: "/air/$conversationId", params: { conversationId: dot.conversation_id }, replace: true });
  }, [dot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dot) return;
    const every = working ? 2500 : 12_000;
    const id = window.setInterval(() => {
      void refresh(dot);
      if (rail) void refreshSide(dot);
    }, every);
    return () => window.clearInterval(id);
  }, [dot, working, rail, refresh, refreshSide]);

  // Badges for the other dots (needs you / working), every 20 s.
  useEffect(() => {
    if (!dots?.length) return;
    const tick = () =>
      void Promise.all(
        dots.map((d) => api.get<{ job: Job | null }>(`/air/jobs/${d.conversation_id}`).then((r) => [d.id, r.job?.status] as const).catch(() => [d.id, undefined] as const)),
      ).then((rows) => setBadges(Object.fromEntries(rows)));
    tick();
    const id = window.setInterval(tick, 20_000);
    return () => window.clearInterval(id);
  }, [dots]);

  useEffect(() => {
    if (!working && !teamWorking) return;
    const id = window.setInterval(() => setBeat((n) => n + 1), 520);
    return () => window.clearInterval(id);
  }, [working, teamWorking]);

  const dark = theme === "dark";
  const ink = dark ? "#eceae4" : "#1c1b19";
  const muted = dark ? "#9a958c" : "#6f6a63";
  const bg = dark ? "#101010" : "#f6f4f0";
  const panelBg = dark ? "#171717" : "#fffcf8";
  const line = dark ? "rgba(255,255,255,.08)" : "rgba(28,27,25,.08)";
  const youBg = dark ? "#2c4f86" : "#dce8f8";
  const youInk = dark ? "#f4f7fb" : "#1c1b19";
  const replyBg = dark ? "#222220" : "#f3f1ec";
  const card = dark ? "none" : "0 1px 2px rgba(28,27,25,.04)";
  const soft = dark ? "#262626" : "#f3f1ec";

  const steps: { motion: Motion; label: string }[] = [
    { motion: (dot?.motion as Motion) ?? "working", label: "Working" },
    { motion: "searching", label: "Looking" },
    { motion: "solving", label: "Thinking" },
    { motion: "composing", label: "Writing" },
  ];
  const step = steps[beat % steps.length]!;

  // ── Actions ──
  async function send(text: string, target: AirDot | null = dot) {
    const cleaned = text.trim();
    if (!target || !cleaned || sending) return;
    setDraft("");
    setError(null);
    if (STOP.test(cleaned)) {
      await api.post(`/air/jobs/${target.conversation_id}/stop`, {}).catch(() => undefined);
      await refresh(target);
      return;
    }
    setSending(true);
    setMessages((all) => [...all, { id: `local-${Date.now()}`, role: "user", content: cleaned, created_at: new Date().toISOString() }]);
    try {
      const res = await api.post<{ started: boolean; reason?: string }>("/air/jobs", { conversationId: target.conversation_id, task: cleaned });
      if (!res.started && res.reason === "already-running") setError("Still on the last job. Say rukho to stop it, or wait for it to finish.");
    } catch (err) {
      setError(errorText(err, "Couldn't start that."));
    } finally {
      setSending(false);
      void refresh(target);
    }
  }

  async function approve(passphrase: string) {
    if (!dot) return;
    setError(null);
    try {
      await api.post(`/air/jobs/${dot.conversation_id}/approve`, passphrase ? { passphrase } : {});
    } catch (err) {
      setError(errorText(err, "That didn't go through."));
    }
    void refresh(dot);
  }

  async function hold() {
    if (!dot) return;
    await api.post(`/air/jobs/${dot.conversation_id}/stop`, {}).catch(() => undefined);
    void refresh(dot);
  }

  async function signedIn() {
    if (!dot) return;
    await api.post(`/air/jobs/${dot.conversation_id}/signed-in`, {}).catch((err: unknown) => setError(errorText(err, "Couldn't continue.")));
    void refresh(dot);
  }

  async function saveDot(next: Partial<AirDot>) {
    if (!dot) return;
    setDots((all) => all?.map((d) => (d.id === dot.id ? { ...d, ...next } : d)) ?? all);
    await api.patch(`/air/dots/${dot.id}`, next).catch((err: unknown) => setError(errorText(err, "Couldn't save.")));
  }

  async function removeDot() {
    if (!dot) return;
    await api.delete(`/air/dots/${dot.id}`).catch(() => undefined);
    setOpenId(null);
    setRail(false);
    await loadDots();
  }

  async function create() {
    setError(null);
    if (making === "dot") {
      try {
        const res = await api.post<{ dot: AirDot }>("/air/dots", {
          name: form.name.trim() || "New dot",
          instructions: form.instructions.trim() || "Stay on what I ask until it is done.",
          face: form.face,
          color: form.color,
          motion: form.motion,
        });
        setDots((all) => [...(all ?? []), res.dot]);
        setOpenId(res.dot.id);
        setGroupId(null);
      } catch (err) {
        setError(errorText(err, "Couldn't make that dot."));
        return;
      }
    } else if (making === "group") {
      const created: Group = { id: crypto.randomUUID(), name: form.name.trim() || "Team", memberIds: form.members };
      setGroups((all) => [...all, created]);
      setGroupId(created.id);
      setOpenId(null);
      setTeamNotes([]);
    }
    setMaking(null);
    setForm({ name: "", instructions: "", face: "clover" as Face, color: "#8eb7e8", motion: "working", members: [] });
  }

  /** A group: every member takes the same ask as its own job; each one's answer lands here as it finishes. */
  async function teamSay() {
    const text = draft.trim();
    if (!group || !text || teamWorking || !members.length) return;
    setDraft("");
    setTeamWorking(true);
    setTeamNotes((all) => [...all, { id: crypto.randomUUID(), from: "you", text }]);
    await Promise.all(members.map((m) => api.post("/air/jobs", { conversationId: m.conversation_id, task: text }).catch(() => undefined)));
    const pending = new Set(members.map((m) => m.id));
    const started = Date.now();
    while (pending.size && Date.now() - started < 10 * 60_000) {
      await new Promise((r) => setTimeout(r, 3000));
      for (const m of members) {
        if (!pending.has(m.id)) continue;
        const res = await api.get<{ job: Job | null }>(`/air/jobs/${m.conversation_id}`).catch(() => ({ job: null }));
        if (res.job && res.job.status !== "running") {
          pending.delete(m.id);
          const msgs = await api.get<{ messages: Message[] }>(`/chat/conversations/${m.conversation_id}/messages`).catch(() => ({ messages: [] as Message[] }));
          const reply = [...msgs.messages].reverse().find((x) => x.role === "assistant")?.content ?? res.job.summary ?? STATUS_LABEL[res.job.status];
          const note = { id: crypto.randomUUID(), from: m.id, text: reply };
          setTeamNotes((all) => [...all, note]);
          setArriving(note.id);
        }
      }
    }
    setTeamWorking(false);
  }

  function dragWidth(event: ReactPointerEvent, start: number, set: (n: number) => void, min: number, max: number) {
    event.preventDefault();
    const origin = event.clientX;
    const move = (ev: PointerEvent) => set(Math.min(max, Math.max(min, start + origin - ev.clientX)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function who(id: string) {
    if (id === "you") return "You";
    return dots?.find((item) => item.id === id)?.name ?? "Dot";
  }

  const notes: Note[] = messages.map((m) => ({ id: m.id, from: m.role === "user" ? "you" : dot?.id ?? "dot", text: m.error ? `${m.content}\n\n${m.error}`.trim() : m.content }));
  const needsYou = job?.status === "needs_approval" || job?.status === "needs_login";

  if (locked) {
    return (
      <div className="air-stage grid h-dvh place-items-center p-6" style={{ background: bg, color: ink }}>
        <style>{AIR_MOTION}</style>
        <div className="air-in max-w-md text-center">
          <Mark face={"clover" as Face} color="#8eb7e8" size={96} />
          <h1 className="mt-4 text-3xl font-medium tracking-tight">Air Dots is on Pro and Premium</h1>
          <p className="mt-2 text-sm" style={{ color: muted }}>A dot keeps working on its own computer, brings the result back, calls you when it's done, and waits for your yes before it pays, sends or deletes.</p>
          <a href="/upgrade" className="mt-6 inline-flex h-10 items-center rounded-full px-4 text-sm" style={{ background: ink, color: bg }}>See plans</a>
        </div>
      </div>
    );
  }

  return (
    <div className={narrow ? "air-stage flex h-dvh gap-2 p-2" : "air-stage flex h-dvh gap-3 p-3"} style={{ background: bg, color: ink, fontFamily: "var(--font-sans)" }}>
      <style>{AIR_MOTION}</style>
      {narrow && nav && <button type="button" aria-label="Close the list" className="fixed inset-0 z-30 bg-black/40" onClick={() => setNav(false)} />}
      <aside
        className={narrow ? (nav ? "fixed inset-y-2 left-2 z-40 flex w-[260px] flex-col rounded-2xl px-2 py-3" : "hidden") : "flex shrink-0 flex-col rounded-2xl px-2 py-3 transition-[width] duration-300"}
        style={{ width: narrow ? undefined : nav ? 220 : 76, background: panelBg, boxShadow: narrow ? "0 16px 40px rgba(0,0,0,.35)" : card }}
        onClick={(e) => { if (narrow && (e.target as HTMLElement).closest("button[data-pick]")) setNav(false); }}
      >
        <div className={nav ? "flex items-center justify-between px-1" : "flex flex-col items-center gap-2"}>
          {nav && (
            <a href="/" className="flex items-center gap-1 text-[14px]" title="Back to Friday">
              <ArrowLeft className="size-3.5" /> Air Dots
            </a>
          )}
          <button type="button" aria-label={nav ? "Close sidebar" : "Open sidebar"} className="grid size-8 place-items-center rounded-full text-[16px]" style={{ color: muted }} onClick={() => setNav((open) => !open)}>{nav ? "‹" : "›"}</button>
          {nav && (
            <button type="button" aria-label={dark ? "Use light theme" : "Use dark theme"} className="grid size-8 place-items-center rounded-full" onClick={() => setTheme(dark ? "light" : "dark")}>
              {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </button>
          )}
        </div>
        <button type="button" aria-label="New dot" className={nav ? "mt-3 flex h-10 items-center gap-2 rounded-2xl px-2 text-[14px]" : "mt-3 grid size-10 place-items-center self-center rounded-full"} style={{ background: soft }} onClick={() => setMaking("dot")}>
          <Plus className="size-3.5" />{nav && "New dot"}
        </button>
        <div className="mt-4 grid gap-1 overflow-y-auto">
          {(dots ?? []).map((item) => {
            const state = badges[item.id];
            const needs = state === "needs_approval" || state === "needs_login";
            return (
              <button key={item.id} data-pick type="button" className={nav ? "relative flex items-center gap-2 rounded-2xl px-1 py-1 text-left text-[14px]" : "relative grid size-12 place-items-center self-center rounded-2xl"} style={{ background: openId === item.id ? soft : "transparent" }} onClick={() => { setOpenId(item.id); setGroupId(null); setMaking(null); setCall(false); setRail(false); }}>
                <span className="relative">
                  <Mark face={item.face as Face} color={item.color} size={40} state={state === "running" ? "working" : "default"} />
                  {needs && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-medium" style={{ background: item.color, color: "#1c1b19" }}>!</span>}
                </span>
                {nav && (
                  <span className="min-w-0">
                    <span className="block truncate">{item.name}</span>
                    {state && state !== "done" && state !== "stopped" && <span className="block truncate text-[11px]" style={{ color: muted }}>{STATUS_LABEL[state]}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {nav && (
          <>
            <p className="mt-5 px-2 text-[12px]" style={{ color: muted }}>Groups</p>
            <div className="mt-1 grid gap-1">
              {groups.map((g) => (
                <button key={g.id} type="button" className="rounded-2xl px-2 py-1.5 text-left text-[14px]" style={{ background: groupId === g.id ? soft : "transparent" }} onClick={() => { setGroupId(g.id); setOpenId(null); setMaking(null); setTeamNotes([]); }}>{g.name}</button>
              ))}
              <button type="button" className="rounded-2xl px-2 py-1.5 text-left text-[13px]" style={{ color: muted }} onClick={() => setMaking("group")}>+ New group</button>
            </div>
          </>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {narrow && !nav && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <button type="button" aria-label="Open the list of dots" className="grid size-9 place-items-center rounded-full" style={{ background: panelBg }} onClick={() => setNav(true)}>☰</button>
            <p className="truncate text-sm">{dot?.name ?? group?.name ?? "Air Dots"}</p>
          </div>
        )}
        {error && (
          <div className="air-in mb-2 flex items-center justify-between rounded-2xl px-4 py-2 text-sm" style={{ background: dark ? "#3a1d1d" : "#fdecec", color: dark ? "#f6caca" : "#8a1f1f" }}>
            {error}
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)}><X className="size-3.5" /></button>
          </div>
        )}

        {making && (
          <div className="mx-auto w-full max-w-xl overflow-y-auto px-8 py-10">
            <h1 className="text-3xl font-medium tracking-tight">{making === "dot" ? "Make a dot" : "Make a group"}</h1>
            <label className="mt-6 block text-xs" style={{ color: muted }}>Name</label>
            <input value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 h-11 w-full rounded-2xl border bg-transparent px-3 text-sm outline-none" style={{ borderColor: line }} />
            {making === "dot" && (
              <>
                <label className="mt-4 block text-xs" style={{ color: muted }}>Standing instructions</label>
                <textarea value={form.instructions} maxLength={2000} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Watch my mail. Bring me only what needs a reply." className="mt-1 h-24 w-full rounded-2xl border bg-transparent px-3 py-2 text-sm outline-none" style={{ borderColor: line }} />
                <p className="mt-4 text-xs" style={{ color: muted }}>Mascot</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {PALETTE.map((look) => (
                    <button key={look.face} type="button" className="rounded-2xl p-1" style={{ outline: form.face === look.face ? `2px solid ${look.color}` : "2px solid transparent" }} onClick={() => setForm({ ...form, face: look.face, color: look.color })}>
                      <Mark face={look.face} color={look.color} size={64} />
                    </button>
                  ))}
                </div>
                <p className="mt-4 text-xs" style={{ color: muted }}>Animation while it works</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {MOTIONS.map((motion) => (
                    <button key={motion} type="button" className="rounded-full border px-3 py-1 text-xs capitalize" style={{ borderColor: form.motion === motion ? ink : line }} onClick={() => setForm({ ...form, motion })}>{motion}</button>
                  ))}
                </div>
                <div className="mt-4"><ThinkingOrb state={form.motion} size={64} theme={theme} /></div>
                <p className="mt-4 text-xs" style={{ color: muted }}>Same Friday, same memory and usage — a dot is a named thread with its own instructions.</p>
              </>
            )}
            {making === "group" && (
              <div className="mt-4 grid gap-2">
                {(dots ?? []).map((item) => {
                  const on = form.members.includes(item.id);
                  return (
                    <button key={item.id} type="button" className="flex items-center gap-2 rounded-2xl border px-3 py-2 text-left text-sm" style={{ borderColor: on ? ink : line }} onClick={() => setForm({ ...form, members: on ? form.members.filter((id) => id !== item.id) : [...form.members, item.id] })}>
                      <Mark face={item.face as Face} color={item.color} size={36} /> {item.name}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="mt-6 flex gap-2">
              <button type="button" className="h-10 rounded-full px-4 text-sm" style={{ background: ink, color: bg }} onClick={() => void create()}>Create</button>
              <button type="button" className="h-10 rounded-full border px-4 text-sm" style={{ borderColor: line }} onClick={() => setMaking(null)}>Cancel</button>
            </div>
          </div>
        )}

        {!making && !dot && !group && (
          <div className="flex flex-1 flex-col items-center justify-center px-6">
            <h1 className="air-in text-5xl font-medium tracking-tight">Your dots</h1>
            <p className="mt-3 max-w-md text-center text-sm" style={{ color: muted }}>A dot keeps working on its own computer, brings the result back, and waits for your yes when the action leaves your account.</p>
            {featured && (
              <div className="air-in mt-6 w-full max-w-md rounded-2xl border p-4" style={{ borderColor: line, background: panelBg }}>
                <p className="text-sm font-medium">{featured.title}</p>
                <p className="mt-1 line-clamp-3 text-sm" style={{ color: muted }}>{featured.body}</p>
                {featured.ctaUrl && <a href={featured.ctaUrl} className="mt-2 inline-block text-sm underline">{featured.ctaLabel || "Open"}</a>}
              </div>
            )}
            <div className="mt-8 flex max-w-3xl flex-wrap justify-center gap-2">
              {STARTERS.map((text) => (
                <button key={text} type="button" className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: line }} onClick={() => { const first = dots?.[0]; if (!first) return; setOpenId(first.id); void send(text, first); }}>{text}</button>
              ))}
            </div>
            <div className="mt-10 flex flex-wrap justify-center gap-8">
              {dots === null && <ThinkingOrb state="breathing" size={64} theme={theme} />}
              {(dots ?? []).map((item) => (
                <button key={item.id} type="button" className="flex w-28 flex-col items-center gap-3" onClick={() => setOpenId(item.id)}>
                  <Mark face={item.face as Face} color={item.color} size={112} state={badges[item.id] === "running" ? "working" : "default"} />
                  <span className="text-sm" style={{ color: muted }}>{item.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!making && group && (
          <Thread
            title={group.name}
            subtitle="Each member takes the ask as its own job; their answers land here as they finish."
            faces={members}
            notes={teamNotes}
            who={who}
            arriving={arriving}
            draft={draft}
            setDraft={setDraft}
            onSend={() => void teamSay()}
            working={teamWorking}
            motion={step.motion}
            status={step.label}
            theme={theme}
            ink={ink}
            muted={muted}
            line={line}
            youBg={youBg}
            youInk={youInk}
            replyBg={replyBg}
            panelBg={panelBg}
          />
        )}

        {!making && dot && (
          <div className="relative flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col rounded-2xl" style={{ background: panelBg, boxShadow: card }} onClick={() => { setRail(false); }}>
              <div className="flex items-center justify-between px-4 pt-3">
                <button type="button" aria-label="Open the computer" className="grid size-9 place-items-center rounded-full" style={{ background: screen ? soft : "transparent" }} onClick={(event) => { event.stopPropagation(); setScreen((open) => !open); }}>
                  <Monitor className="size-4" />
                </button>
                <p className="text-[12px]" style={{ color: muted }}>{job ? STATUS_LABEL[job.status] : "Ready"}</p>
                <button type="button" aria-label={`Call ${dot.name}`} className="air-call grid size-9 place-items-center rounded-full" style={{ background: ink, color: bg }} onClick={(event) => { event.stopPropagation(); setCall(true); }}>
                  <Phone className="size-4" />
                </button>
              </div>
              <div className={narrow ? "flex-1 space-y-3 overflow-y-auto px-3 py-2" : "flex-1 space-y-3 overflow-y-auto px-6 py-2"}>
                <div key={dot.id} className="air-pop flex justify-center pb-2 pt-1">
                  <button type="button" aria-label={`Open ${dot.name}`} className="rounded-full" onClick={(event) => { event.stopPropagation(); setRail(true); void refreshSide(dot); }}>
                    <Mark face={dot.face as Face} color={dot.color} size={88} state={working ? "working" : "default"} />
                  </button>
                </div>
                {notes.length === 0 && !working && <p className="text-center text-sm" style={{ color: muted }}>{dot.instructions || "Tell it what to take care of."}</p>}
                {notes.map((note) => (
                  <Bubble key={note.id} mine={note.from === "you"} label={who(note.from)} text={note.text} youBg={youBg} youInk={youInk} replyBg={replyBg} ink={ink} muted={muted} live={arriving === note.id} />
                ))}
                {working && <ThinkRow motion={step.motion} label={step.label} theme={theme} muted={muted} />}
                {needsYou && job && (
                  <NeedsYou job={job} ink={ink} bg={bg} muted={muted} line={line} onApprove={(p) => void approve(p)} onHold={() => void hold()} onOpenScreen={() => setScreen(true)} onSignedIn={() => void signedIn()} />
                )}
              </div>
              <Composer draft={draft} setDraft={setDraft} onSend={() => void send(draft)} theme={theme} line={line} placeholder={working ? "Say rukho to stop" : `Message ${dot.name}`} working={working} />
              {call && <CallCard narrow={narrow} dot={dot} theme={theme} panelBg={panelBg} line={line} muted={muted} onClose={() => setCall(false)} />}
            </div>
            {screen && !narrow && (
              <>
                <div role="separator" aria-label="Resize the computer" className="mx-1 w-1.5 shrink-0 cursor-col-resize self-stretch rounded-full" style={{ background: line }} onPointerDown={(event) => dragWidth(event, screenW, setScreenW, 320, 900)} />
                <LiveScreen dot={dot} width={screenW} working={working} onClose={() => setScreen(false)} onTakeOver={() => void hold()} onGiveBack={() => void signedIn()} />
              </>
            )}
            {screen && narrow && (
              <div className="fixed inset-0 z-40 flex p-2" style={{ background: bg }}>
                <LiveScreen dot={dot} width="100%" working={working} onClose={() => setScreen(false)} onTakeOver={() => void hold()} onGiveBack={() => void signedIn()} />
              </div>
            )}
            {rail && (
              <aside className="air-in absolute right-4 top-1/2 z-20 flex max-h-[480px] -translate-y-1/2 flex-col overflow-hidden rounded-3xl" style={{ width: narrow ? "calc(100% - 16px)" : railW, right: narrow ? 8 : undefined, background: panelBg, boxShadow: "0 16px 40px rgba(0,0,0,.12)" }} onClick={(event) => event.stopPropagation()}>
                <div role="separator" aria-label="Resize the side pane" className="absolute inset-y-6 left-0 w-1.5 cursor-col-resize" onPointerDown={(event) => dragWidth(event, railW, setRailW, 220, 440)} />
                <div className="flex items-center gap-1 px-3 pt-3">
                  <button type="button" className="h-8 rounded-full px-3 text-[13px]" style={{ background: panel === "work" ? soft : "transparent" }} onClick={() => setPanel("work")}>Work</button>
                  <button type="button" className="grid size-8 place-items-center rounded-full" style={{ background: panel === "settings" ? soft : "transparent" }} onClick={() => setPanel("settings")} aria-label="Settings"><Settings className="size-4" /></button>
                  <button type="button" aria-label="Close" className="ml-auto grid size-8 place-items-center rounded-full" onClick={() => setRail(false)}><X className="size-4" /></button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {panel === "work" ? (
                    <WorkPane jobs={jobs} actions={actions} muted={muted} line={line} />
                  ) : (
                    <DotSettings dot={dot} theme={theme} ink={ink} muted={muted} line={line} onSave={(next) => void saveDot(next)} onDelete={() => void removeDot()} onError={setError} />
                  )}
                </div>
              </aside>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function NeedsYou({ job, ink, bg, muted, line, onApprove, onHold, onOpenScreen, onSignedIn }: {
  job: Job; ink: string; bg: string; muted: string; line: string;
  onApprove: (passphrase: string) => void; onHold: () => void; onOpenScreen: () => void; onSignedIn: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  if (job.status === "needs_login") {
    return (
      <div className="air-in rounded-2xl border p-4" style={{ borderColor: line }}>
        <p className="text-sm font-medium">Needs you to sign in</p>
        <p className="mt-1 text-sm" style={{ color: muted }}>{job.needs || job.summary || "A site wants a login."} Sign in on the computer — never paste a password into chat.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="h-9 rounded-full px-3 text-sm" style={{ background: ink, color: bg }} onClick={onOpenScreen}>Open the computer</button>
          <button type="button" className="h-9 rounded-full border px-3 text-sm" style={{ borderColor: line }} onClick={onSignedIn}>I've signed in — carry on</button>
        </div>
      </div>
    );
  }
  return (
    <form className="air-in rounded-2xl border p-4" style={{ borderColor: line }} onSubmit={(e) => { e.preventDefault(); onApprove(phrase); setPhrase(""); }}>
      <p className="text-sm font-medium">Waiting for your yes</p>
      <p className="mt-1 text-sm" style={{ color: muted }}>{job.needs || job.summary || "The next step leaves your account."}</p>
      <input value={phrase} onChange={(e) => setPhrase(e.target.value)} type="password" autoComplete="off" placeholder="Passphrase (if you set one)" className="mt-3 h-9 w-full rounded-full border bg-transparent px-3 text-sm outline-none" style={{ borderColor: line }} />
      <div className="mt-3 flex gap-2">
        <button type="submit" className="h-9 rounded-full px-3 text-sm" style={{ background: ink, color: bg }}>Yes, do it</button>
        <button type="button" className="h-9 rounded-full border px-3 text-sm" style={{ borderColor: line }} onClick={onHold}>Hold</button>
      </div>
    </form>
  );
}

function WorkPane({ jobs, actions, muted, line }: { jobs: Job[]; actions: Action[]; muted: string; line: string }) {
  return (
    <div className="air-in min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
      <p className="text-[13px]" style={{ color: muted }}>Jobs</p>
      {jobs.length === 0 && <p className="text-sm" style={{ color: muted }}>Nothing yet. Ask it for something.</p>}
      {jobs.map((j) => (
        <div key={j.id} className="rounded-2xl border p-3" style={{ borderColor: line }}>
          <p className="line-clamp-2 text-sm">{j.task}</p>
          <p className="mt-1 text-xs" style={{ color: muted }}>{STATUS_LABEL[j.status]}{j.rounds ? ` · ${j.rounds} turn${j.rounds === 1 ? "" : "s"}` : ""}</p>
          {j.summary && <p className="mt-1 line-clamp-3 text-xs" style={{ color: muted }}>{j.summary}</p>}
        </div>
      ))}
      <p className="text-[13px]" style={{ color: muted }}>Rules</p>
      <ul className="space-y-1 text-sm">
        <li>Reads, searches and drafts: <span style={{ color: muted }}>on its own</span></li>
        <li>Pay, buy, book, send, post, delete: <span style={{ color: muted }}>asks you first</span></li>
        <li>Passwords and sign-ins: <span style={{ color: muted }}>only you, on the computer</span></li>
      </ul>
      <p className="text-[13px]" style={{ color: muted }}>What it did</p>
      {actions.length === 0 && <p className="text-sm" style={{ color: muted }}>No actions yet.</p>}
      <ul className="space-y-1.5">
        {actions.slice(0, 25).map((a) => (
          <li key={a.id} className="text-xs">
            <span className="capitalize">{a.kind}</span> · <span style={{ color: a.decision === "refused" ? "#d97757" : muted }}>{a.decision}</span>
            <span className="block truncate" style={{ color: muted }}>{a.name === "person" ? "You: " : ""}{a.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type PhoneSettings = { channels: string[]; callback: boolean; quietStart: string | null; quietEnd: string | null; language: string };

function DotSettings({ dot, theme, ink, muted, line, onSave, onDelete, onError }: {
  dot: AirDot; theme: Theme; ink: string; muted: string; line: string;
  onSave: (next: Partial<AirDot>) => void; onDelete: () => void; onError: (message: string) => void;
}) {
  const [name, setName] = useState(dot.name);
  const [instructions, setInstructions] = useState(dot.instructions);
  const [phone, setPhone] = useState<PhoneSettings | null>(null);
  const [when, setWhen] = useState("09:00");
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [channels, setChannels] = useState<{ channel: string }[]>([]);
  const [telegramLink, setTelegramLink] = useState<string | null>(null);
  const [passSet, setPassSet] = useState<boolean | null>(null);
  const [current, setCurrent] = useState("");
  const [nextPhrase, setNextPhrase] = useState("");

  useEffect(() => {
    setName(dot.name);
    setInstructions(dot.instructions);
  }, [dot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void api.get<PhoneSettings>("/phone/settings").then(setPhone).catch(() => setPhone(null));
    void api.get<{ channels: { channel: string }[]; telegramLink: string | null }>("/air/channels").then((r) => { setChannels(r.channels); setTelegramLink(r.telegramLink); }).catch(() => undefined);
    void api.get<{ set: boolean }>("/air/passphrase").then((r) => setPassSet(r.set)).catch(() => undefined);
  }, []);

  async function savePhone(next: Partial<PhoneSettings>) {
    if (!phone) return;
    const merged = { ...phone, ...next };
    setPhone(merged);
    await api.put("/phone/settings", merged).catch((err: unknown) => onError(errorText(err, "Couldn't save.")));
  }

  async function schedule() {
    try {
      await api.post("/automations", {
        title: `${dot.name}: weekday check`,
        prompt: instructions || `Check in as ${dot.name}.`,
        frequency: "weekdays",
        timeOfDay: when,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      setScheduled(`Every weekday at ${when}. It's in Automations.`);
    } catch (err) {
      onError(errorText(err, "Couldn't schedule that."));
    }
  }

  async function savePassphrase() {
    try {
      await api.put("/air/passphrase", { phrase: nextPhrase, ...(passSet ? { current } : {}) });
      setPassSet(true);
      setCurrent("");
      setNextPhrase("");
    } catch (err) {
      onError(errorText(err, "Couldn't save that passphrase."));
    }
  }

  const linked = (c: string) => channels.some((x) => x.channel === c);

  return (
    <div key="settings" className="air-in min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
      <label className="block text-xs" style={{ color: muted }}>Name</label>
      <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={() => name !== dot.name && onSave({ name })} className="h-10 w-full rounded-2xl border bg-transparent px-3 text-sm outline-none" style={{ borderColor: line }} />
      <label className="block text-xs" style={{ color: muted }}>Standing instructions</label>
      <textarea value={instructions} maxLength={2000} onChange={(e) => setInstructions(e.target.value)} onBlur={() => instructions !== dot.instructions && onSave({ instructions })} className="h-24 w-full rounded-2xl border bg-transparent px-3 py-2 text-sm outline-none" style={{ borderColor: line }} />
      <p className="text-xs" style={{ color: muted }}>Mascot</p>
      <div className="flex flex-wrap gap-1">
        {PALETTE.map((look) => (
          <button key={look.face} type="button" className="rounded-xl p-0.5" style={{ outline: dot.face === look.face ? `2px solid ${look.color}` : "2px solid transparent" }} onClick={() => onSave({ face: look.face, color: look.color })}>
            <Mark face={look.face} color={look.color} size={52} paused />
          </button>
        ))}
      </div>
      <p className="text-xs" style={{ color: muted }}>Animation</p>
      <div className="flex flex-wrap gap-1">
        {MOTIONS.map((motion) => (
          <button key={motion} type="button" className="rounded-full border px-2 py-1 text-[11px] capitalize" style={{ borderColor: dot.motion === motion ? ink : line }} onClick={() => onSave({ motion })}>{motion}</button>
        ))}
      </div>
      <div className="flex justify-center py-1"><ThinkingOrb state={dot.motion as Motion} size={64} theme={theme} /></div>

      <p className="pt-2 text-[13px]" style={{ color: muted }}>Calls and updates (all dots)</p>
      {phone ? (
        <>
          <label className="flex items-center justify-between text-sm">
            Call me back when a job is done
            <input type="checkbox" checked={phone.callback} onChange={(e) => void savePhone({ callback: e.target.checked })} />
          </label>
          <div className="flex items-center gap-2 text-sm">
            Quiet hours
            <input type="time" value={phone.quietStart ?? ""} onChange={(e) => void savePhone({ quietStart: e.target.value || null })} className="h-8 rounded-xl border bg-transparent px-2 text-xs" style={{ borderColor: line }} />
            –
            <input type="time" value={phone.quietEnd ?? ""} onChange={(e) => void savePhone({ quietEnd: e.target.value || null })} className="h-8 rounded-xl border bg-transparent px-2 text-xs" style={{ borderColor: line }} />
          </div>
        </>
      ) : (
        <p className="text-xs" style={{ color: muted }}>Loading…</p>
      )}
      <div className="text-sm">
        Telegram: {linked("telegram") ? <span style={{ color: muted }}>linked</span> : telegramLink ? <a href={telegramLink} target="_blank" rel="noreferrer" className="underline">link it</a> : <span style={{ color: muted }}>not set up yet</span>}
      </div>
      <div className="text-sm">
        WhatsApp: <span style={{ color: muted }}>{linked("whatsapp") ? "linked" : "message Friday's number from the mobile on your account"}</span>
      </div>

      <p className="pt-2 text-[13px]" style={{ color: muted }}>Passphrase before pay, send or delete</p>
      {passSet && <input value={current} onChange={(e) => setCurrent(e.target.value)} type="password" autoComplete="off" placeholder="Current passphrase" className="h-9 w-full rounded-full border bg-transparent px-3 text-sm outline-none" style={{ borderColor: line }} />}
      <div className="flex gap-2">
        <input value={nextPhrase} onChange={(e) => setNextPhrase(e.target.value)} type="password" autoComplete="off" placeholder={passSet ? "New passphrase" : "Set a passphrase"} className="h-9 min-w-0 flex-1 rounded-full border bg-transparent px-3 text-sm outline-none" style={{ borderColor: line }} />
        <button type="button" disabled={nextPhrase.trim().length < 4} className="h-9 rounded-full border px-3 text-xs disabled:opacity-50" style={{ borderColor: line }} onClick={() => void savePassphrase()}>Save</button>
      </div>
      <p className="text-[11px]" style={{ color: muted }}>On a call you can also say "my passcode is …".</p>

      <p className="pt-2 text-[13px]" style={{ color: muted }}>Schedule</p>
      <div className="flex items-center gap-2">
        <input type="time" value={when} onChange={(e) => setWhen(e.target.value)} className="h-9 rounded-2xl border bg-transparent px-3 text-sm" style={{ borderColor: line }} />
        <button type="button" className="h-9 rounded-full border px-3 text-xs" style={{ borderColor: line }} onClick={() => void schedule()}>Every weekday</button>
      </div>
      {scheduled && <p className="text-xs" style={{ color: muted }}>{scheduled}</p>}

      <button type="button" className="mt-4 flex items-center gap-1 text-xs" style={{ color: "#d97757" }} onClick={onDelete}>
        <Trash2 className="size-3.5" /> Remove this dot (the chat stays in your history)
      </button>
    </div>
  );
}

/** The real call: Friday rings the verified mobile, or this browser is the line. Minutes count either way. */
function CallCard({ narrow, dot, theme, panelBg, line, muted, onClose }: { narrow?: boolean; dot: AirDot; theme: Theme; panelBg: string; line: string; muted: string; onClose: () => void }) {
  const mic = useMicrophone();
  const [callId, setCallId] = useState<string | null>(null);
  const [mode, setMode] = useState<"phone" | "browser" | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    api
      .post<{ id: string; dial?: { mode?: "browser" | "phone" }; allowance?: { left: number } }>("/air/calls", { conversationId: dot.conversation_id })
      .then((res) => {
        if (gone) return;
        setCallId(res.id);
        setMode(res.dial?.mode === "phone" ? "phone" : "browser");
        setLeft(res.allowance?.left ?? null);
      })
      .catch((err: unknown) => !gone && setError(errorText(err, "Couldn't start the call.")));
    return () => {
      gone = true;
    };
  }, [dot.conversation_id]);

  // The browser line bills as it runs; a phone call is billed by the carrier when it ends.
  useEffect(() => {
    if (!callId || mode !== "browser") return;
    const id = window.setInterval(() => {
      void api
        .post<{ left: number }>(`/air/calls/${callId}/tick`, { seconds: 15 })
        .then((res) => setLeft(res.left))
        .catch((err: unknown) => {
          setError(errorText(err, "This month's call minutes are used up."));
          window.clearInterval(id);
        });
    }, 15_000);
    return () => window.clearInterval(id);
  }, [callId, mode]);

  async function hangUp() {
    mic.stop();
    if (callId && mode === "browser") await api.post(`/air/calls/${callId}/end`, {}).catch(() => undefined);
    onClose();
  }

  return (
    <div className={narrow ? "air-in absolute inset-x-2 top-14 z-30" : "air-in absolute right-8 top-16 z-30 w-80"} onClick={(event) => event.stopPropagation()}>
      <VoiceBeam type="pill" theme={theme} look="glow" colorVariant="gold" stream={mic.stream}>
        <div className="rounded-3xl border p-4" style={{ background: panelBg, borderColor: line }}>
          <div className="flex items-center gap-2">
            <Mark face={dot.face as Face} color={dot.color} size={56} state="working" />
            <div>
              <p className="text-sm">{dot.name} · On Air</p>
              <p className="text-xs" style={{ color: muted }}>
                {error ?? (mode === "phone" ? "Calling the mobile on your account…" : mode === "browser" ? "On the line in this browser" : "Connecting…")}
              </p>
            </div>
          </div>
          {left != null && <p className="mt-2 text-xs" style={{ color: muted }}>{left} call minute{left === 1 ? "" : "s"} left this month</p>}
          <div className="mt-4 flex gap-2">
            {mode === "browser" && !error && (
              <button type="button" className="h-10 rounded-full border px-4 text-sm" style={{ borderColor: line }} onClick={() => (mic.state === "live" ? mic.stop() : void mic.start())}>
                {mic.state === "live" ? "Mute" : "Talk"}
              </button>
            )}
            <button type="button" className="h-10 rounded-full bg-red-600 px-4 text-sm text-white" onClick={() => void hangUp()}>{mode === "phone" ? "Close" : "Hang up"}</button>
          </div>
        </div>
      </VoiceBeam>
    </div>
  );
}

/** The dot's computer, live: what its browser shows, and the person's own mouse/finger/keys on it. */
function LiveScreen({ dot, width, working, onClose, onTakeOver, onGiveBack }: { dot: AirDot; width: number | string; working: boolean; onClose: () => void; onTakeOver: () => void; onGiveBack: () => void }) {
  const [shot, setShot] = useState<Screen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [typing, setTyping] = useState("");
  const [control, setControl] = useState<"dot" | "you">("dot");
  const [dropped, setDropped] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await api.get<Screen>(`/air/screen/${dot.conversation_id}`);
      setShot(res);
      setError(null);
      if (res.mode === "browser" && res.url) setUrl((u) => (document.activeElement?.id === "air-url" ? u : res.url ?? u));
    } catch (err) {
      setError(errorText(err, "The computer isn't reachable."));
    } finally {
      busy.current = false;
    }
  }, [dot.conversation_id]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), working || control === "you" ? 1500 : 5000);
    return () => window.clearInterval(id);
  }, [load, working, control]);

  async function input(body: Record<string, unknown>) {
    try {
      const res = await api.post<Screen>(`/air/screen/${dot.conversation_id}/input`, body);
      setShot(res);
    } catch (err) {
      setError(errorText(err, "That didn't reach the computer."));
    }
  }

  return (
    <div className="air-in flex min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl bg-white text-neutral-950" style={{ width }}>
      <div className="flex items-center gap-2 border-b border-black/10 px-3 py-2">
        <span className="size-2 rounded-full bg-red-400" />
        <span className="size-2 rounded-full bg-amber-300" />
        <span className="size-2 rounded-full bg-green-400" />
        <form className="ml-1 min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void input({ type: "open", url: /^https?:\/\//.test(url) ? url : `https://${url}` }); }}>
          <input id="air-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`${dot.name}'s computer`} className="h-7 w-full rounded-full bg-black/5 px-3 text-[12px] outline-none" />
        </form>
        <button type="button" className="h-7 rounded-full bg-[#1c1b19] px-2.5 text-[12px] text-white" onClick={() => {
          if (control === "dot") { setControl("you"); onTakeOver(); } else { setControl("dot"); onGiveBack(); }
        }}>{control === "dot" ? "Take over" : "Give it back"}</button>
        <button type="button" aria-label="Close the computer" className="grid size-7 place-items-center rounded-full" onClick={onClose}><X className="size-3.5" /></button>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-auto bg-[#f7f8fa]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (!file || file.size > 200_000) return setError("Drop a text file under 200 KB.");
          void file.text().then((content) => api.post<{ name: string }>(`/air/screen/${dot.conversation_id}/drop`, { name: file.name, content }).then((r) => setDropped(r.name)).catch((err: unknown) => setError(errorText(err, "Couldn't add that file."))));
        }}
      >
        {shot?.mode === "browser" ? (
          <img
            alt={shot.title ?? "The dot's browser"}
            src={`data:image/jpeg;base64,${shot.image}`}
            className="block w-full cursor-crosshair select-none"
            draggable={false}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - box.left) / box.width) * shot.width;
              const y = ((e.clientY - box.top) / box.height) * shot.height;
              void input({ type: "click", x, y });
            }}
            onWheel={(e) => void input({ type: "scroll", direction: e.deltaY < 0 ? "up" : "down" })}
          />
        ) : shot?.mode === "preview" && shot.preview ? (
          <iframe title={`${dot.name}'s app`} src={shot.preview} className="h-full min-h-[420px] w-full" />
        ) : (
          <div className="grid h-full min-h-[320px] place-items-center p-6 text-center text-sm text-black/55">
            {error ?? (shot ? "Nothing open yet. Type a site above, or ask the dot to use the browser." : "Waking the computer…")}
          </div>
        )}
        {dropped && <p className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-white/90 px-2 py-1 text-[11px] text-black/60">Added {dropped}</p>}
      </div>
      {shot?.mode === "browser" && (
        <form className="flex gap-2 border-t border-black/10 p-2" onSubmit={(e) => { e.preventDefault(); if (typing) { void input({ type: "type", text: typing }); setTyping(""); } }}>
          <input value={typing} onChange={(e) => setTyping(e.target.value)} placeholder="Type into the page (logins happen here, never in chat)" type="text" autoComplete="off" className="h-8 min-w-0 flex-1 rounded-full bg-black/5 px-3 text-[12px] outline-none" />
          <button type="button" className="h-8 rounded-full bg-black/5 px-2 text-[12px]" onClick={() => void input({ type: "key", key: "Enter" })}>Enter</button>
          <button type="button" className="h-8 rounded-full bg-black/5 px-2 text-[12px]" onClick={() => void input({ type: "back" })}>Back</button>
        </form>
      )}
    </div>
  );
}

function Mark({ face, color, size, state = "default", paused }: { face: Face; color: string; size: number; state?: "default" | "working" | "sleeping"; paused?: boolean }) {
  return <BotAvatar type={face} color={color} size={size} state={state} face="mouth" paused={paused} shading="plastic" saturation={1.15} highlight={1.5} shadow={0.22} />;
}

function Bubble({ mine, label, text, youBg, youInk, replyBg, ink, muted, live }: { mine: boolean; label: string; text: string; youBg: string; youInk: string; replyBg: string; ink: string; muted: string; live?: boolean }) {
  const [shown, setShown] = useState(live ? "" : text);
  useEffect(() => {
    if (!live) {
      setShown(text);
      return;
    }
    let i = 0;
    const step = Math.max(1, Math.ceil(text.length / 240));
    const id = window.setInterval(() => {
      i += step;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, 16);
    return () => window.clearInterval(id);
  }, [live, text]);
  return (
    <div className={mine ? "air-in ml-auto w-fit max-w-xl" : "air-in max-w-xl"}>
      {!mine && <p className="mb-1 text-[11px]" style={{ color: muted }}>{label}</p>}
      <div className="whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-6" style={{ background: mine ? youBg : replyBg, color: mine ? youInk : ink }}>
        {shown}
        {live && shown.length < text.length && <span className="air-caret">|</span>}
      </div>
    </div>
  );
}

function ThinkRow({ motion, label, theme, muted }: { motion: Motion; label: string; theme: Theme; muted: string }) {
  return (
    <div className="air-in flex items-center gap-3">
      <ThinkingOrb state={motion} size={64} theme={theme} aria-label={label} />
      <p className="text-xs" style={{ color: muted }}>{label}</p>
    </div>
  );
}

function Composer({ draft, setDraft, onSend, theme, line, placeholder, working }: { draft: string; setDraft: (v: string) => void; onSend: () => void; theme: Theme; line: string; placeholder: string; working?: boolean }) {
  // While a job runs the composer stays open: "rukho" / "stop" must always be typeable.
  const field = (
    <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} className="h-12 w-full rounded-full border bg-transparent px-4 text-[15px] outline-none" style={{ borderColor: line }} />
  );
  return (
    <form className="px-4 pb-4" onSubmit={(e) => { e.preventDefault(); onSend(); }}>
      {working ? <BorderBeam size="md" colorVariant="gold" theme={theme} duration={2.4}>{field}</BorderBeam> : field}
    </form>
  );
}

function Thread({ title, subtitle, faces, notes, who, arriving, draft, setDraft, onSend, working, motion, status, theme, ink, muted, line, youBg, youInk, replyBg, panelBg }: {
  title: string; subtitle: string; faces: AirDot[]; notes: Note[]; who: (id: string) => string; arriving: string | null; draft: string; setDraft: (v: string) => void; onSend: () => void; working?: boolean; motion: Motion; status: string; theme: Theme; ink: string; muted: string; line: string; youBg: string; youInk: string; replyBg: string; panelBg: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b px-6 py-4" style={{ borderColor: line }}>
        <div className="flex items-center gap-2">
          {faces.map((item) => <Mark key={item.id} face={item.face as Face} color={item.color} size={48} />)}
        </div>
        <h1 className="mt-3 text-2xl font-medium tracking-tight" style={{ color: ink }}>{title}</h1>
        <p className="text-sm" style={{ color: muted }}>{subtitle}</p>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-6 py-6" style={{ background: panelBg }}>
        {notes.map((note) => <Bubble key={note.id} mine={note.from === "you"} label={who(note.from)} text={note.text} youBg={youBg} youInk={youInk} replyBg={replyBg} ink={ink} muted={muted} live={arriving === note.id} />)}
        {working && <ThinkRow motion={motion} label={status} theme={theme} muted={muted} />}
      </div>
      <Composer draft={draft} setDraft={setDraft} onSend={onSend} theme={theme} line={line} placeholder={`Message ${title}`} working={working} />
    </div>
  );
}
