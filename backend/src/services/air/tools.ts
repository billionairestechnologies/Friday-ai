import type { FridayTool } from "../agent/tools/types.js";
import { str } from "../agent/tools/types.js";
import { approvalOpen, consumeApproval, isLeaving, recordAction, type GateKind } from "./gate.js";
import { reportFromModel, runningJobFor } from "./jobs.js";

/**
 * What an Air Dots turn gets on top of the normal toolset:
 *   - air_report: the model says where the job stands (working / done / blocked / needs_login /
 *     needs_approval). The job loop reads it instead of guessing from words in the reply.
 *   - every other tool is wrapped by the gate: recorded in air_actions, and a leaving action (pay, buy,
 *     book, send, post, delete) is refused until the person says yes.
 * Only conversations with origin = 'air' get this (chat/index.ts).
 */

const REPORT_STATUSES = ["working", "done", "blocked", "needs_login", "needs_approval"] as const;
type ReportStatus = (typeof REPORT_STATUSES)[number];

export function airReportTool(): FridayTool {
  return {
    spec: {
      name: "air_report",
      description:
        "Report where this Air Dots job stands. Call it exactly once at the end of every turn. " +
        "'working' = more to do, you get another turn. 'done' = finished. 'blocked' = you cannot continue. " +
        "'needs_login' = a site needs the person to sign in on the screen. 'needs_approval' = the next step pays, buys, books, sends, posts or deletes.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...REPORT_STATUSES] },
          summary: { type: "string", description: "One or two short sentences: what you did and what you found." },
          needs: { type: "string", description: "For needs_login / needs_approval / blocked: exactly what you need from the person." },
        },
        required: ["status", "summary"],
      },
    },
    label: (args) => {
      const s = str(args, "status");
      return s === "done" ? "Finished the job" : s === "working" ? "Still working" : s === "needs_login" ? "Needs you to sign in" : s === "needs_approval" ? "Waiting for your yes" : "Stuck";
    },
    run: async (args, ctx) => {
      const status = str(args, "status") as ReportStatus;
      if (!REPORT_STATUSES.includes(status)) return "Error: status must be one of working, done, blocked, needs_login, needs_approval.";
      const jobId = await reportFromModel(ctx.conversationId, { status, summary: str(args, "summary") || "(no summary)", needs: str(args, "needs") || null });
      if (!jobId) return "Noted (no Air Dots job is running for this chat — just answer normally).";
      return status === "working" ? "Noted. You'll get another turn." : "Noted. Stop here; Friday will tell the person.";
    },
  };
}

/** Which gate bucket a tool belongs to. */
export function gateKindFor(toolName: string): GateKind {
  if (toolName === "browser") return "browser";
  if (toolName === "run_code") return "shell";
  if (/^(create_document|create_page|update_page)$/.test(toolName)) return "file";
  if (/^(web_search|fetch_url|search_project_files|read_page|use_skill|memory_|recall|remember|generate_image|research_in_parallel)/.test(toolName)) return "tool";
  return "connector";
}

/** The browser addresses elements by number; the gate needs the button's words ("Place order"). */
const lastElements = new Map<string, Map<string, string>>();

export function rememberElements(conversationId: string, snapshotText: string) {
  const map = new Map<string, string>();
  for (const line of snapshotText.split("\n")) {
    const m = /^\[(\d+)\]\s+(.*)$/.exec(line.trim());
    if (m) map.set(m[1]!, m[2]!.slice(0, 200));
  }
  if (map.size) lastElements.set(conversationId, map);
}

export function describeAction(toolName: string, args: Record<string, unknown>, conversationId: string): string {
  if (toolName === "browser") {
    const action = str(args, "action");
    const ref = str(args, "ref");
    const element = ref ? lastElements.get(conversationId)?.get(ref) ?? `element ${ref}` : "";
    const extra = action === "open" ? str(args, "url") : action === "type" ? `${element} ← (text)` : action === "press" ? str(args, "key") : element;
    // An Enter in a form submits it: judge it by the element the form was typed into last.
    return `${action} ${extra}`.trim();
  }
  if (toolName === "run_code") return str(args, "code").slice(0, 600);
  return JSON.stringify(args).slice(0, 600);
}

export function wrapForAir(tools: FridayTool[]): FridayTool[] {
  const wrapped = tools.map<FridayTool>((tool) => ({
    ...tool,
    run: async (args, ctx) => {
      const name = tool.spec.name;
      const kind = gateKindFor(name);
      const detail = describeAction(name, args, ctx.conversationId);
      const job = await runningJobFor(ctx.conversationId).catch(() => null);
      const base = { userId: ctx.userId, conversationId: ctx.conversationId, jobId: job?.id ?? null, kind, name };
      // Typing never leaves the account on its own; the click or Enter that submits it does.
      const judged = name === "browser" && str(args, "action") === "type" ? "" : detail;
      if (isLeaving(kind, name, judged)) {
        if (await approvalOpen(ctx.conversationId)) {
          await consumeApproval(ctx.conversationId);
          void recordAction({ ...base, detail, decision: "approved" });
        } else {
          void recordAction({ ...base, detail, decision: "refused" });
          return (
            `Not done: "${detail}" pays, sends, books, posts or deletes, and the person hasn't said yes. ` +
            `Call air_report with status needs_approval and say exactly what you want to do in needs. Do not try another way around this.`
          );
        }
      } else {
        void recordAction({ ...base, detail, decision: "allowed" });
      }
      const result = await tool.run(args, ctx);
      if (name === "browser") rememberElements(ctx.conversationId, result);
      return result;
    },
  }));
  return [...wrapped, airReportTool()];
}
