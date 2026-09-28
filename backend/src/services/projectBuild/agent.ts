import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import { emptyTokenUsage, estimateTokenUsageFromText, mergeTokenUsage, type TokenUsage } from "../tokenUsage.js";
import type { BuildEffort, BuildMeta, BuildMode, BuildPlan, BuildStep, StreamEvent } from "../chat/types.js";
import { ActionParser, applySearchReplace, compactAssistantTurn, type BuildAction } from "./protocol.js";
import { findGitHubRepoUrl, importRepo, openPullRequest } from "./github.js";
import { waitForApproval } from "./approvals.js";
import JSZip from "jszip";
import { BuildSandbox, PROJECT_DIR, getProject, safeProjectPath, saveProject, tail } from "./sandbox.js";

// Effort controls how much exploration/retry/QA budget a build gets — it only ever widens these
// ceilings, never shrinks STUCK_REPEATS below: the standing product rule is "retry until genuinely
// stuck," not "give up sooner on a low setting."
const EFFORT_BUDGETS: Record<BuildEffort, { iterations: number; wallMs: number; visualRounds: number }> = {
  low: { iterations: 25, wallMs: 10 * 60_000, visualRounds: 1 },
  medium: { iterations: 45, wallMs: 18 * 60_000, visualRounds: 2 },
  high: { iterations: 80, wallMs: 35 * 60_000, visualRounds: 4 },
};
// The same failure this many times in a row = genuinely stuck. Before that it gets a "step back and
// change approach" reflection at REFLECT_AT, so it recovers instead of giving up.
const REFLECT_AT = 2;
const STUCK_REPEATS = 5;

/** Actions whose real-world effect is hard/impossible to undo, or costs money/time — installs,
 *  destructive commands, deploys, and PRs. Auto mode only pauses for these; everything else it
 *  runs freely (Manual pauses for every mutating action; Edit automatically only for these too). */
function isRiskyAction(action: BuildAction): boolean {
  if (action.kind === "pr") return true;
  if (action.kind === "run") return /\b(rm -rf|drop table|truncate|npm i(nstall)?\b|npm add|pip install|yarn add|pnpm add|deploy)\b/i.test(action.cmd);
  return false;
}

/** Whether this action must pause for the user's approve/reject before it runs, given the session's mode. */
function shouldPauseFor(action: BuildAction, mode: BuildMode): boolean {
  if (action.kind === "read" || action.kind === "grep" || action.kind === "ls") return false;
  switch (mode) {
    case "manual":
      return action.kind === "write" || action.kind === "edit" || action.kind === "run" || action.kind === "start" || action.kind === "pr";
    case "edit_auto":
      return action.kind === "run" || action.kind === "pr";
    case "auto":
      return isRiskyAction(action);
    case "plan":
      // Plan mode gates once, before the iterate loop even starts (see the plan-approval check
      // below) — by the time actions are running, the plan was already approved.
      return false;
    default:
      return false;
  }
}

const PLAN_PROMPT = `You are the tech lead of a coding agent that will build the user's request as a real, runnable project in a Linux sandbox (Node.js, npm, Python 3). Before any code is written, produce the plan. Reply in EXACTLY this format and nothing else:
<architecture>
3-8 short lines: the stack and why, the folder structure (key folders/files), how the pieces talk (ports: frontend 5173, API 4000 if any), and the main design decisions.
</architecture>
- [ ] first concrete step
- [ ] second concrete step
(5-9 checklist items in execution order: scaffold/config, each major feature or module, integration, then a final item "Run it, verify it in a browser and fix any issues". Concrete and short — each item one line.)
If the user is asking to change/fix an existing project, keep the plan small and specific to that change.`;

const BUILD_SYSTEM_PROMPT = `You are Friday's Build agent. You have a real Linux sandbox (Node.js LTS + npm, Python 3, git, curl, internet access) and you build the user's project inside it for real: write every file, install dependencies, run it, read the errors and fix them until it works. You are NOT limited to snippets — deliver a complete, runnable project with a proper folder structure.

WORKFLOW (like a senior engineer): a PLAN (architecture + todo checklist) has already been drafted for you and is shown to the user. Execute it item by item. After you finish an item — or start the next one — send the checklist with updated markers so the user sees live progress:
<friday-progress>
- [x] finished item text
- [~] item you are working on now
- [ ] item still to do
</friday-progress>
(Repeat every item, same order and wording as the plan.) If reality forces a change of approach, keep going and adapt — the plan is a guide, the working result is the goal.

ACTIONS — you act by writing these tags in your reply (they are executed for you, in order; the user sees each as a step):
<friday-write path="relative/path.ext">
full file contents (no markdown fences inside)
</friday-write>
<friday-run desc="Short user-facing label">shell command (waits for it to finish; use for npm install, builds, scripts, tests)</friday-run>
<friday-start port="5173" desc="Start the dev server">command that runs a long-lived server</friday-start>
<friday-read path="relative/path.ext"/>
<friday-edit path="relative/path.ext">
<<<<<<< SEARCH
exact lines currently in the file (copied verbatim, enough to be unique)
=======
the new lines
>>>>>>> REPLACE
</friday-edit>   (one or more SEARCH/REPLACE blocks; use this for changes to EXISTING files instead of rewriting them)
<friday-grep pattern="regex" path="src"/>   (search file contents, like grep -rnE)
<friday-ls path="src"/>   (list files, 3 levels deep, without node_modules)
<friday-pr title="Short PR title" branch="friday/short-name">What changed and why</friday-pr>   (ONLY for a project imported from GitHub, and ONLY when the user asked for a pull request: commits your changes to a new branch and opens a PR)
<friday-done>Short summary for the user: what you built, how it is organised, how to use it.</friday-done>

RULES
- Sandbox gotchas: do NOT rely on a PORT environment variable — put explicit ports in commands/config (frontend/Vite 5173, API 4000, etc.). Restarting a server is just another <friday-start> for the same port (the old stack is stopped for you) — never use pkill/killall. Avoid long multi-line shell one-liners with nested quotes: write a small script file with <friday-write> and run it. Use curl with simple single-line commands.
- The project root is ${PROJECT_DIR}. All paths are relative to it. Never write outside it.
- Each action tag must be well-formed and closed. Do not put action tags inside code blocks or quote them.
- Write ALL files a project needs (package.json, config, index.html, source, styles, README). Do not use interactive scaffolders (npm create …, npx create-… without flags) — write the files yourself.
- Pin dependency versions that are known to work together instead of "latest": vite ^5, @vitejs/plugin-react ^4, react/react-dom ^18. Tailwind: use tailwindcss ^3.4 with postcss + autoprefixer and a tailwind.config.js (content: ["./index.html","./src/**/*.{js,jsx,ts,tsx}"]) and "@tailwind base/components/utilities" in the CSS — do NOT use Tailwind v4 through the postcss "tailwindcss" plugin (it errors). Other libraries: use versions you are sure about.
- Web apps: prefer Vite (React or plain) with a package.json that has a "dev" script running "vite --host 0.0.0.0 --port 5173". Bind servers to 0.0.0.0 and use the port you pass to <friday-start>. Backend/API projects (Express, Flask, FastAPI, …) are fine too — start them on a port and verify with curl.
- Order: write files → <friday-run> install → <friday-start> the server (only if it is a server/app). After every result, read it: if a command failed or the server log shows errors, fix the cause and retry. Keep going until it truly works — don't stop at the first error.
- For a server, after it starts you may verify with <friday-run>curl -s localhost:PORT | head -20</friday-run>.
- Between actions write one short plain sentence about what you are doing. No long explanations before the work is done.
- Make the result genuinely polished: modern responsive UI, real content (no lorem ipsum / placeholder TODOs), sensible structure.
- When the project runs correctly, finish with exactly one <friday-done>…</friday-done>. Never claim it works if you did not see it run.
- NEVER tell the user to run commands themselves ("run npm install", "then npm start"). You run them, with <friday-run>/<friday-start>, and you only say it works after you saw it work.
- If the user asks to change/fix/extend an existing project, edit the existing files (read them first if needed) instead of starting over. Prefer <friday-edit> for small or medium changes to an existing file; use <friday-write> for new files or full rewrites. In an unfamiliar codebase, look around first with <friday-ls> and <friday-grep>.
- Follow any project instruction file (AGENTS.md / FRIDAY.md / CLAUDE.md) shown below — it describes that repo's conventions, commands and tests. Run the project's tests/linters when they exist before finishing.`;

type Iteration = { assistantText: string; results: string[]; done: string | null; anyAction: boolean; doneLead?: string; plainReply?: string };

export type BuildAgentResult = {
  /** Visible prose from every iteration, for the chat bubble. */
  text: string;
  build: BuildMeta;
  usage: TokenUsage;
  candidate: ChatCandidate | null;
  error?: string;
};

function describe(action: BuildAction): { kind: BuildStep["kind"]; label: string } | null {
  switch (action.kind) {
    case "write":
      return { kind: "write", label: `Wrote ${action.path}` };
    case "run":
      return { kind: "run", label: action.desc };
    case "start":
      return { kind: "start", label: action.desc };
    case "read":
      return { kind: "read", label: `Read ${action.path}` };
    case "edit":
      return { kind: "write", label: `Edited ${action.path}` };
    case "grep":
      return { kind: "read", label: `Searched for "${action.pattern.slice(0, 60)}"` };
    case "ls":
      return { kind: "read", label: `Listed ${action.path === "." ? "project files" : action.path}` };
    case "pr":
      return { kind: "run", label: `Open pull request · ${action.title.slice(0, 80)}` };
    default:
      return null;
  }
}

export async function runBuildAgent(opts: {
  userId: string;
  conversationId: string;
  history: ChatMessage[];
  candidates: ChatCandidate[];
  onEvent: (ev: StreamEvent) => void;
  signal?: AbortSignal;
  /** Set by subagents.ts's coordinator: reuse this already-open sandbox instead of opening a new
   *  one, so N sub-agents share one E2B VM instead of N. */
  sandbox?: BuildSandbox;
  /** Set by subagents.ts: confines this run to writing/editing/reading only under this directory
   *  (e.g. "backend"), skips planning/plan-approval/start/QA-gate/final-snapshot/kill — those stay
   *  the coordinator's job — and labels every step event so the workspace UI can group them. */
  pathPrefix?: string;
  subagentLabel?: string;
}): Promise<BuildAgentResult> {
  const { userId, conversationId, signal } = opts;
  const isSubagent = Boolean(opts.pathPrefix);
  // Sub-agent step events carry `subagent` so the workspace timeline can group them per workstream.
  const onEvent = (ev: StreamEvent): void =>
    opts.onEvent(opts.subagentLabel && ev.t === "step" ? { ...ev, subagent: opts.subagentLabel } : ev);
  const started = Date.now();
  const steps: BuildStep[] = [];
  const build: BuildMeta = { steps };
  let usage = emptyTokenUsage();
  let usedCandidate: ChatCandidate | null = null;
  let visibleText = "";
  let stepSeq = 0;
  const last: { start: { cmd: string; port: number } | null } = { start: null };

  // The chat bubble only carries the FINAL answer. Narration between actions ("Installing dependencies…")
  // becomes a short "note" row inside the steps list instead — otherwise every sentence of narration
  // piles up as a run-together wall of text under the steps.
  const emitText = (text: string) => {
    if (!text) return;
    visibleText += text;
    onEvent({ t: "text", c: text });
  };
  const pushNote = (raw: string) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    const note: BuildStep = { id: `s${++stepSeq}`, kind: "note", label: text.slice(0, 400), state: "ok" };
    steps.push(note);
    onEvent({ t: "step", ...note });
  };


  let box: BuildSandbox;
  if (opts.sandbox) {
    box = opts.sandbox;
  } else {
    try {
      box = await BuildSandbox.open(userId, conversationId);
    } catch (err) {
      return { text: "", build, usage, candidate: null, error: err instanceof Error ? err.message : "Couldn't start the sandbox" };
    }
  }

  /** Sub-agents may only touch files under their assigned prefix (e.g. "backend/") — keeps
   *  concurrent sub-agents from racing on each other's files on the shared sandbox filesystem. */
  const guardPath = (path: string): string | null => {
    const clean = safeProjectPath(path);
    if (!clean) return null;
    if (opts.pathPrefix && clean !== opts.pathPrefix && !clean.startsWith(`${opts.pathPrefix}/`)) return null;
    return clean;
  };

  let project = await getProject(conversationId);
  const mode: BuildMode = project?.mode ?? "auto";
  const effort: BuildEffort = project?.effort ?? "medium";
  const budget = EFFORT_BUDGETS[effort];
  onEvent({ t: "mode", mode, effort });

  /** Pauses the turn for the user's approve/reject, persisting what's pending so a page reload
   *  (or another device) can still see and act on it. Resolved by POST /build/:id/approve|reject. */
  const requestApproval = async (action: { kind: string; label: string; detail?: string }): Promise<boolean> => {
    await saveProject(userId, conversationId, { pending_approval: action });
    onEvent({ t: "approval", action });
    const approved = await waitForApproval(conversationId);
    await saveProject(userId, conversationId, { pending_approval: null });
    return approved;
  };

  const userRequestText = [...opts.history].reverse().find((m) => m.role === "user")?.content ?? "";

  // "Work on github.com/owner/repo": a brand-new project whose request links a GitHub repo starts
  // from a clone of that repo instead of an empty folder.
  const repoRef = Object.keys(project?.files ?? {}).length === 0 && !project?.repo ? findGitHubRepoUrl(userRequestText) : null;
  if (repoRef) {
    const step: BuildStep = { id: `s${++stepSeq}`, kind: "run", label: `Import ${repoRef.repo} from GitHub`, state: "running" };
    steps.push(step);
    onEvent({ t: "step", ...step });
    const imported = await importRepo(box, userId, repoRef);
    step.state = imported.ok ? "ok" : "error";
    step.detail = imported.message;
    onEvent({ t: "step", ...step });
    if (imported.ok) {
      await saveProject(userId, conversationId, { repo: repoRef.repo, repo_branch: imported.branch });
      await box.snapshot().catch(() => ({}));
      project = await getProject(conversationId);
    }
  }
  const existingFiles = Object.keys(project?.files ?? {});

  // Repo conventions for the agent, like Claude Code's CLAUDE.md / Codex's AGENTS.md.
  let instructionFile = "";
  for (const name of ["AGENTS.md", "FRIDAY.md", "CLAUDE.md"]) {
    const content = project?.files?.[name] ?? (existingFiles.length ? await box.read(name).catch(() => null) : null);
    if (content) {
      instructionFile = `\n\nPROJECT INSTRUCTIONS (${name}):\n${tail(content, 4000)}`;
      break;
    }
  }
  const stateNote =
    existingFiles.length > 0
      ? `EXISTING PROJECT in ${PROJECT_DIR} (${existingFiles.length} files): ${existingFiles.slice(0, 60).join(", ")}${existingFiles.length > 60 ? ", …" : ""}.\n` +
        (box.fresh
          ? "The sandbox was just restored from a snapshot: node_modules is NOT installed and no server is running — reinstall and restart if you need to run it.\n"
          : "The sandbox is still alive: dependencies are probably installed and the dev server may still be running (restarting is fine).\n") +
        (project?.start_cmd ? `Last start command: ${project.start_cmd} (port ${project.port}).` : "") +
        (project?.repo
          ? `\nThis project is the GitHub repository ${project.repo} (base branch ${project.repo_branch ?? "main"}). It is an existing codebase: explore it before changing it, keep its conventions, and when the user asks for a pull request finish with <friday-pr>.`
          : "") +
        instructionFile
      : "This is a new, empty project directory.";

  const conversation: ChatMessage[] = [
    { role: "system", content: `${BUILD_SYSTEM_PROMPT}\n\n${stateNote}` },
    ...opts.history.filter((m) => m.role !== "system"),
  ];

  const userRequest = userRequestText;
  let visualRounds = 0;

  /** Sends the rendered page to a vision-capable model that acts as a strict UI reviewer. */
  const reviewScreenshot = async (png: Uint8Array): Promise<string | null> => {
    const reviewer = opts.candidates.find((c) => c.vision);
    if (!reviewer) return null;
    try {
      const adapter = getProviderAdapter(reviewer.slug);
      const apiKey = await getWorkingKeyForProvider(reviewer.slug);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are a strict UI QA reviewer looking at a screenshot of a web page that was just built. Reply with exactly the single word OK if the page looks polished, correctly styled and fits the request. " +
            "Otherwise list the concrete visual defects as short bullet points (max 8), each with the most likely cause when you can tell — e.g. layout/spacing/container styles not applied (CSS file not imported or Tailwind classes not generated), content hugging the left edge with no padding, text overflowing or overlapping, broken/missing images, unreadable contrast, empty sections, a blank page, unstyled default browser look. Do not praise; do not restate the request.",
        },
        {
          role: "user",
          content: `The user asked for: ${userRequest.slice(0, 600)}\n\nReview this screenshot of the page rendered at 1280px wide.`,
          images: [{ mime: "image/png", dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}` }],
        },
      ];
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("review timed out")), 60_000));
      const reply = await Promise.race([adapter.chat(apiKey, reviewer.modelId, messages), timeout]);
      usage = mergeTokenUsage(usage, estimateTokenUsageFromText(3000, reply.length));
      return reply.trim();
    } catch (err) {
      console.error("[build] visual review failed:", err instanceof Error ? err.message : err);
      return null;
    }
  };

  /** Runs the page in a real browser and reviews the result. Returns a problem report, or "" if fine. */
  const qualityGate = async (): Promise<string> => {
    if (!last.start || visualRounds >= budget.visualRounds || signal?.aborted) return "";
    visualRounds++;
    const step: BuildStep = { id: `s${++stepSeq}`, kind: "run", label: "Checking how it looks in a browser", state: "running" };
    steps.push(step);
    onEvent({ t: "step", ...step });
    const problems: string[] = [];
    let detail = "";
    try {
      const shot = await box.screenshot(last.start.port);
      if (shot.note) detail = shot.note;
      if (shot.consoleErrors.length) problems.push(`Browser console errors:\n${shot.consoleErrors.join("\n")}`);
      if (shot.bodyTextLength === 0) problems.push("The page renders completely blank (no visible text at all).");
      if (shot.png) {
        const review = await reviewScreenshot(shot.png);
        if (review && !/^\s*ok\b/i.test(review)) problems.push(`Visual review of the rendered page:\n${review}`);
        detail = review ? `Reviewer: ${review}` : detail;
      }
    } catch (err) {
      detail = `check skipped: ${err instanceof Error ? err.message : "failed"}`;
    }
    step.state = problems.length ? "error" : "ok";
    step.detail = tail(problems.join("\n\n") || detail || "Looks good", 700);
    onEvent({ t: "step", ...step });
    return problems.join("\n\n");
  };

  // ---- Planning phase: architecture + todo checklist, drafted before any code is written. ----
  let plan: BuildPlan | null = null;
  const emitPlan = () => {
    if (!plan) return;
    build.plan = plan;
    onEvent({ t: "plan", architecture: plan.architecture, items: plan.items.map((i) => ({ ...i })) });
  };
  const applyProgress = (body: string) => {
    if (!plan) return;
    const lines = body.split("\n").map((l) => l.trim()).filter((l) => /^[-*]\s*\[[ xX~]\]/.test(l));
    if (lines.length === 0) return;
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    lines.forEach((line, i) => {
      const mark = line.match(/\[([ xX~])\]/)![1]!;
      const text = line.replace(/^[-*]\s*\[[ xX~]\]\s*/, "");
      let idx = plan!.items.findIndex((it) => norm(it.text) === norm(text) || norm(it.text).startsWith(norm(text).slice(0, 24)));
      if (idx === -1 && lines.length === plan!.items.length) idx = i;
      if (idx === -1) return;
      plan!.items[idx]!.state = mark === "~" ? "doing" : mark === " " ? "todo" : "done";
    });
    emitPlan();
  };
  // A short follow-up on an existing project ("run it", "fix the header") needs no plan card.
  const smallFollowUp =
    existingFiles.length > 0 &&
    userRequest.length <= 160 &&
    !/\b(build|create|implement|redesign|rewrite|from scratch|integrate|add (a |an )?(new )?(page|feature|module|system|auth|login|dashboard|database))\b/i.test(userRequest);
  try {
    const planner = smallFollowUp || isSubagent ? null : opts.candidates[0];
    if (planner) {
      const adapter = getProviderAdapter(planner.slug);
      const apiKey = await getWorkingKeyForProvider(planner.slug);
      const planMessages: ChatMessage[] = [
        { role: "system", content: `${PLAN_PROMPT}\n\n${stateNote}` },
        ...opts.history.filter((m) => m.role !== "system").slice(-6),
      ];
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("planning timed out")), 75_000));
      const planText = await Promise.race([adapter.chat(apiKey, planner.modelId, planMessages), timeout]);
      usage = mergeTokenUsage(usage, estimateTokenUsageFromText(planMessages.reduce((n, m) => n + m.content.length, 0), planText.length));
      const architecture = planText.match(/<architecture>([\s\S]*?)<\/architecture>/i)?.[1]?.trim() ?? "";
      const items = [...planText.matchAll(/^\s*[-*]\s*\[[ xX~]?\]\s*(.+)$/gm)].map((m) => m[1]!.trim()).filter(Boolean).slice(0, 12);
      if (items.length >= 2) {
        plan = { architecture, items: items.map((text, i) => ({ text, state: i === 0 ? "doing" : "todo" })) };
        emitPlan();
        conversation[0] = {
          role: "system",
          content: `${conversation[0]!.content}\n\nAPPROVED PLAN\nArchitecture:\n${architecture || "(none)"}\nTodo:\n${items.map((t) => `- [ ] ${t}`).join("\n")}`,
        };
      }
    }
  } catch (err) {
    console.error("[build] planning skipped:", err instanceof Error ? err.message : err);
  }

  // Plan mode: don't touch the sandbox until the user explicitly approves the drafted plan.
  if (mode === "plan" && plan && !project?.plan_approved && !isSubagent) {
    const approved = await requestApproval({ kind: "plan", label: "Approve the plan to start building" });
    if (!approved) {
      return { text: visibleText, build, usage, candidate: usedCandidate, error: "Plan rejected — nothing was built yet." };
    }
    await saveProject(userId, conversationId, { plan_approved: true });
  }

  // Save the project to our database as work progresses (not only at the end) so a dropped connection
  // or an early-killed sandbox never loses what was already written.
  let snapshotting = false;
  let lastSnapshotAt = 0;
  let writesSinceSnapshot = 0;
  const saveProgress = async (force = false) => {
    // Sub-agents share one sandbox/build_projects row with siblings — only the coordinator
    // snapshots, so concurrent runs never race writing the same row.
    if (isSubagent || snapshotting || (!force && Date.now() - lastSnapshotAt < 20_000)) return;
    snapshotting = true;
    try {
      await box.snapshot(last.start?.cmd, last.start?.port);
      lastSnapshotAt = Date.now();
      writesSinceSnapshot = 0;
    } catch {
      /* best-effort */
    } finally {
      snapshotting = false;
    }
  };

  const seenErrors = new Map<string, number>();
  const reflected = new Set<string>();
  let finalDone: string | null = null;
  let nudges = 0;
  let donePushbacks = 0;
  let appBroken = false;
  // Last outcome per command: a build that failed and was never re-run successfully is unresolved.
  const lastRunState = new Map<string, "ok" | "error">();

  for (let iteration = 1; iteration <= budget.iterations; iteration++) {
    if (signal?.aborted) break;
    if (Date.now() - started > budget.wallMs) {
      emitText("\n\nI ran out of time before finishing — send another message and I'll continue from where the project stands.");
      break;
    }

    const turn: Iteration = { assistantText: "", results: [], done: null, anyAction: false };
    let chain: Promise<void> = Promise.resolve();

    let liveStep: BuildStep | null = null;
    const runAction = async (action: BuildAction) => {
      turn.anyAction = true;
      if (action.kind === "done") {
        turn.done = action.summary;
        return;
      }
      if (action.kind === "progress") {
        applyProgress(action.body);
        return;
      }
      if (action.kind === "malformed") {
        if (liveStep) {
          liveStep.state = "error";
          liveStep.detail = action.reason;
          onEvent({ t: "step", ...liveStep });
          liveStep = null;
        }
        turn.results.push(`[error] ${action.reason}. Re-send that action correctly (split very large files if needed).`);
        return;
      }
      const meta = describe(action)!;
      if (shouldPauseFor(action, mode)) {
        const detail = action.kind === "run" || action.kind === "start" ? action.cmd : action.kind === "pr" ? action.body : undefined;
        const approved = await requestApproval({ kind: action.kind, label: meta.label, detail });
        if (!approved) {
          const step: BuildStep = { id: `s${++stepSeq}`, kind: meta.kind, label: `${meta.label} — skipped (rejected)`, state: "error" };
          steps.push(step);
          onEvent({ t: "step", ...step });
          turn.results.push(`[${action.kind}] skipped: the user rejected this action.`);
          return;
        }
      }
      // Reuse the row that was already shown live while the model was still writing this action.
      let step: BuildStep;
      if (liveStep && liveStep.kind === meta.kind) {
        step = liveStep;
        liveStep = null;
        step.label = meta.label;
      } else {
        step = { id: `s${++stepSeq}`, kind: meta.kind, label: meta.label, state: "running" };
        steps.push(step);
      }
      onEvent({ t: "step", ...step });
      const finish = (state: "ok" | "error", detail?: string) => {
        step.state = state;
        if (detail) step.detail = tail(detail, 700);
        onEvent({ t: "step", ...step });
      };

      try {
        if (action.kind === "write") {
          const path = guardPath(action.path);
          if (!path) {
            finish("error", opts.pathPrefix ? `Path must be inside ${opts.pathPrefix}/` : "Path is outside the project");
            turn.results.push(
              `[write ${action.path}] rejected: ${opts.pathPrefix ? `this workstream may only write under ${opts.pathPrefix}/` : "path must be relative and inside the project"}.`,
            );
            return;
          }
          await box.write(path, action.content);
          finish("ok");
          if (++writesSinceSnapshot >= 6) void saveProgress();
          turn.results.push(`[write ${path}] ok (${action.content.length} chars)`);
        } else if (action.kind === "edit") {
          const path = guardPath(action.path);
          const current = path ? await box.read(path).catch(() => null) : null;
          if (!path || current == null) {
            finish("error", path ? "File not found" : "Path is outside the project");
            turn.results.push(`[edit ${action.path}] failed: ${path ? "file not found — use <friday-write> to create it" : "path must be inside the project"}`);
            return;
          }
          const applied = applySearchReplace(current, action.edits);
          if (!applied.ok) {
            finish("error", applied.error);
            turn.results.push(`[edit ${path}] failed: ${applied.error}. Nothing was changed.`);
            return;
          }
          await box.write(path, applied.content);
          finish("ok");
          if (++writesSinceSnapshot >= 6) void saveProgress();
          turn.results.push(`[edit ${path}] ok (${action.edits.length} change${action.edits.length === 1 ? "" : "s"} applied)`);
        } else if (action.kind === "grep") {
          const path = action.path === "." ? "." : safeProjectPath(action.path);
          if (!path) {
            finish("error", "Path is outside the project");
            turn.results.push(`[grep] path must be inside the project`);
            return;
          }
          // Pattern/path travel as env vars through a script file: no shell quoting can break them.
          const out = await box.runScript(
            'grep -rnIE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next -e "$FRIDAY_PATTERN" -- "$FRIDAY_PATH" | head -150',
            60_000,
            { FRIDAY_PATTERN: action.pattern, FRIDAY_PATH: path },
          );
          finish("ok");
          turn.results.push(`[grep ${JSON.stringify(action.pattern)} in ${path}]\n${tail(out.output.trim() || "(no matches)", 6000)}`);
        } else if (action.kind === "ls") {
          const path = action.path === "." ? "." : safeProjectPath(action.path);
          if (!path) {
            finish("error", "Path is outside the project");
            turn.results.push(`[ls] path must be inside the project`);
            return;
          }
          const out = await box.runScript(
            'find "$FRIDAY_PATH" -maxdepth 3 -not -path "*/node_modules*" -not -path "*/.git/*" -not -path "*/.git" -not -path "*/dist/*" | sort | head -400',
            30_000,
            { FRIDAY_PATH: path },
          );
          finish(out.ok ? "ok" : "error");
          turn.results.push(`[ls ${path}]\n${tail(out.output.trim() || "(empty)", 6000)}`);
        } else if (action.kind === "pr") {
          if (isSubagent) {
            finish("error", "Sub-agents don't open pull requests — the coordinator does, once everything is merged.");
            turn.results.push("[pr] skipped: only the coordinator opens the pull request.");
            return;
          }
          if (!project?.repo) {
            finish("error", "Not a GitHub project");
            turn.results.push("[pr] failed: this project was not imported from GitHub, so there is no repository to open a pull request against.");
            return;
          }
          const pr = await openPullRequest(box, userId, {
            repo: project.repo,
            base: project.repo_branch || "main",
            title: action.title,
            branch: action.branch,
            body: action.body,
          });
          finish(pr.ok ? "ok" : "error", pr.message);
          turn.results.push(`[pr] ${pr.ok ? "ok" : "failed"}: ${pr.message}`);
          if (pr.url) build.prUrl = pr.url;
        } else if (action.kind === "read") {
          const path = safeProjectPath(action.path);
          const content = path ? await box.read(path).catch(() => null) : null;
          if (content == null) {
            finish("error", "File not found");
            turn.results.push(`[read ${action.path}] not found`);
          } else {
            finish("ok");
            turn.results.push(`[read ${action.path}]\n${tail(content, 6000)}`);
          }
        } else if (action.kind === "run") {
          const out = await box.run(action.cmd, 5 * 60_000, signal);
          lastRunState.set(action.cmd, out.ok ? "ok" : "error");
          if (out.ok && /\b(install|add|ci)\b/.test(action.cmd)) void saveProgress(true);
          finish(out.ok ? "ok" : "error", out.output);
          turn.results.push(`[run ${JSON.stringify(action.cmd)}] exit ${out.exitCode}\n${tail(out.output)}`);
          if (!out.ok) {
            const key = `${action.cmd}::${tail(out.output, 300)}`;
            seenErrors.set(key, (seenErrors.get(key) ?? 0) + 1);
          }
        } else if (action.kind === "start") {
          if (isSubagent) {
            finish("error", "Sub-agents don't start the server — the coordinator starts it once everything is merged.");
            turn.results.push("[start] skipped: only the coordinator starts the server, after every workstream is done.");
            return;
          }
          const res = await box.start(action.cmd, action.port);
          if (res.ready && res.url) {
            last.start = { cmd: action.cmd, port: action.port };
            void saveProgress(true);
            build.previewUrl = res.url;
            build.port = action.port;
            onEvent({ t: "preview", url: res.url, port: action.port });
            // The port answering isn't proof the app works — crawl it and surface real errors.
            const problems = await box.probeApp(action.port);
            if (problems) {
              finish("error", `The server is up but the app fails to load:\n${problems}`);
              turn.results.push(
                `[start ${JSON.stringify(action.cmd)}] server is listening on port ${action.port} BUT the app is BROKEN — requesting its files fails:\n${tail(problems, 2500)}\nServer log:\n${tail(res.log, 1500)}\nFix the cause (check dependency versions/config), then <friday-start> again.`,
              );
              const key = `probe::${tail(problems, 300)}`;
              seenErrors.set(key, (seenErrors.get(key) ?? 0) + 1);
              appBroken = true;
            } else {
              appBroken = false;
              finish("ok", res.log);
              turn.results.push(`[start ${JSON.stringify(action.cmd)}] ready — serving on port ${action.port}; all pages/scripts/styles load without errors\n${tail(res.log, 1500)}`);
            }
          } else {
            finish("error", res.log || "The server did not respond in time");
            turn.results.push(`[start ${JSON.stringify(action.cmd)}] NOT ready after 90s. Server log:\n${tail(res.log)}`);
            const key = `start::${tail(res.log, 300)}`;
            seenErrors.set(key, (seenErrors.get(key) ?? 0) + 1);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "action failed";
        finish("error", message);
        turn.results.push(`[${action.kind}] failed: ${message}`);
        // write/edit/read/grep/ls/pr failures used to never reach seenErrors (only run/start did),
        // so a broken sandbox connection could fail every single write in a turn — 15 in a row,
        // confirmed in production 2026-09-26 — with no "step back" reflection and no early stop.
        // Sandbox.ts now auto-reconnects once on that specific error; this is the fallback for
        // anything that still fails repeatedly (e.g. E2B itself unreachable).
        const key = `${action.kind}::${"path" in action ? action.path : ""}::${tail(message, 200)}`;
        seenErrors.set(key, (seenErrors.get(key) ?? 0) + 1);
      }
    };

    let pendingText = "";
    let actionsSeen = 0;
    const parser = new ActionParser(
      (text) => {
        turn.assistantText += text;
        pendingText += text;
      },
      (action) => {
        actionsSeen++;
        // Prose written before this action is narration → a note row, in order with the steps.
        const narration = pendingText;
        pendingText = "";
        // Serialised so notes / file writes / installs / starts always appear in the order the model wrote them.
        chain = chain.then(() => {
          if (action.kind !== "done") pushNote(narration);
          else if (narration.trim()) turn.doneLead = narration;
          return runAction(action);
        });
      },
      (name, a) => {
        // Show what is happening the moment the model starts it — big files take a while to generate.
        const narration = pendingText;
        pendingText = "";
        chain = chain.then(() => {
          pushNote(narration);
          const label =
            name === "write" ? `Writing ${a.path ?? "file"}…` : name === "start" ? a.desc || "Starting server…" : a.desc || "Running command…";
          const step: BuildStep = { id: `s${++stepSeq}`, kind: name as BuildStep["kind"], label, state: "running" };
          steps.push(step);
          liveStep = step;
          onEvent({ t: "step", ...step });
        });
      },
    );

    // Same fall-through the normal chat path uses: first candidate that produces output wins.
    let raw = "";
    let modelError: string | undefined;
    const order: ChatCandidate[] = usedCandidate ? [usedCandidate, ...opts.candidates.filter((c) => c !== usedCandidate)] : opts.candidates;
    for (const candidate of order) {
      try {
        const adapter = getProviderAdapter(candidate.slug);
        const apiKey = await getWorkingKeyForProvider(candidate.slug);
        let providerUsage: TokenUsage | null = null;
        const onDelta = (delta: string) => {
          raw += delta;
          parser.feed(delta);
        };
        if (adapter.chatStream) {
          await adapter.chatStream(apiKey, candidate.modelId, conversation, onDelta, signal, undefined, (u) => {
            providerUsage = u;
          });
        } else {
          onDelta(await adapter.chat(apiKey, candidate.modelId, conversation));
        }
        usage = mergeTokenUsage(
          usage,
          providerUsage ?? estimateTokenUsageFromText(conversation.reduce((n, m) => n + m.content.length, 0), raw.length),
        );
        usedCandidate = candidate;
        modelError = undefined;
        break;
      } catch (err) {
        modelError = `${candidate.slug}: ${err instanceof Error ? err.message : "failed"}`;
        if (raw) break; // already streamed part of this turn — can't silently switch models mid-reply
      }
    }
    parser.end();
    await chain;
    if (liveStep) {
      (liveStep as BuildStep).state = "error";
      onEvent({ t: "step", ...(liveStep as BuildStep) });
      liveStep = null;
    }
    if (process.env.FRIDAY_BUILD_DEBUG) console.log(`[build debug] iteration ${iteration} raw (${raw.length} chars):\n${raw.slice(0, 1800)}\n---`);
    // Text after the last action of a turn: narration if the turn did things, otherwise the model is
    // answering directly (a plain reply) and this is final content.
    const trailing = pendingText;
    pendingText = "";
    if (trailing.trim()) {
      if (actionsSeen > 0) pushNote(trailing);
      else turn.plainReply = trailing;
    }

    if (modelError && !raw) {
      return { text: visibleText, build, usage, candidate: usedCandidate, error: modelError };
    }
    if (signal?.aborted) break;

    if (turn.done !== null) {
      // Don't accept "done" while something is known to be broken — push back a few times first.
      const failedCmds = [...lastRunState.entries()].filter(([, state]) => state === "error").map(([cmd]) => cmd);
      // Last gate before "done": actually look at the page in a browser (and have a vision model review it).
      const gateProblems = !appBroken && failedCmds.length === 0 && donePushbacks < 3 ? await qualityGate() : "";
      if ((appBroken || failedCmds.length > 0 || gateProblems) && donePushbacks < 3) {
        donePushbacks++;
        conversation.push({ role: "assistant", content: compactAssistantTurn(raw) });
        conversation.push({
          role: "user",
          content:
            `<results>\n${turn.results.join("\n\n")}\n</results>\n` +
            `You said you're done, but something is still failing${appBroken ? " (the running app does not load cleanly)" : ""}${failedCmds.length ? `; these commands last failed: ${failedCmds.map((c) => JSON.stringify(c)).join(", ")}` : ""}. ` +
            (gateProblems ? `\n<review>\n${gateProblems}\n</review>\n` : "") +
            "Find the root cause, fix it, re-run/re-start, and only finish with <friday-done> after it genuinely works and looks right.",
        });
        continue;
      }
      finalDone = turn.done;
      if (plan) {
        plan.items.forEach((item) => (item.state = "done"));
        emitPlan();
      }
      break;
    }
    if (!turn.anyAction) {
      // Some models write the files and then just describe how the USER can run them. Nothing has
      // actually been executed yet — push back (a few times) instead of accepting that as done.
      const ranSomething = steps.some((st) => (st.kind === "run" || st.kind === "start") && st.state === "ok");
      const wroteNothing = steps.every((st) => st.kind === "note");
      if (!ranSomething && nudges < 4) {
        nudges++;
        if (turn.plainReply) pushNote(turn.plainReply);
        conversation.push({ role: "assistant", content: compactAssistantTurn(raw) });
        conversation.push({
          role: "user",
          content:
            wroteNothing
              ? "Your last reply contained NO action tags, so nothing was executed — no files exist yet. Do the work now: emit the actions as plain text tags exactly like <friday-write path=\"package.json\">…</friday-write> and <friday-run desc=\"Install dependencies\">npm install</friday-run>. These are ordinary text tags in your reply, not function/tool calls. Start writing the files now."
              : "You have not run anything yet. Do not tell me to run commands — execute them yourself now with <friday-run> (install dependencies) and <friday-start> (start the server), check the output, fix errors, and only then finish with <friday-done>.",
        });
        continue;
      }
      if (turn.plainReply) emitText(turn.plainReply.trim());
      break; // plain reply, nothing left to do
    }

    if ([...seenErrors.values()].some((n) => n >= STUCK_REPEATS)) {
      emitText("I kept hitting the same error even after changing approach several times, so I'm stopping here rather than looping. The steps above show exactly where it fails — tell me how you'd like to proceed and I'll continue from the current state.");
      break;
    }
    // Recall/reflect: the same failure twice means the current approach isn't working. Instead of
    // repeating it, force a step back — diagnose the real cause and pick a different route.
    const repeating = [...seenErrors.entries()].filter(([key, n]) => n >= REFLECT_AT && !reflected.has(key));
    let reflection = "";
    if (repeating.length > 0) {
      repeating.forEach(([key]) => reflected.add(key));
      reflection =
        "\n\nSTOP — this same failure has now happened repeatedly, so repeating the same fix will not work. Step back like a debugger: (1) state what you have tried and why it did not work, (2) form a hypothesis about the TRUE root cause (wrong dependency version? config/import path? port clash? missing file? bad syntax you cannot see?), (3) inspect real evidence with <friday-read>/<friday-run> (package versions, config files, logs, the exact failing file), then (4) apply a genuinely DIFFERENT fix — or simplify that part of the design if needed.";
    }

    conversation.push({ role: "assistant", content: compactAssistantTurn(raw) });
    conversation.push({
      role: "user",
      content:
        `<results>\n${turn.results.join("\n\n") || "(no results)"}\n</results>\n` +
        `Continue with the plan. Fix anything that failed. When the project runs correctly, finish with <friday-done>.${reflection}`,
    });
  }

  if (finalDone) emitText(`${visibleText.trim() ? "\n\n" : ""}${finalDone}`);
  else if (!visibleText.trim() && steps.length > 0) emitText("Here is where the project stands — see the steps above.");

  // A sub-agent's workstream isn't the whole project — the coordinator (a plain, non-subagent run
  // sharing the same sandbox) does the final snapshot/zip and owns the sandbox's lifecycle.
  if (!isSubagent) {
    // Persist a restorable snapshot (files + how to start it) so the preview survives sandbox expiry.
    try {
      const files = await box.snapshot(last.start?.cmd, last.start?.port);
      const paths = Object.keys(files);
      if (paths.length > 0) {
        const zip = new JSZip();
        for (const path of paths) zip.file(path, files[path]!);
        build.zipBytes = (await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })).length;
        let name = "project";
        try {
          const pkgName = (JSON.parse(files["package.json"] ?? "{}") as { name?: string }).name;
          if (pkgName) name = pkgName.replace(/[^\w.-]+/g, "-");
        } catch {
          /* no/invalid package.json — keep the default name */
        }
        build.zipName = `${name}.zip`;
      }
    } catch (err) {
      console.error("[build] snapshot failed:", err instanceof Error ? err.message : err);
    }

    // Nothing left running to preview → destroy the sandbox now. The files are safe in our database;
    // a sandbox that IS serving a preview expires (is killed, not paused) on its own TTL.
    if (!last.start) await box.kill();
  }

  build.elapsedMs = Date.now() - started;
  return { text: visibleText, build, usage, candidate: usedCandidate };
}
