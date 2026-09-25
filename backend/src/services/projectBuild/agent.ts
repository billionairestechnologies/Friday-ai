import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import { emptyTokenUsage, estimateTokenUsageFromText, mergeTokenUsage, type TokenUsage } from "../tokenUsage.js";
import type { BuildMeta, BuildStep, StreamEvent } from "../chat/types.js";
import { ActionParser, compactAssistantTurn, type BuildAction } from "./protocol.js";
import JSZip from "jszip";
import { BuildSandbox, PROJECT_DIR, getProject, safeProjectPath, tail } from "./sandbox.js";

const MAX_ITERATIONS = 30;
const MAX_WALL_MS = 14 * 60_000;
const STUCK_REPEATS = 3;

const BUILD_SYSTEM_PROMPT = `You are Friday's Build agent. You have a real Linux sandbox (Node.js LTS + npm, Python 3, git, curl, internet access) and you build the user's project inside it for real: write every file, install dependencies, run it, read the errors and fix them until it works. You are NOT limited to snippets — deliver a complete, runnable project with a proper folder structure.

ACTIONS — you act by writing these tags in your reply (they are executed for you, in order; the user sees each as a step):
<friday-write path="relative/path.ext">
full file contents (no markdown fences inside)
</friday-write>
<friday-run desc="Short user-facing label">shell command (waits for it to finish; use for npm install, builds, scripts, tests)</friday-run>
<friday-start port="5173" desc="Start the dev server">command that runs a long-lived server</friday-start>
<friday-read path="relative/path.ext"/>
<friday-done>Short summary for the user: what you built, how it is organised, how to use it.</friday-done>

RULES
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
- If the user asks to change/fix/extend an existing project, edit the existing files (read them first if needed) instead of starting over.`;

type Iteration = { assistantText: string; results: string[]; done: string | null; anyAction: boolean };

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
}): Promise<BuildAgentResult> {
  const { userId, conversationId, onEvent, signal } = opts;
  const started = Date.now();
  const steps: BuildStep[] = [];
  const build: BuildMeta = { steps };
  let usage = emptyTokenUsage();
  let usedCandidate: ChatCandidate | null = null;
  let visibleText = "";
  let stepSeq = 0;
  const last: { start: { cmd: string; port: number } | null } = { start: null };

  const emitText = (text: string) => {
    if (!text) return;
    visibleText += text;
    onEvent({ t: "text", c: text });
  };

  onEvent({ t: "status", s: "writing" });

  let box: BuildSandbox;
  try {
    box = await BuildSandbox.open(userId, conversationId);
  } catch (err) {
    return { text: "", build, usage, candidate: null, error: err instanceof Error ? err.message : "Couldn't start the sandbox" };
  }

  const project = await getProject(conversationId);
  const existingFiles = Object.keys(project?.files ?? {});
  const stateNote =
    existingFiles.length > 0
      ? `EXISTING PROJECT in ${PROJECT_DIR} (${existingFiles.length} files): ${existingFiles.slice(0, 60).join(", ")}${existingFiles.length > 60 ? ", …" : ""}.\n` +
        (box.fresh
          ? "The sandbox was just restored from a snapshot: node_modules is NOT installed and no server is running — reinstall and restart if you need to run it.\n"
          : "The sandbox is still alive: dependencies are probably installed and the dev server may still be running (restarting is fine).\n") +
        (project?.start_cmd ? `Last start command: ${project.start_cmd} (port ${project.port}).` : "")
      : "This is a new, empty project directory.";

  const conversation: ChatMessage[] = [
    { role: "system", content: `${BUILD_SYSTEM_PROMPT}\n\n${stateNote}` },
    ...opts.history.filter((m) => m.role !== "system"),
  ];

  const seenErrors = new Map<string, number>();
  let finalDone: string | null = null;
  let nudges = 0;
  let donePushbacks = 0;
  let appBroken = false;
  // Last outcome per command: a build that failed and was never re-run successfully is unresolved.
  const lastRunState = new Map<string, "ok" | "error">();

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (signal?.aborted) break;
    if (Date.now() - started > MAX_WALL_MS) {
      emitText("\n\nI ran out of time before finishing — send another message and I'll continue from where the project stands.");
      break;
    }

    const turn: Iteration = { assistantText: "", results: [], done: null, anyAction: false };
    let chain: Promise<void> = Promise.resolve();

    const runAction = async (action: BuildAction) => {
      turn.anyAction = true;
      if (action.kind === "done") {
        turn.done = action.summary;
        return;
      }
      if (action.kind === "malformed") {
        turn.results.push(`[error] ${action.reason}. Re-send that action correctly (split very large files if needed).`);
        return;
      }
      const meta = describe(action)!;
      const step: BuildStep = { id: `s${++stepSeq}`, kind: meta.kind, label: meta.label, state: "running" };
      steps.push(step);
      onEvent({ t: "step", ...step });
      const finish = (state: "ok" | "error", detail?: string) => {
        step.state = state;
        if (detail) step.detail = tail(detail, 700);
        onEvent({ t: "step", ...step });
      };

      try {
        if (action.kind === "write") {
          const path = safeProjectPath(action.path);
          if (!path) {
            finish("error", "Path is outside the project");
            turn.results.push(`[write ${action.path}] rejected: path must be relative and inside the project.`);
            return;
          }
          await box.write(path, action.content);
          finish("ok");
          turn.results.push(`[write ${path}] ok (${action.content.length} chars)`);
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
          finish(out.ok ? "ok" : "error", out.output);
          turn.results.push(`[run ${JSON.stringify(action.cmd)}] exit ${out.exitCode}\n${tail(out.output)}`);
          if (!out.ok) {
            const key = `${action.cmd}::${tail(out.output, 300)}`;
            seenErrors.set(key, (seenErrors.get(key) ?? 0) + 1);
          }
        } else if (action.kind === "start") {
          const res = await box.start(action.cmd, action.port);
          if (res.ready && res.url) {
            last.start = { cmd: action.cmd, port: action.port };
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
      }
    };

    const parser = new ActionParser(
      (text) => {
        turn.assistantText += text;
        emitText(text);
      },
      (action) => {
        // Serialised so file writes / installs / starts always run in the order the model wrote them.
        chain = chain.then(() => runAction(action));
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

    if (modelError && !raw) {
      return { text: visibleText, build, usage, candidate: usedCandidate, error: modelError };
    }
    if (signal?.aborted) break;

    if (turn.done !== null) {
      // Don't accept "done" while something is known to be broken — push back a few times first.
      const failedCmds = [...lastRunState.entries()].filter(([, state]) => state === "error").map(([cmd]) => cmd);
      if ((appBroken || failedCmds.length > 0) && donePushbacks < 3) {
        donePushbacks++;
        conversation.push({ role: "assistant", content: compactAssistantTurn(raw) });
        conversation.push({
          role: "user",
          content:
            `<results>\n${turn.results.join("\n\n")}\n</results>\n` +
            `You said you're done, but something is still failing${appBroken ? " (the running app does not load cleanly)" : ""}${failedCmds.length ? `; these commands last failed: ${failedCmds.map((c) => JSON.stringify(c)).join(", ")}` : ""}. ` +
            "Find the root cause, fix it, re-run/re-start, and only finish with <friday-done> after it genuinely works.",
        });
        emitText("\n\n");
        continue;
      }
      finalDone = turn.done;
      break;
    }
    if (!turn.anyAction) {
      // Some models write the files and then just describe how the USER can run them. Nothing has
      // actually been executed yet — push back (a few times) instead of accepting that as done.
      const ranSomething = steps.some((st) => (st.kind === "run" || st.kind === "start") && st.state === "ok");
      if (!ranSomething && steps.length > 0 && nudges < 3) {
        nudges++;
        conversation.push({ role: "assistant", content: compactAssistantTurn(raw) });
        conversation.push({
          role: "user",
          content:
            "You have not run anything yet. Do not tell me to run commands — execute them yourself now with <friday-run> (install dependencies) and <friday-start> (start the server), check the output, fix errors, and only then finish with <friday-done>.",
        });
        emitText("\n\n");
        continue;
      }
      break; // plain reply, nothing left to do
    }

    if ([...seenErrors.values()].some((n) => n >= STUCK_REPEATS)) {
      emitText("\n\nI keep hitting the same error and my fixes aren't changing it, so I'm stopping here rather than looping. The steps above show exactly where it fails.");
      break;
    }

    conversation.push({ role: "assistant", content: compactAssistantTurn(raw) });
    conversation.push({
      role: "user",
      content:
        `<results>\n${turn.results.join("\n\n") || "(no results)"}\n</results>\n` +
        "Continue. Fix anything that failed. When the project runs correctly, finish with <friday-done>.",
    });
    emitText("\n\n");
  }

  if (finalDone) emitText(`${visibleText.trim() ? "\n\n" : ""}${finalDone}`);

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

  build.elapsedMs = Date.now() - started;
  return { text: visibleText, build, usage, candidate: usedCandidate };
}
