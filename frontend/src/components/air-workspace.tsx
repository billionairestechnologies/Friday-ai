import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BotAvatar, type BotAvatarType } from "bot-avatars";
import { BorderBeam } from "border-beam";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { VoiceBeam } from "voice-glow";
import { Monitor, Moon, Phone, Plus, Settings, Sun, X } from "lucide-react";

type Theme = "dark" | "light";
type Face = BotAvatarType;
type Motion = OrbState;

const PALETTE: { face: Face; color: string }[] = [
  { face: "blob", color: "#8eb7e8" },
  { face: "cat", color: "#f0b4c8" },
  { face: "droid", color: "#c4b6e8" },
  { face: "ghost", color: "#b7d7c3" },
  { face: "star", color: "#efd3a0" },
  { face: "cloud", color: "#b9dce4" },
];
const MOTIONS: Motion[] = ["working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"];

type Note = { id: string; from: string; text: string };
type RuleMode = "allow" | "ask" | "block";
type Dot = {
  id: string;
  name: string;
  instructions: string;
  face: Face;
  color: string;
  motion: Motion;
  control: "dot" | "you";
  callback: boolean;
  when: string;
  machine: "cloud" | "yours";
  automations: { id: string; title: string; when: string }[];
  activity: string[];
  messages: Note[];
  tasks: { id: string; title: string; state: "running" | "needs-you" | "done" }[];
  outputs: { id: string; title: string; detail: string; status: "review" | "approved" | "held" }[];
  rules: { id: string; text: string; mode: RuleMode }[];
  apps: { name: string; access: "read" | "act" }[];
  learned: string[];
};
type Group = { id: string; name: string; memberIds: string[] };

const BASE_RULES: Dot["rules"] = [
  { id: "read", text: "Read connected apps in the background", mode: "allow" },
  { id: "send", text: "Send, pay, or delete", mode: "ask" },
  { id: "secret", text: "Passwords and sign-in stay with you", mode: "block" },
];
const BASE_APPS: Dot["apps"] = [
  { name: "Mail", access: "read" },
  { name: "Calendar", access: "read" },
  { name: "GitHub", access: "act" },
  { name: "Browser", access: "act" },
];
const USES: { title: string; dot: string; task: string; output: string; ask: boolean }[] = [
  { title: "Investigate a bug", dot: "code", task: "A bug showed up. Find the cause.", output: "Cause and a fix, ready to review", ask: true },
  { title: "Turn feedback into a fix", dot: "code", task: "Recurring feedback into a tested change", output: "A change with a short recording", ask: true },
  { title: "Revise the launch", dot: "research", task: "Scope changed. Revise the story.", output: "Updated launch draft", ask: true },
  { title: "Update the analysis", dot: "research", task: "New evidence. Rerun the figures.", output: "Figures and what changed", ask: false },
  { title: "Draft from a transcript", dot: "inbox", task: "Pull clips, notes, and posts", output: "Posts waiting for your voice", ask: true },
  { title: "Prepare the invoice", dot: "inbox", task: "An invoice was missed. Draft it.", output: "Invoice ready. Sending waits for you.", ask: true },
];

function powers(extra: Partial<Dot> & Pick<Dot, "id" | "name" | "instructions" | "face" | "color" | "motion">): Dot {
  return {
    control: "dot",
    callback: false,
    when: "09:00",
    machine: "cloud",
    ...extra,
    tasks: extra.tasks ?? [],
    outputs: extra.outputs ?? [],
    rules: extra.rules ?? BASE_RULES.map((rule) => ({ ...rule })),
    apps: extra.apps ?? BASE_APPS.map((app) => ({ ...app })),
    learned: extra.learned ?? [],
    automations: extra.automations ?? [],
    activity: extra.activity ?? [],
    messages: extra.messages ?? [],
  };
}

const seedDots: Dot[] = [
  powers({
    id: "research",
    name: "Research",
    instructions: "Look it up, keep a short brief, and check back when it changes.",
    face: "blob",
    color: "#8eb7e8",
    motion: "searching",
    control: "dot",
    callback: false,
    when: "09:00",
    automations: [{ id: "a1", title: "Morning brief", when: "Weekdays at 09:00" }],
    activity: ["Read the cooling-pad notes", "Compared two 16-inch pads"],
    messages: [
      { id: "m1", from: "you", text: "Find a quiet pad for the 16-inch MacBook." },
      { id: "m2", from: "research", text: "The Targus fits. It needs a dock. I would not buy it only to quiet the fans." },
    ],
    tasks: [{ id: "tr", title: "Quiet pad brief", state: "done" }],
  }),
  powers({
    id: "inbox",
    name: "Inbox",
    instructions: "Watch mail. Bring me only what needs a reply.",
    face: "cat",
    color: "#f0b4c8",
    motion: "listening",
    control: "dot",
    callback: true,
    when: "08:30",
    automations: [{ id: "a2", title: "Unread digest", when: "Weekdays at 08:30" }],
    activity: ["Checked mail", "Flagged Thursday"],
    messages: [{ id: "m3", from: "inbox", text: "Three notes. One is the Thursday deadline." }],
    tasks: [{ id: "ti", title: "Thursday deadline", state: "needs-you" }],
    outputs: [{ id: "oi", title: "Reply draft", detail: "Short reply for Thursday. It will not send until you approve.", status: "review" }],
  }),
  powers({
    id: "code",
    name: "Code",
    instructions: "Stay on the build until it runs. Call only if a login blocks you.",
    face: "droid",
    color: "#c4b6e8",
    motion: "working",
    control: "dot",
    callback: true,
    when: "18:00",
    automations: [],
    activity: ["Migrated the notes", "Waiting on images"],
    messages: [{ id: "m4", from: "code", text: "961 notes are in. Images are the step still waiting on you." }],
    tasks: [{ id: "tc", title: "Image step", state: "needs-you" }],
  }),
];

const seedGroups: Group[] = [{ id: "desk", name: "Desk", memberIds: ["research", "inbox", "code"] }];
const STORE = "friday.air.local";

function loadStore(): { dots: Dot[]; groups: Group[]; teamNotes: Note[]; theme: Theme } | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { dots?: Dot[]; groups?: Group[]; teamNotes?: Note[]; theme?: Theme };
    if (!parsed.dots?.length) return null;
    return { dots: parsed.dots.map((dot) => freshen(powers(dot))), groups: parsed.groups ?? seedGroups, teamNotes: parsed.teamNotes ?? [], theme: parsed.theme === "dark" ? "dark" : "light" };
  } catch {
    return null;
  }
}

function freshen(dot: Dot): Dot {
  if (dot.id === "inbox" && (dot.color === "#F0B429" || dot.color === "#eb2f96")) return { ...dot, face: "cat", color: "#f0b4c8" };
  if (dot.id === "research" && (dot.color === "#E6E2D8" || dot.color === "#1890ff")) return { ...dot, face: "blob", color: "#8eb7e8" };
  if (dot.id === "code" && (dot.color === "#E7B4D4" || dot.color === "#722ed1")) return { ...dot, face: "droid", color: "#c4b6e8" };
  return dot;
}

function uid() {
  return crypto.randomUUID();
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

export function AirWorkspace() {
  const saved = useMemo(loadStore, []);
  const [theme, setTheme] = useState<Theme>(saved?.theme ?? "dark");
  const [dots, setDots] = useState<Dot[]>(saved?.dots ?? seedDots);
  const [groups, setGroups] = useState<Group[]>(saved?.groups ?? seedGroups);
  const [openId, setOpenId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"work" | "settings">("work");
  const [screen, setScreen] = useState(false);
  const [nav, setNav] = useState(true);
  const [rail, setRail] = useState(false);
  const [railW, setRailW] = useState(300);
  const [screenW, setScreenW] = useState(520);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [beat, setBeat] = useState(0);
  const [arriving, setArriving] = useState<string | null>(null);
  const [call, setCall] = useState(false);
  const [talkTo, setTalkTo] = useState("");
  const [making, setMaking] = useState<"dot" | "group" | null>(null);
  const [form, setForm] = useState({ name: "", instructions: "", face: "blob" as Face, color: "#8eb7e8", motion: "working" as Motion, members: [] as string[] });
  const [teamNotes, setTeamNotes] = useState<Note[]>(saved?.teamNotes?.length ? saved.teamNotes : [
    { id: "t1", from: "you", text: "Desk, what is waiting on me?" },
    { id: "t2", from: "inbox", text: "Thursday's email." },
    { id: "t3", from: "code", text: "The image step." },
  ]);

  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify({ dots, groups, teamNotes, theme }));
  }, [dots, groups, teamNotes, theme]);

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

  const steps: { motion: Motion; label: string }[] = [
    { motion: "listening", label: "Listening" },
    { motion: "searching", label: "Looking" },
    { motion: "solving", label: "Thinking" },
    { motion: "composing", label: "Writing" },
  ];
  const step = steps[beat % steps.length];

  useEffect(() => {
    if (!thinking) return;
    const id = window.setInterval(() => setBeat((n) => n + 1), 520);
    return () => window.clearInterval(id);
  }, [thinking]);

  const dot = dots.find((item) => item.id === openId) ?? null;
  const group = groups.find((item) => item.id === groupId) ?? null;
  const members = useMemo(() => (group ? dots.filter((item) => group.memberIds.includes(item.id)) : []), [group, dots]);

  function patch(id: string, next: Partial<Dot>) {
    setDots((all) => all.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }

  function say(text: string) {
    if (!dot || thinking) return;
    const cleaned = text.trim();
    if (!cleaned) return;
    const mine: Note = { id: uid(), from: "you", text: cleaned };
    const peer = dots.find((item) => item.id === talkTo);
    const reply: Note = { id: uid(), from: dot.id, text: peer ? `I asked ${peer.name} to take "${cleaned}".` : `On it. I'll stay with "${cleaned}".` };
    setDraft("");
    setThinking(true);
    setBeat(0);
    setDots((all) => all.map((item) => (item.id === dot.id ? { ...item, messages: [...item.messages, mine], activity: [cleaned.slice(0, 72), ...item.activity].slice(0, 6) } : item)));
    window.setTimeout(() => {
      setDots((all) => all.map((item) => {
        if (item.id === dot.id) return { ...item, messages: [...item.messages, reply] };
        if (peer && item.id === peer.id) {
          return {
            ...item,
            messages: [...item.messages, { id: uid(), from: dot.id, text: `${dot.name} asked: ${cleaned}` }, { id: uid(), from: peer.id, text: peer.instructions }],
            activity: [`Heard from ${dot.name}`, ...item.activity].slice(0, 6),
          };
        }
        return item;
      }));
      setArriving(reply.id);
      setThinking(false);
    }, 1680);
  }

  function teamSay() {
    const text = draft.trim();
    if (!group || !text || thinking) return;
    const notes: Note[] = [{ id: uid(), from: "you", text }, ...members.map((item) => ({ id: uid(), from: item.id, text: item.instructions }))];
    setDraft("");
    setThinking(true);
    setBeat(0);
    setTeamNotes((all) => [...all, notes[0]]);
    window.setTimeout(() => {
      setTeamNotes((all) => [...all, ...notes.slice(1)]);
      setArriving(notes[notes.length - 1]?.id ?? null);
      setThinking(false);
    }, 1680);
  }

  function create() {
    if (making === "dot") {
      const name = form.name.trim() || "New dot";
      const created = powers({
        id: uid(),
        name,
        instructions: form.instructions.trim() || "Stay on what I ask until it is done.",
        face: form.face,
        color: form.color,
        motion: form.motion,
        activity: ["Just created"],
        messages: [{ id: uid(), from: "dot", text: `I'm ${name}. ${form.instructions.trim() || "Tell me what to take care of."}` }],
      });
      setDots((all) => [...all, created]);
      setOpenId(created.id);
      setGroupId(null);
    } else if (making === "group") {
      const name = form.name.trim() || "Team";
      const created: Group = { id: uid(), name, memberIds: form.members };
      setGroups((all) => [...all, created]);
      setGroupId(created.id);
      setOpenId(null);
    }
    setMaking(null);
    setForm({ name: "", instructions: "", face: "blob", color: "#8eb7e8", motion: "working", members: [] });
  }

  function startUse(job: (typeof USES)[number]) {
    setMaking(null);
    setGroupId(null);
    setOpenId(job.dot);
    setPanel("work");
    setDots((all) => all.map((item) => {
      if (item.id !== job.dot) return item;
      return {
        ...item,
        tasks: [{ id: uid(), title: job.task, state: job.ask ? "needs-you" : "running" }, ...item.tasks],
        outputs: [{ id: uid(), title: job.title, detail: job.output, status: job.ask ? "review" : "approved" }, ...item.outputs],
        activity: [job.title, ...item.activity].slice(0, 6),
        messages: [...item.messages, { id: uid(), from: item.id, text: `${job.task} ${job.output}` }],
      };
    }));
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
    return dots.find((item) => item.id === id)?.name ?? "Dot";
  }

  return (
    <div className="air-stage flex h-dvh gap-3 p-3" style={{ background: bg, color: ink, fontFamily: "var(--font-sans)" }}>
      <style>{AIR_MOTION}</style>
      <aside className="flex shrink-0 flex-col rounded-2xl px-2 py-3 transition-[width] duration-300" style={{ width: nav ? 220 : 76, background: panelBg, boxShadow: card }}>
        <div className={nav ? "flex items-center justify-between px-1" : "flex flex-col items-center gap-2"}>
          {nav && <p className="text-[14px]">Air Dots</p>}
          <button type="button" aria-label={nav ? "Close sidebar" : "Open sidebar"} className="grid size-8 place-items-center rounded-full text-[16px]" style={{ color: muted }} onClick={() => setNav((open) => !open)}>{nav ? "‹" : "›"}</button>
          {nav && (
            <button type="button" aria-label={dark ? "Use light theme" : "Use dark theme"} className="grid size-8 place-items-center rounded-full" onClick={() => setTheme(dark ? "light" : "dark")}>
              {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </button>
          )}
        </div>
        <button type="button" aria-label="New dot" className={nav ? "mt-3 flex h-10 items-center gap-2 rounded-2xl px-2 text-[14px]" : "mt-3 grid size-10 place-items-center self-center rounded-full"} style={{ background: dark ? "#222" : "#f3f1ec" }} onClick={() => setMaking("dot")}>
          <Plus className="size-3.5" />{nav && "New dot"}
        </button>
        <div className="mt-4 grid gap-1">
          {dots.map((item) => {
            const notes = item.tasks.filter((task) => task.state === "needs-you").length + item.outputs.filter((row) => row.status === "review").length;
            return (
              <button key={item.id} type="button" className={nav ? "relative flex items-center gap-2 rounded-2xl px-1 py-1 text-left text-[14px]" : "relative grid size-12 place-items-center self-center rounded-2xl"} style={{ background: openId === item.id ? (dark ? "#262626" : "#f3f1ec") : "transparent" }} onClick={() => { setOpenId(item.id); setGroupId(null); setCall(false); setRail(false); }}>
                <span className="relative">
                  <Mark face={item.face} color={item.color} size={40} state={thinking && openId === item.id ? "working" : "default"} />
                  {notes > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-medium" style={{ background: item.color, color: "#1c1b19" }}>{notes}</span>}
                </span>
                {nav && <span className="truncate">{item.name}</span>}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {making && (
          <div className="mx-auto w-full max-w-xl px-8 py-10">
            <h1 className="text-3xl font-medium tracking-tight">{making === "dot" ? "Make a dot" : "Make a group"}</h1>
            <label className="mt-6 block text-xs" style={{ color: muted }}>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 h-11 w-full rounded-2xl border bg-transparent px-3 text-sm outline-none" style={{ borderColor: line }} />
            {making === "dot" && (
              <>
                <label className="mt-4 block text-xs" style={{ color: muted }}>Instructions</label>
                <textarea value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} className="mt-1 h-24 w-full rounded-2xl border bg-transparent px-3 py-2 text-sm outline-none" style={{ borderColor: line }} />
                <p className="mt-4 text-xs" style={{ color: muted }}>Mascot</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {PALETTE.map((look) => (
                    <button key={look.face} type="button" className="rounded-2xl p-1" style={{ outline: form.face === look.face ? `2px solid ${look.color}` : "2px solid transparent" }} onClick={() => setForm({ ...form, face: look.face, color: look.color })}>
                      <Mark face={look.face} color={look.color} size={64} />
                    </button>
                  ))}
                </div>
                <p className="mt-4 text-xs" style={{ color: muted }}>Animation</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {MOTIONS.map((motion) => (
                    <button key={motion} type="button" className="rounded-full border px-3 py-1 text-xs capitalize" style={{ borderColor: form.motion === motion ? ink : line }} onClick={() => setForm({ ...form, motion })}>{motion}</button>
                  ))}
                </div>
                <div className="mt-4"><ThinkingOrb state={form.motion} size={64} theme={theme} /></div>
              </>
            )}
            {making === "group" && (
              <div className="mt-4 grid gap-2">
                {dots.map((item) => {
                  const on = form.members.includes(item.id);
                  return (
                    <button key={item.id} type="button" className="flex items-center gap-2 rounded-2xl border px-3 py-2 text-left text-sm" style={{ borderColor: on ? ink : line }} onClick={() => setForm({ ...form, members: on ? form.members.filter((id) => id !== item.id) : [...form.members, item.id] })}>
                      <Mark face={item.face} color={item.color} size={36} /> {item.name}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="mt-6 flex gap-2">
              <button type="button" className="h-10 rounded-full px-4 text-sm" style={{ background: ink, color: bg }} onClick={create}>Create</button>
              <button type="button" className="h-10 rounded-full border px-4 text-sm" style={{ borderColor: line }} onClick={() => setMaking(null)}>Cancel</button>
            </div>
          </div>
        )}

        {!making && !dot && !group && (
          <div className="flex flex-1 flex-col items-center justify-center px-6">
            <h1 className="air-in text-5xl font-medium tracking-tight">Your dots</h1>
            <p className="mt-3 max-w-md text-center text-sm" style={{ color: muted }}>A dot keeps working on its own computer, brings the result back, and waits when the action leaves your account.</p>
            <div className="mt-8 flex max-w-3xl flex-wrap justify-center gap-2">
              {USES.map((job) => (
                <button key={job.title} type="button" className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: line }} onClick={() => startUse(job)}>{job.title}</button>
              ))}
            </div>
            <div className="mt-10 flex flex-wrap justify-center gap-8">
              {dots.map((item) => (
                <button key={item.id} type="button" className="flex w-28 flex-col items-center gap-3" onClick={() => setOpenId(item.id)}>
                  <Mark face={item.face} color={item.color} size={112} />
                  <span className="text-sm" style={{ color: muted }}>{item.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!making && group && (
          <Thread
            title={group.name}
            subtitle="They answer together, and they can hear each other."
            faces={members}
            notes={teamNotes}
            who={who}
            arriving={arriving}
            draft={draft}
            setDraft={setDraft}
            onSend={teamSay}
            working={thinking}
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
            <div className="flex min-w-0 flex-1 flex-col rounded-2xl" style={{ background: panelBg, boxShadow: card }} onClick={() => { setRail(false); setCall(false); }}>
              <div className="flex items-center justify-between px-4 pt-3">
                <button type="button" aria-label="Open the computer" className="grid size-9 place-items-center rounded-full" style={{ background: screen ? (dark ? "#262626" : "#f3f1ec") : "transparent" }} onClick={(event) => { event.stopPropagation(); patch(dot.id, { control: "you" }); setScreen(true); }}>
                  <Monitor className="size-4" />
                </button>
                <div className="flex items-center gap-2">
                  <select value={talkTo} onChange={(e) => setTalkTo(e.target.value)} className="h-8 rounded-full border bg-transparent px-3 text-[12px]" style={{ borderColor: line, color: ink }}>
                    <option value="">Talks alone</option>
                    {dots.filter((item) => item.id !== dot.id).map((item) => <option key={item.id} value={item.id}>Ask {item.name}</option>)}
                  </select>
                  <button type="button" aria-label={`Call ${dot.name}`} className="air-call grid size-9 place-items-center rounded-full" style={{ background: ink, color: bg }} onClick={(event) => { event.stopPropagation(); setCall(true); }}>
                    <Phone className="size-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto px-6 py-2">
                <div key={dot.id} className="air-pop flex justify-center pb-2 pt-1">
                  <button type="button" aria-label={`Open ${dot.name}`} className="rounded-full" onClick={(event) => { event.stopPropagation(); setRail(true); }}>
                    <Mark face={dot.face} color={dot.color} size={88} state={thinking ? "working" : "default"} />
                  </button>
                </div>
                {dot.messages.map((note) => (
                  <Bubble key={note.id} mine={note.from === "you"} label={who(note.from)} text={note.text} youBg={youBg} youInk={youInk} replyBg={replyBg} ink={ink} muted={muted} live={arriving === note.id} />
                ))}
                {thinking && <ThinkRow motion={step.motion} label={step.label} theme={theme} muted={muted} />}
              </div>
              <Composer draft={draft} setDraft={setDraft} onSend={() => say(draft)} theme={theme} line={line} placeholder={`Message ${dot.name}`} working={thinking} />
              {call && (
                <div className="air-in absolute right-8 top-16 w-80" onClick={(event) => event.stopPropagation()}>
                  <VoiceBeam type="pill" theme={theme} look="glow" colorVariant="gold">
                    <div className="rounded-3xl border p-4" style={{ background: panelBg, borderColor: line }}>
                      <div className="flex items-center gap-2">
                        <Mark face={dot.face} color={dot.color} size={56} state="working" />
                        <div>
                          <p className="text-sm">{dot.name}</p>
                          <p className="text-xs" style={{ color: muted }}>{thinking ? "Thinking" : "On the call"}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-xs" style={{ color: muted }}>Preview only. Nothing is dialed.</p>
                      <button type="button" className="mt-4 h-10 rounded-full bg-red-600 px-4 text-sm text-white" onClick={() => setCall(false)}>Hang up</button>
                    </div>
                  </VoiceBeam>
                </div>
              )}
            </div>
            {screen && (
              <>
                <div role="separator" aria-label="Resize the computer" className="mx-1 w-1.5 shrink-0 cursor-col-resize self-stretch rounded-full" style={{ background: line }} onPointerDown={(event) => dragWidth(event, screenW, setScreenW, 320, 860)} />
                <div className="air-in flex min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl bg-white text-neutral-950" style={{ width: screenW }}>
                  <div className="flex items-center gap-2 border-b border-black/10 px-3 py-2">
                    <span className="size-2 rounded-full bg-red-400" />
                    <span className="size-2 rounded-full bg-amber-300" />
                    <span className="size-2 rounded-full bg-green-400" />
                    <p className="ml-1 flex-1 truncate text-[13px]">{dot.name}'s computer</p>
                    <button type="button" className="h-7 rounded-full bg-[#1c1b19] px-2.5 text-[12px] text-white" onClick={() => patch(dot.id, { control: dot.control === "dot" ? "you" : "dot" })}>{dot.control === "dot" ? "Take over" : "Give it back"}</button>
                    <button type="button" aria-label="Close the computer" className="grid size-7 place-items-center rounded-full" onClick={() => setScreen(false)}><X className="size-3.5" /></button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto bg-[#f7f8fa]">
                    <ScreenBody dot={dot} />
                  </div>
                </div>
              </>
            )}
            {rail && (
            <aside className="air-in absolute right-4 top-1/2 z-20 flex max-h-[440px] -translate-y-1/2 flex-col overflow-hidden rounded-3xl" style={{ width: railW, background: panelBg, boxShadow: "0 16px 40px rgba(0,0,0,.12)" }} onClick={(event) => event.stopPropagation()}>
              <div role="separator" aria-label="Resize the side pane" className="absolute inset-y-6 left-0 w-1.5 cursor-col-resize" onPointerDown={(event) => dragWidth(event, railW, setRailW, 220, 420)} />
              <div className="flex items-center gap-1 px-3 pt-3">
                <button type="button" className="h-8 rounded-full px-3 text-[13px]" style={{ background: panel === "work" ? (dark ? "#262626" : "#f3f1ec") : "transparent" }} onClick={() => setPanel("work")}>Work</button>
                <button type="button" className="grid size-8 place-items-center rounded-full" style={{ background: panel === "settings" ? (dark ? "#262626" : "#f3f1ec") : "transparent" }} onClick={() => setPanel("settings")} aria-label="Settings"><Settings className="size-4" /></button>
                <button type="button" aria-label="Close" className="ml-auto grid size-8 place-items-center rounded-full" onClick={() => setRail(false)}><X className="size-4" /></button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {panel === "work" ? (
                <div key="work" className="air-in min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                  <p className="text-[13px]" style={{ color: muted }}>In progress</p>
                  {dot.tasks.length === 0 && <p className="text-sm" style={{ color: muted }}>Nothing running. Hand it a job from the home screen.</p>}
                  {dot.tasks.map((task) => (
                    <p key={task.id} className="text-sm">{task.title}<span className="mt-0.5 block text-xs capitalize" style={{ color: muted }}>{task.state.replace("-", " ")}</span></p>
                  ))}
                  <p className="text-[13px]" style={{ color: muted }}>Brought back</p>
                  {dot.outputs.map((item) => (
                    <div key={item.id} className="rounded-2xl border p-3" style={{ borderColor: line }}>
                      <p className="text-sm">{item.title}</p>
                      <p className="mt-1 text-xs" style={{ color: muted }}>{item.detail}</p>
                      {item.status === "review" ? (
                        <div className="mt-2 flex gap-2">
                          <button type="button" className="h-8 rounded-full px-3 text-xs" style={{ background: ink, color: bg }} onClick={() => patch(dot.id, { outputs: dot.outputs.map((row) => row.id === item.id ? { ...row, status: "approved" } : row), learned: [`Approved: ${item.title}`, ...dot.learned] })}>Approve</button>
                          <button type="button" className="h-8 rounded-full border px-3 text-xs" style={{ borderColor: line }} onClick={() => patch(dot.id, { outputs: dot.outputs.map((row) => row.id === item.id ? { ...row, status: "held" } : row) })}>Hold</button>
                        </div>
                      ) : <p className="mt-2 text-xs capitalize" style={{ color: muted }}>{item.status}</p>}
                    </div>
                  ))}
                  <p className="text-[13px]" style={{ color: muted }}>Rules</p>
                  {dot.rules.map((rule) => (
                    <button key={rule.id} type="button" className="block w-full rounded-2xl border px-3 py-2 text-left text-sm" style={{ borderColor: line }} onClick={() => patch(dot.id, { rules: dot.rules.map((row) => row.id === rule.id ? { ...row, mode: row.mode === "allow" ? "ask" : row.mode === "ask" ? "block" : "allow" } : row) })}>
                      {rule.text}
                      <span className="mt-0.5 block text-xs capitalize" style={{ color: muted }}>{rule.mode}</span>
                    </button>
                  ))}
                  <p className="text-[13px]" style={{ color: muted }}>Apps</p>
                  {dot.apps.map((app) => (
                    <button key={app.name} type="button" className="flex w-full items-center justify-between rounded-2xl border px-3 py-2 text-sm" style={{ borderColor: line }} onClick={() => patch(dot.id, { apps: dot.apps.map((row) => row.name === app.name ? { ...row, access: row.access === "read" ? "act" : "read" } : row) })}>
                      {app.name}<span className="text-xs" style={{ color: muted }}>{app.access === "read" ? "Read only" : "Can act"}</span>
                    </button>
                  ))}
                  {dot.learned.length > 0 && <p className="text-xs" style={{ color: muted }}>{dot.learned[0]}</p>}
                </div>
              ) : (
                <div key="settings" className="air-in min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
                  <label className="block text-xs" style={{ color: muted }}>Name</label>
                  <input value={dot.name} onChange={(e) => patch(dot.id, { name: e.target.value })} className="h-10 w-full rounded-2xl border bg-transparent px-3 text-sm outline-none" style={{ borderColor: line }} />
                  <label className="block text-xs" style={{ color: muted }}>Instructions</label>
                  <textarea value={dot.instructions} onChange={(e) => patch(dot.id, { instructions: e.target.value })} className="h-24 w-full rounded-2xl border bg-transparent px-3 py-2 text-sm outline-none" style={{ borderColor: line }} />
                  <p className="text-xs" style={{ color: muted }}>Mascot</p>
                  <div className="flex flex-wrap gap-1">
                    {PALETTE.map((look) => (
                      <button key={look.face} type="button" className="rounded-xl p-0.5" style={{ outline: dot.face === look.face ? `2px solid ${look.color}` : "2px solid transparent" }} onClick={() => patch(dot.id, { face: look.face, color: look.color })}>
                        <Mark face={look.face} color={look.color} size={52} paused />
                      </button>
                    ))}
                  </div>
                  <p className="text-xs" style={{ color: muted }}>Animation</p>
                  <div className="flex flex-wrap gap-1">
                    {MOTIONS.map((motion) => (
                      <button key={motion} type="button" className="rounded-full border px-2 py-1 text-[11px] capitalize" style={{ borderColor: dot.motion === motion ? ink : line }} onClick={() => patch(dot.id, { motion })}>{motion}</button>
                    ))}
                  </div>
                  <label className="flex items-center justify-between text-sm">
                    Call back when done
                    <input type="checkbox" checked={dot.callback} onChange={(e) => patch(dot.id, { callback: e.target.checked })} />
                  </label>
                  <label className="block text-xs" style={{ color: muted }}>Weekday time</label>
                  <input type="time" value={dot.when} onChange={(e) => patch(dot.id, { when: e.target.value })} className="h-10 rounded-2xl border bg-transparent px-3 text-sm" style={{ borderColor: line }} />
                  <button type="button" className="h-9 rounded-full border px-3 text-xs" style={{ borderColor: line }} onClick={() => patch(dot.id, { automations: [{ id: uid(), title: "Check", when: `Weekdays at ${dot.when}` }, ...dot.automations] })}>Add to this dot's schedule</button>
                  <ul className="space-y-1 text-xs" style={{ color: muted }}>
                    {dot.automations.map((item) => <li key={item.id}>{item.title} · {item.when}</li>)}
                  </ul>
                </div>
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

function Mark({ face, color, size, state = "default", paused }: { face: Face; color: string; size: number; state?: "default" | "working" | "sleeping"; paused?: boolean }) {
  return <BotAvatar type={face} color={color} size={size} state={state} face="mouth" paused={paused} shading="plastic" saturation={1.15} highlight={1.5} shadow={0.22} />;
}

function ScreenBody({ dot }: { dot: Dot }) {
  if (dot.id === "inbox" || dot.face === "cat") {
    return (
      <div className="grid h-full grid-cols-[180px_1fr] text-neutral-950">
        <div className="border-r border-black/5 bg-white p-4 text-sm"><p className="font-medium">Mail</p><p className="mt-3">Inbox</p><p className="mt-2 text-black/45">Sent</p></div>
        <div className="p-4">
          <p className="text-[13px] text-black/45">Thursday · sponsor</p>
          <p className="mt-1 text-lg font-medium">Thursday deadline</p>
          <p className="mt-2 text-sm text-black/70">Three notes. One needs a reply before Thursday. The draft is waiting for you.</p>
        </div>
      </div>
    );
  }
  if (dot.id === "code" || dot.face === "droid") {
    return (
      <div className="grid h-full min-h-[420px] grid-cols-[180px_1fr] bg-[#161616] text-white">
        <div className="border-r border-white/10 p-4 text-sm"><p>Releases</p><p className="mt-3 text-white/70">Build</p></div>
        <div className="p-4">
          <p className="text-[13px] text-white/50">Version 1.8 · 2 of 6</p>
          <p className="mt-1 text-lg font-medium">Upload build</p>
          <ul className="mt-3 space-y-1 text-sm text-white/80">
            <li>Images still waiting</li>
            <li>Notes migrated</li>
            <li>Login stays with you</li>
          </ul>
        </div>
      </div>
    );
  }
  return (
    <div className="h-full bg-white p-6 text-neutral-950">
      <p className="text-[13px] text-black/45">Brief</p>
      <p className="mt-1 text-2xl font-medium">What changed</p>
      <p className="mt-3 max-w-xl text-sm leading-6 text-black/70">{dot.messages.at(-1)?.text}</p>
    </div>
  );
}

function Bubble({ mine, label, text, youBg, youInk, replyBg, ink, muted, live }: { mine: boolean; label: string; text: string; youBg: string; youInk: string; replyBg: string; ink: string; muted: string; live?: boolean }) {
  const [shown, setShown] = useState(live ? "" : text);
  useEffect(() => {
    if (!live) {
      setShown(text);
      return;
    }
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, 16);
    return () => window.clearInterval(id);
  }, [live, text]);
  return (
    <div className={mine ? "air-in ml-auto w-fit max-w-xl" : "air-in max-w-xl"}>
      {!mine && <p className="mb-1 text-[11px]" style={{ color: muted }}>{label}</p>}
      <div className="rounded-2xl px-4 py-2.5 text-[15px] leading-6" style={{ background: mine ? youBg : replyBg, color: mine ? youInk : ink }}>
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
  const field = (
    <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={working ? "Working" : placeholder} readOnly={working} className="h-12 w-full rounded-full border bg-transparent px-4 text-[15px] outline-none" style={{ borderColor: line }} />
  );
  return (
    <form className="px-4 pb-4" onSubmit={(e) => { e.preventDefault(); onSend(); }}>
      {working ? <BorderBeam size="md" colorVariant="gold" theme={theme} duration={2.4}>{field}</BorderBeam> : field}
    </form>
  );
}

function Thread({ title, subtitle, faces, notes, who, arriving, draft, setDraft, onSend, working, motion, status, theme, ink, muted, line, youBg, youInk, replyBg, panelBg }: {
  title: string; subtitle: string; faces: Dot[]; notes: Note[]; who: (id: string) => string; arriving: string | null; draft: string; setDraft: (v: string) => void; onSend: () => void; working?: boolean; motion: Motion; status: string; theme: Theme; ink: string; muted: string; line: string; youBg: string; youInk: string; replyBg: string; panelBg: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b px-6 py-4" style={{ borderColor: line }}>
        <div className="flex items-center gap-2">
          {faces.map((item) => <Mark key={item.id} face={item.face} color={item.color} size={48} />)}
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
