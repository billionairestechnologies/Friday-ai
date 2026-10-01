import type { ToolCall, ToolSpec } from "../providers/toolCalling.js";
import { fetchUrlTool, webSearchTool } from "../agent/tools/web.js";
import type { BuildAction } from "./protocol.js";
import type { AskQuestion } from "../chat/types.js";

/**
 * Native (structured) tool definitions for the Build agent — the same actions as the `<friday-*>`
 * text protocol in protocol.ts, expressed as real function tools. Models are trained on structured
 * tool use (Claude Code, Codex, Cursor all run on it), so this path doesn't suffer the text
 * protocol's failure modes: tags cut off mid-file, tags quoted inside code fences, a model
 * "describing" the tags instead of emitting them. The text protocol stays as the fallback for
 * models without tool support or a provider that rejects the tools (see agent.ts).
 *
 * Every call is converted to a BuildAction so both paths share ONE executor, one set of safety
 * checks (safeProjectPath, env-passed grep args) and one QA gate.
 */

/** Extra action kinds only the native path has (the text protocol never emits them). */
export type NativeBuildAction =
  | BuildAction
  | { kind: "check" }
  /** Look something up on the web (docs, an error message, a library's current API) — same tools chat uses. */
  | { kind: "web"; tool: "web_search" | "fetch_url"; args: Record<string, unknown> }
  /** One of the user's connected-app or MCP tools (GitHub, Supabase, Vercel…) — run by the shared executor. */
  | { kind: "ext"; tool: string; args: Record<string, unknown> }
  /** The model needs an answer from the user before it can go on — ends the turn with a question card. */
  | { kind: "ask"; questions: AskQuestion[] }
  /** The model proposes a plan for the user to approve — ends the turn with a plan card. */
  | { kind: "plan"; summary: string; architecture: string; items: string[] };

/**
 * Tools that let the MODEL decide to talk to the user instead of working: ask a question, or put a
 * plan up for approval. They are only offered in the model-driven flow (agent.ts `modelDriven`),
 * where nothing forces a question or plan round before the agent runs — the model calls these
 * itself when a request really calls for it, the way Claude Code asks or enters plan mode.
 */
export const INTERACTION_TOOL_SPECS: ToolSpec[] = [
  {
    name: "ask_user",
    description:
      "Ask the user 1-4 multiple-choice questions and STOP until they answer. Use ONLY when a missing detail would change what " +
      "you build and you cannot reasonably choose a sensible default yourself (which exchange? real money or demo? login method?). " +
      "Never for greetings, small talk, questions you can answer, or details that don't change the outcome. Never ask a second " +
      "round if the user already answered one. Each question has 2-4 concrete options; put your recommendation FIRST.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1-4 questions",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The question, ending with a question mark" },
              options: {
                type: "array",
                description: "2-4 concrete answers the user could pick as-is; the first is your recommendation",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Short answer, e.g. a real suggested name or a concrete choice" },
                    description: { type: "string", description: "One line on what it means or why it's recommended" },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
  {
    name: "propose_plan",
    description:
      "Show the user a plan to approve BEFORE you write any code, and STOP until they approve or ask for changes. Use for a new " +
      "project or a large change where the request is clear enough to plan. Skip it for small fixes, follow-ups on an existing " +
      "project, questions and conversation — just do those. Never call it when an APPROVED PLAN is already shown to you.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "2-6 short plain-language lines: what will be built and its main features/screens" },
        architecture: { type: "string", description: "3-8 short lines: stack and why, folder structure, ports, main design decisions" },
        steps: { type: "array", description: "5-9 checklist items in execution order, one short line each; the last is 'Run it, verify it in a browser and fix any issues'", items: { type: "string" } },
      },
      required: ["summary", "steps"],
    },
  },
];

export const BUILD_TOOL_SPECS: ToolSpec[] = [
  {
    name: "write_file",
    description:
      "Create a file or completely overwrite it with new contents. Use for new files or full rewrites; for changes to an " +
      "existing file prefer edit_file. Write the full file — no placeholders like '// rest unchanged'. Keep a single file " +
      "under ~500 lines; split larger modules into several files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root, e.g. src/App.jsx" },
        content: { type: "string", description: "The complete file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one exact snippet in an existing file. old_string must match the file verbatim (copy it from read_file " +
      "output, including indentation) and must be unique — include a few surrounding lines if needed. For several changes " +
      "in one file, call edit_file several times.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
        old_string: { type: "string", description: "Exact text currently in the file" },
        new_string: { type: "string", description: "Text to replace it with" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the project (up to the last ~6000 characters for very large files).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the project root" } },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files and folders (3 levels deep, node_modules/.git/dist excluded).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Folder relative to the project root; default is the root" } },
    },
  },
  {
    name: "grep",
    description: "Search file contents with an extended regex (like grep -rnE). Returns matching lines with file:line.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Extended regular expression" },
        path: { type: "string", description: "Folder or file to search; default is the whole project" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project root and wait for it to finish (5 minute limit). Use for installs, builds, " +
      "tests, linters, scripts and curl checks. Returns the exit code and output. NOT for long-running servers — use " +
      "start_server for those.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command" },
        description: { type: "string", description: "Short user-facing label, e.g. 'Install dependencies'" },
      },
      required: ["command"],
    },
  },
  {
    name: "start_server",
    description:
      "Start (or restart) a long-running server on a port, wait until it answers, then crawl it for load errors. " +
      "Restarting is just calling this again — the previous server is stopped for you.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command that runs the server in the foreground, e.g. npm run dev" },
        port: { type: "integer", description: "Port the server listens on (Vite 5173, API 4000, …)" },
        description: { type: "string", description: "Short user-facing label" },
      },
      required: ["command", "port"],
    },
  },
  {
    name: "check_app",
    description:
      "Open the running app in a real headless browser: returns browser console errors, whether the page is blank, " +
      "and a visual review of a screenshot. Use after start_server to verify the app actually works and looks right.",
    parameters: { type: "object", properties: {} },
  },
  {
    ...webSearchTool.spec,
    description:
      "Search the web — for a library's current docs/API, the right package version, or an error message you don't " +
      "recognise. Returns titles, URLs and snippets; follow up with fetch_url to read a page in full.",
  },
  {
    ...fetchUrlTool.spec,
    description: "Read a public web page (docs, a GitHub README, a changelog, an issue) as text.",
  },
  {
    name: "update_progress",
    description:
      "Update the plan checklist the user sees. Send every plan item, same order and wording, each prefixed with " +
      "- [x] (done), - [~] (in progress) or - [ ] (todo), one per line.",
    parameters: {
      type: "object",
      properties: { checklist: { type: "string", description: "The full checklist, one item per line" } },
      required: ["checklist"],
    },
  },
  {
    name: "open_pull_request",
    description:
      "ONLY for a project imported from GitHub and ONLY when the user asked for a pull request: commit the changes to a " +
      "new branch and open a PR.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short PR title" },
        branch: { type: "string", description: "New branch name, e.g. friday/dark-mode" },
        body: { type: "string", description: "What changed and why" },
      },
      required: ["title", "branch", "body"],
    },
  },
  {
    name: "finish",
    description:
      "Call exactly once, when the project genuinely works (you saw it run and pass your checks). Friday verifies it " +
      "(build/tests/browser) before accepting; if something still fails you'll get the problems back to fix.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Well-structured markdown summary for the user: what was built, how it's organised, how to use it",
        },
      },
      required: ["summary"],
    },
  },
];

function s(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** Cleans the model's ask_user arguments into the question cards the client renders (same limits as clarify.ts). */
export function parseAskQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw.slice(0, 4)) {
    if (!q || typeof q !== "object") continue;
    const rec = q as { question?: unknown; options?: unknown };
    const question = typeof rec.question === "string" ? rec.question.trim().slice(0, 200) : "";
    const options = (Array.isArray(rec.options) ? rec.options : [])
      .map((o) => (o && typeof o === "object" ? (o as { label?: unknown; description?: unknown }) : null))
      .filter((o): o is { label?: unknown; description?: unknown } => o !== null && typeof o.label === "string" && o.label.trim() !== "")
      .slice(0, 4)
      .map((o, i) => ({
        label: String(o.label).trim().slice(0, 80),
        description: typeof o.description === "string" && o.description.trim() ? o.description.trim().slice(0, 160) : undefined,
        recommended: i === 0,
      }));
    if (question && options.length >= 2) out.push({ id: `q${out.length + 1}`, question, options });
  }
  return out;
}

/** Converts one native tool call into the shared BuildAction the executor runs. */
export function toolCallToAction(call: ToolCall, extTools?: ReadonlySet<string>): NativeBuildAction {
  const a = call.args ?? {};
  switch (call.name) {
    case "write_file": {
      const path = s(a, "path").trim();
      if (!path) return { kind: "malformed", reason: "write_file is missing its path" };
      // A reply cut off by the output-token limit arrives as unparseable JSON → empty args.
      if (typeof a.content !== "string") {
        return { kind: "malformed", reason: `write_file for ${path} has no content (the file may have been too long for one reply — split it into smaller files)` };
      }
      return { kind: "write", path, content: a.content };
    }
    case "edit_file": {
      const path = s(a, "path").trim();
      if (!path) return { kind: "malformed", reason: "edit_file is missing its path" };
      if (typeof a.old_string !== "string" || typeof a.new_string !== "string") {
        return { kind: "malformed", reason: "edit_file needs old_string and new_string" };
      }
      return { kind: "edit", path, edits: [{ search: a.old_string, replace: a.new_string }] };
    }
    case "read_file": {
      const path = s(a, "path").trim();
      return path ? { kind: "read", path } : { kind: "malformed", reason: "read_file is missing its path" };
    }
    case "list_files":
      return { kind: "ls", path: s(a, "path").trim() || "." };
    case "grep": {
      const pattern = s(a, "pattern");
      return pattern ? { kind: "grep", pattern, path: s(a, "path").trim() || "." } : { kind: "malformed", reason: "grep is missing its pattern" };
    }
    case "run_command": {
      const cmd = s(a, "command").trim();
      return cmd ? { kind: "run", cmd, desc: s(a, "description").trim() || cmd.slice(0, 60) } : { kind: "malformed", reason: "run_command is missing its command" };
    }
    case "start_server": {
      const cmd = s(a, "command").trim();
      const port = Number(a.port);
      if (!cmd) return { kind: "malformed", reason: "start_server is missing its command" };
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: "malformed", reason: "start_server needs a numeric port" };
      return { kind: "start", cmd, port, desc: s(a, "description").trim() || `Start server on port ${port}` };
    }
    case "check_app":
      return { kind: "check" };
    case "web_search":
      return s(a, "query").trim() ? { kind: "web", tool: "web_search", args: a } : { kind: "malformed", reason: "web_search is missing its query" };
    case "fetch_url":
      return s(a, "url").trim() ? { kind: "web", tool: "fetch_url", args: a } : { kind: "malformed", reason: "fetch_url is missing its url" };
    case "update_progress":
      return { kind: "progress", body: s(a, "checklist") };
    case "open_pull_request": {
      const title = s(a, "title").trim();
      return title ? { kind: "pr", title, branch: s(a, "branch").trim(), body: s(a, "body").trim() } : { kind: "malformed", reason: "open_pull_request is missing its title" };
    }
    case "finish":
      return { kind: "done", summary: s(a, "summary").trim() };
    case "ask_user": {
      const questions = parseAskQuestions(a.questions);
      return questions.length ? { kind: "ask", questions } : { kind: "malformed", reason: "ask_user needs at least one question with 2-4 options" };
    }
    case "propose_plan": {
      const items = (Array.isArray(a.steps) ? a.steps : [])
        .map((x) => (typeof x === "string" ? x.replace(/^\s*[-*]\s*(\[[ xX~]\]\s*)?/, "").trim() : ""))
        .filter(Boolean)
        .slice(0, 12);
      if (items.length < 2) return { kind: "malformed", reason: "propose_plan needs at least 2 steps" };
      return { kind: "plan", summary: s(a, "summary").trim(), architecture: s(a, "architecture").trim(), items };
    }
    default:
      if (extTools?.has(call.name)) return { kind: "ext", tool: call.name, args: a };
      return { kind: "malformed", reason: `there is no tool named ${call.name}` };
  }
}

/**
 * Older assistant turns carry whole file bodies in their write_file/edit_file arguments; resending
 * them every round is the main thing that blows the context window (and the bill) on long builds.
 * Replace them with a marker — the model can read_file anything it needs again. The most recent
 * `keepLast` assistant turns stay intact (Gemini validates thought signatures on the current turn).
 */
export function compactToolCallArgs<M extends { role: string; toolCalls?: ToolCall[] }>(messages: M[], keepLast = 2): void {
  const assistantIdx = messages.map((m, i) => (m.role === "assistant" && m.toolCalls?.length ? i : -1)).filter((i) => i >= 0);
  for (const i of assistantIdx.slice(0, Math.max(0, assistantIdx.length - keepLast))) {
    for (const call of messages[i]!.toolCalls!) {
      if (call.name === "write_file" && typeof call.args.content === "string" && call.args.content.length > 200) {
        call.args = { ...call.args, content: `(${call.args.content.length} chars omitted — already written; read_file to see it)` };
      } else if (call.name === "edit_file" && typeof call.args.old_string === "string" && call.args.old_string.length + String(call.args.new_string ?? "").length > 400) {
        call.args = { ...call.args, old_string: "(omitted — edit already applied)", new_string: "(omitted)" };
      }
    }
  }
}
