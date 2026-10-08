import * as fs from "node:fs";
import * as os from "node:os";
import * as cp from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { AcpClient, RpcError } from "./acp";
import { Account, Auth } from "./auth";
import { AgentBinary } from "./binary";

/**
 * One controller per VS Code window. It owns the `friday agent stdio` process and the current ACP session, and
 * fans events out to every attached webview (the sidebar view and any editor-tab panels). New webviews get the
 * event log replayed, so moving the chat between the sidebar and an editor tab never loses the conversation.
 */

export interface Attachment {
  path: string; // absolute
  startLine?: number; // 1-based, inclusive
  endLine?: number;
}

type Sink = (message: unknown) => void;

const LOG_LIMIT = 6000;

function config() {
  return vscode.workspace.getConfiguration("fridayX");
}

export function serverUrl(): string {
  return String(config().get("serverUrl") ?? "https://friday.billionairestechnologies.com").replace(/\/+$/, "");
}

/** A developer override: an absolute path in `fridayX.executable` replaces the managed download. */
function configuredExecutable(): string | null {
  const configured = String(config().get("executable") ?? "").trim();
  return configured && path.isAbsolute(configured) && fs.existsSync(configured) ? configured : null;
}

function workspaceRoot(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

const isAuthError = (e: RpcError | undefined) =>
  !!e && (e.code === -32000 || /auth|sign.?in|log.?in|unauthor/i.test(`${e.message} ${JSON.stringify(e.data ?? "")}`));

export class ChatController {
  private client: AcpClient | null = null;
  private sinks = new Set<Sink>();
  private log: unknown[] = [];
  private sessionId: string | null = null;
  private busy = false;
  private starting: Promise<void> | null = null;
  private models: { id: string; name: string }[] = [];
  private currentModel = "";
  private commands: { name: string; description: string; hint?: string; scope?: string }[] = [];
  private status: "idle" | "installing" | "starting" | "ready" | "auth" | "signingIn" | "error" = "idle";
  private installNote: { note: string; percent: number | null } | null = null;
  private device: { code: string; url: string } | null = null;
  private account: Account | null = null;
  private signInRun = 0; // bumped to cancel a sign-in that is waiting for the browser
  private revealed = new Set<string>();
  /** Edit reviews waiting for an answer: which answer buttons exist and which diff tab shows them. */
  private pendingPerms = new Map<string, { options: { id: string; kind: string }[]; leftUri?: vscode.Uri; rightUri?: vscode.Uri }>();
  /** Serves the before/after text of an edit under review to VS Code's diff editor (scheme `fridayx`). */
  readonly diffDocs = new Map<string, string>();
  private lastEditor: vscode.TextEditor | undefined;
  private timers: NodeJS.Timeout[] = [];
  /** Latest usage / What's New / agent-update notice, replayed to a panel that opens later. */
  private sticky = new Map<string, any>();
  private runningExe = "";
  private mode: "ask" | "plan" | "auto" = "ask";
  private needsNewChat = false;
  private readonly auth: Auth;
  private readonly binary: AgentBinary;
  private error = "";
  private permissionResolvers = new Map<string, (optionId: string | null) => void>();
  private permissionSeq = 0;
  private onStatus: (s: string) => void = () => {};

  constructor(private readonly context: vscode.ExtensionContext) {
    this.auth = new Auth(context.secrets);
    const saved = context.workspaceState.get<string>("fridayX.mode");
    if (saved === "plan" || saved === "auto" || saved === "ask") this.mode = saved;
    this.binary = new AgentBinary(context.globalStorageUri, path.join(context.extensionUri.fsPath, "resources", "native-binary"));
  }

  setStatusListener(fn: (s: string) => void) {
    this.onStatus = fn;
  }

  // ---- webview plumbing ----------------------------------------------------------------------------------

  attach(sink: Sink) {
    this.sinks.add(sink);
    sink({ t: "clear" });
    for (const m of this.log) sink(m);
    sink(this.stateMessage());
    sink(this.contextMessage());
    for (const m of this.sticky.values()) sink(m);
    void this.ensureStarted();
    return () => this.sinks.delete(sink);
  }

  private emit(message: any, remember = true) {
    if (message?.t === "usage" || message?.t === "whatsNew" || message?.t === "agentUpdate") this.sticky.set(message.t, message);
    if (remember) {
      this.log.push(message);
      if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    }
    for (const s of this.sinks) s(message);
  }

  private stateMessage() {
    return {
      t: "state",
      status: this.status,
      error: this.error,
      busy: this.busy,
      models: this.models,
      currentModel: this.currentModel,
      commands: this.commands,
      sessionId: this.sessionId,
      mode: this.mode,
      installNote: this.installNote,
      device: this.device,
      account: this.account,
      server: serverUrl(),
    };
  }

  private pushState() {
    this.onStatus(this.status);
    this.emit(this.stateMessage(), false);
  }

  /** VS Code reports NO active editor while a webview (this chat) has focus, so remember the last real one. */
  noteEditor(editor: vscode.TextEditor | undefined) {
    if (editor && editor.document.uri.scheme === "file") this.lastEditor = editor;
  }

  private currentEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === "file") return active;
    const last = this.lastEditor;
    if (last && vscode.window.visibleTextEditors.includes(last)) return last;
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "file");
  }

  contextMessage() {
    const editor = this.currentEditor();
    if (!editor) return { t: "context", file: null };
    const sel = editor.selection;
    return {
      t: "context",
      file: editor.document.uri.fsPath,
      rel: this.relative(editor.document.uri.fsPath),
      startLine: sel.isEmpty ? undefined : sel.start.line + 1,
      endLine: sel.isEmpty ? undefined : sel.end.line + 1,
    };
  }

  /** Ask every attached webview to add this file/selection as a context chip on the composer. */
  pushAttach(a: Attachment) {
    this.emit({ t: "attach", attachment: a, rel: this.relative(a.path) }, false);
  }

  pushContext() {
    this.emit(this.contextMessage(), false);
  }

  relative(abs: string): string {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(abs));
    return (folder ? path.relative(folder.uri.fsPath, abs) : abs).split(path.sep).join("/");
  }

  // ---- process + session lifecycle ----------------------------------------------------------------------

  ensureStarted(): Promise<void> {
    if (this.client?.running && this.sessionId) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /** The agent to run and the environment that makes it THIS extension's own session (private home + our token). */
  async prepare(): Promise<{ exe: string; env: NodeJS.ProcessEnv } | null> {
    const server = serverUrl();
    const token = await this.auth.getToken(server);
    if (!token) {
      this.status = "auth";
      this.pushState();
      return null;
    }
    // A revoked or expired token must send the person to sign-in, not to a confusing agent error later.
    const who = await this.auth.whoami(server, token);
    if (!who) {
      await this.auth.clear(server);
      this.account = null;
      this.status = "auth";
      this.error = "Your FridayX session ended. Sign in again.";
      this.pushState();
      return null;
    }
    this.account = who;
    let exe = configuredExecutable();
    if (!exe) {
      this.status = "installing";
      this.pushState();
      try {
        exe = await this.binary.startExe(server, (note, percent) => {
          this.installNote = { note, percent: percent ?? null };
          this.pushState();
        });
        this.installNote = null;
      } catch (e: any) {
        this.status = "error";
        this.error = e?.message ?? String(e);
        this.pushState();
        return null;
      }
    }
    return {
      exe,
      // Same settings, skills, plugins, MCP servers and history as the terminal CLI (~/.friday) unless the person
      // opted into a private home. Only the sign-in is the extension's own: the token travels in the environment.
      env: {
        FRIDAY_X_URL: server,
        FRIDAY_X_CLIENT: "vscode",
        FRIDAY_X_TOKEN: token,
        ...(config().get<boolean>("isolateFromCli") ? { FRIDAY_HOME: this.binary.home } : {}),
      },
    };
  }

  private async start() {
    this.error = "";
    const ready = await this.prepare();
    if (!ready) return;
    this.status = "starting";
    this.pushState();

    this.runningExe = ready.exe;
    const client = new AcpClient(ready.exe, workspaceRoot(), ready.env);
    this.client = client;
    client.on("notification", (method: string, params: any) => this.onNotification(method, params));
    client.on("exit", () => {
      if (this.client !== client) return;
      this.client = null;
      this.sessionId = null;
      this.busy = false;
      this.cancelPermissions();
      this.status = "error";
      this.error = client.stderrTail.trim().split("\n").slice(-3).join("\n") || "FridayX stopped. Send a message to restart it.";
      this.pushState();
    });
    // Unsaved edits in the editor are the truth the person sees, so reads go through the editor, not the disk.
    client.onRequest("fs/read_text_file", (p) => this.readTextFile(p));
    client.onRequest("session/request_permission", (p) => this.askPermission(p));
    client.start();

    try {
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
        clientInfo: { name: "friday-x-vscode", version: this.context.extension.packageJSON.version },
      });
      await this.newSession();
    } catch (e: any) {
      this.fail(e);
    }
  }

  private fail(e: RpcError) {
    if (isAuthError(e)) {
      this.status = "auth";
      this.error = "";
    } else {
      this.status = "error";
      this.error = e?.message ?? String(e);
    }
    this.pushState();
  }

  private applyModels(models: any) {
    if (!models) return;
    this.models = (models.availableModels ?? []).map((m: any) => ({ id: m.modelId, name: m.name }));
    this.currentModel = models.currentModelId ?? this.currentModel;
  }

  private async newSession() {
    const res = await this.client!.request("session/new", { cwd: workspaceRoot() ?? os.homedir(), mcpServers: [] });
    this.sessionId = res.sessionId;
    this.applyModels(res.models);
    await this.applyMode();
    this.status = "ready";
    this.pushState();
    this.startBackground();
  }

  // ---- usage, What's New and agent updates --------------------------------------------------------------
  // Same account, same meter: usage comes from the Friday server (percent + reset time, exactly what the web app
  // shows), What's New is the Console's published updates for this user, and the agent updates itself from the
  // release server. Every call degrades to "show nothing" so a flaky network never breaks the chat.

  private startBackground() {
    if (this.timers.length) return;
    const every = (ms: number, fn: () => void) => this.timers.push(setInterval(fn, ms));
    void this.refreshUsage();
    setTimeout(() => void this.checkWhatsNew(), 4000);
    setTimeout(() => void this.checkAgentUpdate(), 20_000);
    every(60_000, () => void this.refreshUsage());
    every(30 * 60_000, () => void this.checkWhatsNew());
    every(6 * 3_600_000, () => void this.checkAgentUpdate());
  }

  async refreshUsage() {
    const server = serverUrl();
    const token = await this.auth.getToken(server);
    if (!token) return;
    const me = await this.auth.get<{ plan?: string; usage?: { windows?: unknown[] } }>(server, token, "/me");
    if (me) this.emit({ t: "usage", plan: me.plan ?? null, windows: me.usage?.windows ?? [] }, false);
  }

  private async checkWhatsNew() {
    const server = serverUrl();
    const token = await this.auth.getToken(server);
    if (!token) return;
    const res = await this.auth.get<{ updates?: unknown[] }>(server, token, "/updates");
    if (res?.updates?.length) this.emit({ t: "whatsNew", updates: res.updates }, false);
  }

  async markUpdatesSeen(ids: string[], clickedId?: string) {
    this.sticky.delete("whatsNew");
    const server = serverUrl();
    const token = await this.auth.getToken(server);
    if (token && ids.length) await this.auth.post(server, token, "/updates/seen", { ids, ...(clickedId ? { clickedId } : {}) });
  }

  /** Downloads a newer agent in the background; the running one is never swapped under a live chat. */
  async checkAgentUpdate() {
    if (configuredExecutable()) return;
    try {
      const exe = await this.binary.update(serverUrl());
      if (exe && exe !== this.runningExe) {
        const v = /friday-(\d+\.\d+\.\d+)/.exec(exe)?.[1] ?? "";
        this.emit({ t: "agentUpdate", version: v }, false);
      }
    } catch {
      /* offline or a bad download: the current agent keeps working */
    }
  }

  // ---- mode: ask / plan / auto-approve ------------------------------------------------------------------
  // "ask" and "auto" are the agent's approval switch (`/always-approve`, handled locally in milliseconds, no model
  // call); "plan" is the agent's plan session mode. The choice is remembered per workspace and re-applied to every
  // new or resumed chat, so it never silently falls back to whatever ~/.friday/config.toml says.
  private async applyMode() {
    const c = this.client;
    const sid = this.sessionId;
    if (!c?.running || !sid) return;
    try {
      await c.request("session/set_mode", { sessionId: sid, modeId: this.mode === "plan" ? "plan" : "default" });
      await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: `/always-approve ${this.mode === "auto" ? "on" : "off"}` }] });
    } catch {
      /* an older agent without these commands keeps its own defaults */
    }
  }

  async setMode(mode: string) {
    if (mode !== "ask" && mode !== "plan" && mode !== "auto") return;
    this.mode = mode;
    void this.context.workspaceState.update("fridayX.mode", mode);
    this.pushState();
    await this.applyMode();
  }

  async newChat() {
    this.needsNewChat = false;
    this.log = [];
    this.emit({ t: "clear" }, false);
    if (this.busy) await this.cancel();
    this.sessionId = null;
    this.cancelPermissions();
    if (this.client?.running) {
      try {
        await this.newSession();
      } catch (e: any) {
        this.fail(e);
      }
    } else {
      await this.ensureStarted();
    }
  }

  dispose() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.cancelPermissions();
    this.client?.stop();
    this.client = null;
  }

  async restart() {
    this.sticky.delete("agentUpdate");
    this.dispose();
    this.sessionId = null;
    this.log = [];
    this.emit({ t: "clear" }, false);
    await this.ensureStarted();
  }

  // ---- talking to the agent -----------------------------------------------------------------------------

  async send(text: string, attachments: Attachment[]) {
    await this.ensureStarted();
    if (!this.client?.running || !this.sessionId) return;
    const prompt: unknown[] = [];
    const chips: { label: string; path: string }[] = [];
    for (const a of attachments) {
      const block = await this.attachmentBlock(a);
      if (block) {
        prompt.push(block);
        chips.push({ label: this.label(a), path: a.path });
      }
    }
    // What the person is looking at, like other IDE agents pass along. Without this the agent cannot know which
    // project or file "this" is (the agent itself only sees a folder on disk).
    const ide = this.ideContext();
    if (ide) prompt.unshift({ type: "text", text: ide });
    prompt.push({ type: "text", text });
    this.emit({ t: "user", text, chips });
    this.busy = true;
    this.pushState();
    try {
      const res = await this.client.request("session/prompt", { sessionId: this.sessionId, prompt });
      this.emit({ t: "turnEnd", stopReason: res?.stopReason ?? "end_turn" });
      void this.refreshUsage(); // the meter moves with every turn; show it right away, not a minute later
    } catch (e: any) {
      if (isAuthError(e)) {
        this.status = "auth";
      } else {
        this.emit({ t: "notice", level: "error", text: friendly(e) });
      }
    } finally {
      this.busy = false;
      this.cancelPermissions();
      this.pushState();
    }
  }

  /** A short, factual note about the editor state, sent with every message and hidden from the chat. */
  private ideContext(): string | null {
    const root = workspaceRoot();
    const editor = this.currentEditor();
    const open = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri)
      .filter((u): u is vscode.Uri => !!u && u.scheme === "file")
      .map((u) => u.fsPath)
      .slice(0, 12);
    const lines = ["[Editor context: sent automatically by the VS Code extension, not typed by the user]"];
    if (root) lines.push(`Project folder (the folder open in the editor; work here unless told otherwise): ${root}`);
    if (editor) {
      const sel = editor.selection;
      lines.push(`File the user has open now (\"this file\" / \"the open document\"): ${editor.document.uri.fsPath}${sel.isEmpty ? "" : ` (lines ${sel.start.line + 1}-${sel.end.line + 1} selected)`}`);
    }
    if (open.length) lines.push(`Open tabs: ${open.join(", ")}`);
    if (editor) {
      const problems = vscode.languages
        .getDiagnostics(editor.document.uri)
        .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
        .slice(0, 10)
        .map((d) => `line ${d.range.start.line + 1}: ${d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"}: ${d.message.split("\n")[0]}`);
      if (problems.length) lines.push(`Problems the editor shows in that file:\n${problems.join("\n")}`);
    }
    return lines.length > 1 ? [...lines, "[/Editor context]"].join("\n") : null;
  }

  async cancel() {
    if (this.client?.running && this.sessionId) this.client.notify("session/cancel", { sessionId: this.sessionId });
    this.cancelPermissions();
  }

  async setModel(modelId: string) {
    if (!this.client?.running || !this.sessionId) return;
    try {
      await this.client.request("session/set_model", { sessionId: this.sessionId, modelId });
      this.currentModel = modelId;
    } catch (e: any) {
      this.emit({ t: "notice", level: "error", text: friendly(e) }, false);
    }
    this.pushState();
  }

  async listSessions() {
    await this.ensureStarted();
    if (!this.client?.running) return;
    try {
      const res = await this.client.request("session/list", { cwd: workspaceRoot() ?? null });
      const sessions = (res?.sessions ?? []).map((s: any) => ({
        id: s.sessionId,
        title: s.title || "Untitled chat",
        updatedAt: s.updatedAt ?? null,
      }));
      this.emit({ t: "sessions", sessions }, false);
    } catch (e: any) {
      this.emit({ t: "notice", level: "error", text: friendly(e) }, false);
    }
  }

  async loadSession(id: string) {
    await this.ensureStarted();
    if (!this.client?.running) return;
    this.log = [];
    this.emit({ t: "clear" }, false);
    this.replaying = true;
    try {
      const res = await this.client.request("session/load", { sessionId: id, cwd: workspaceRoot() ?? os.homedir(), mcpServers: [] });
      this.sessionId = id;
      this.applyModels(res?.models);
      await this.applyMode();
    } catch (e: any) {
      this.emit({ t: "notice", level: "error", text: friendly(e) });
    } finally {
      this.replaying = false;
      this.pushState();
    }
  }
  private replaying = false;

  /** Browser sign-in: show a code in the panel, open the approval page, wait for it, keep the token in the keychain. */
  async signIn() {
    const server = serverUrl();
    const run = ++this.signInRun;
    try {
      const start = await this.auth.start(server);
      if (run !== this.signInRun) return;
      this.device = { code: start.user_code, url: start.verification_uri_complete };
      this.status = "signingIn";
      this.error = "";
      this.pushState();
      void vscode.env.openExternal(vscode.Uri.parse(start.verification_uri_complete));
      const token = await this.auth.wait(server, start, () => run !== this.signInRun);
      await this.auth.setToken(server, token);
      this.device = null;
      await this.restart();
    } catch (e: any) {
      if (run !== this.signInRun) return; // cancelled on purpose
      this.device = null;
      this.status = "auth";
      this.error = e?.message ?? String(e);
      this.pushState();
    }
  }

  cancelSignIn() {
    this.signInRun++;
    this.device = null;
    this.status = "auth";
    this.error = "";
    this.pushState();
  }

  async signOut() {
    const server = serverUrl();
    this.signInRun++;
    const token = await this.auth.getToken(server);
    if (token) await this.auth.revoke(server, token);
    await this.auth.clear(server);
    this.dispose();
    this.sessionId = null;
    this.account = null;
    this.log = [];
    this.emit({ t: "clear" }, false);
    this.status = "auth";
    this.error = "";
    this.pushState();
  }

  /** Checks the server for a newer agent and installs it, then restarts. For the "Update" command. */
  async updateAgent() {
    if (configuredExecutable()) return;
    try {
      const updated = await this.binary.update(serverUrl(), (note, percent) => {
        this.status = "installing";
        this.installNote = { note, percent: percent ?? null };
        this.pushState();
      });
      this.installNote = null;
      if (!updated) {
        this.status = this.client?.running ? "ready" : this.status;
        this.pushState();
        void vscode.window.showInformationMessage("FridayX is up to date.");
        return;
      }
    } catch (e: any) {
      this.status = "error";
      this.error = e?.message ?? String(e);
      return this.pushState();
    }
    await this.restart();
  }

  // ---- agent -> editor ----------------------------------------------------------------------------------

  private onNotification(method: string, params: any) {
    if (method === "session/update") {
      const u = params?.update;
      if (!u) return;
      if (u.sessionUpdate === "available_commands_update") {
        this.commands = (u.availableCommands ?? []).map((c: any) => ({
          name: c.name,
          description: c.description ?? "",
          hint: c.input?.hint,
          scope: c._meta?.scope as string | undefined, // user | project | plugin for skills; absent for built-ins
        }));
        return this.pushState();
      }
      if (u.sessionUpdate === "current_mode_update") {
        const next = u.currentModeId === "plan" ? "plan" : this.mode === "plan" ? "ask" : this.mode;
        if (next !== this.mode) {
          this.mode = next;
          void this.context.workspaceState.update("fridayX.mode", next);
          this.pushState();
        }
        return;
      }
      if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && !this.replaying && config().get<boolean>("revealEdits", true)) {
        const d = (u.content ?? []).find((c: any) => c?.type === "diff" && c.path);
        if (d && u.status === "completed" && !this.revealed.has(u.toolCallId)) {
          this.revealed.add(u.toolCallId);
          void this.reveal(d.path);
        }
      }
      // During session/load the agent replays history as updates; user turns come back as user_message_chunk.
      this.emit({ t: "update", update: u, replay: this.replaying });
    } else if (method === "_friday/session_notification") {
      const u = params?.update;
      // The CLI retries failed model calls up to 15 times; without this the panel would look frozen meanwhile.
      if (u?.sessionUpdate === "retry_state" && u.type === "retrying") {
        const reason = String(u.reason ?? "");
        // A usage limit is not a glitch: retrying 15 times cannot fix it. Stop the turn and say plainly what happened.
        if (/usage limit|limit[^.]*resets/i.test(reason)) {
          const window = /(weekly|5-hour|monthly|daily)/i.exec(reason)?.[1]?.toLowerCase() ?? "plan";
          const iso = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(reason)?.[1];
          const when = iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
          void this.cancel();
          this.emit({ t: "notice", level: "limit", text: `You've reached your ${window} usage limit${when ? `, which resets ${when}` : ""}. Usage is shared with your Friday web and mobile apps; you can upgrade your plan in Friday → Plans.` });
          void this.refreshUsage();
          return;
        }
        this.emit({ t: "retry", attempt: u.attempt, max: u.max_retries, reason: reason.split(":").slice(-1)[0]!.trim().slice(0, 140) }, false);
      } else if (u?.sessionUpdate === "session_summary_generated" && u.session_summary) {
        this.emit({ t: "title", title: u.session_summary });
      }
    } else if (method === "_friday/models/update") {
      this.applyModels(params);
      this.pushState();
    }
  }

  private async readTextFile(p: { path: string; line?: number; limit?: number }) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p.path));
    const lines = doc.getText().split(/\r?\n/);
    const start = Math.max(0, (p.line ?? 1) - 1);
    const slice = p.limit ? lines.slice(start, start + p.limit) : lines.slice(start);
    return { content: slice.join("\n") };
  }

  private askPermission(p: any): Promise<unknown> {
    const reqId = `p${++this.permissionSeq}`;
    return new Promise((resolve) => {
      this.permissionResolvers.set(reqId, (optionId) => {
        this.emit({ t: "permissionDone", reqId, optionId });
        resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
      });
      this.emit({
        t: "permission",
        reqId,
        title: p?.toolCall?.title ?? "Permission needed",
        kind: p?.toolCall?.kind,
        rawInput: p?.toolCall?.rawInput,
        content: p?.toolCall?.content,
        options: (p?.options ?? []).map((o: any) => ({ id: o.optionId, name: o.name, kind: o.kind })),
      });
      const options = (p?.options ?? []).map((o: any) => ({ id: o.optionId as string, kind: o.kind as string }));
      this.pendingPerms.set(reqId, { options });
      const diff = (p?.toolCall?.content ?? []).find((c: any) => c?.type === "diff" && c.path);
      if (diff && config().get<boolean>("reviewInEditor", true)) void this.openReview(reqId, diff);
      // A permission prompt in a hidden sidebar would stall the turn silently; pull the person back to it.
      void vscode.commands.executeCommand("fridayX.focus");
    });
  }

  answerPermission(reqId: string, optionId: string | null) {
    const r = this.permissionResolvers.get(reqId);
    if (!r) return;
    this.permissionResolvers.delete(reqId);
    void this.closeReview(reqId);
    r(optionId);
  }

  /** Accept / Reject from the diff editor's title bar. */
  decide(reqId: string, accept: boolean) {
    const options = this.pendingPerms.get(reqId)?.options ?? [];
    const pick = accept ? options.find((o) => o.kind === "allow_once") ?? options.find((o) => /allow/.test(o.kind)) : options.find((o) => o.kind === "reject_once") ?? options.find((o) => /reject/.test(o.kind));
    this.answerPermission(reqId, pick?.id ?? null);
  }

  /** The id of the edit review shown in the active diff tab, if any. */
  activeReviewId(): string | null {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { modified?: vscode.Uri } | undefined;
    const q = input?.modified?.scheme === "fridayx" ? new URLSearchParams(input.modified.query).get("id") : null;
    return q && this.pendingPerms.has(q) ? q : null;
  }

  /**
   * Opens the edit as a real VS Code diff editor with Accept and Reject in its title bar, before anything is written.
   * For an in-place edit the "after" is the whole file with the change applied, so the diff reads like a normal review.
   */
  private async openReview(reqId: string, diff: { path: string; oldText?: string | null; newText?: string | null }) {
    try {
      const abs = this.resolvePath(diff.path) ?? diff.path;
      let before = diff.oldText ?? "";
      let after = diff.newText ?? "";
      if (before && fs.existsSync(abs)) {
        const file = fs.readFileSync(abs, "utf8");
        if (file !== before && file.split(before).length === 2) {
          // an in-place edit: show the whole file before and after, not just the changed snippet
          after = file.replace(before, () => diff.newText ?? "");
          before = file;
        }
      }
      const name = path.basename(abs);
      const mk = (side: string, text: string) => {
        const uri = vscode.Uri.from({ scheme: "fridayx", path: `/${name}`, query: `id=${reqId}&side=${side}` });
        this.diffDocs.set(uri.toString(), text);
        return uri;
      };
      const left = mk("before", before);
      const right = mk("after", after);
      const rec = this.pendingPerms.get(reqId);
      if (rec) {
        rec.leftUri = left;
        rec.rightUri = right;
      }
      await vscode.commands.executeCommand("vscode.diff", left, right, `Review: ${name} (FridayX)`, { preview: true, preserveFocus: true });
    } catch {
      /* the in-chat diff and buttons still work */
    }
  }

  private async closeReview(reqId: string) {
    const rec = this.pendingPerms.get(reqId);
    this.pendingPerms.delete(reqId);
    if (!rec?.rightUri) return;
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => (t.input as { modified?: vscode.Uri } | undefined)?.modified?.toString() === rec.rightUri!.toString());
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    this.diffDocs.delete(rec.rightUri.toString());
    this.diffDocs.delete(rec.leftUri!.toString());
  }

  // ---- rewind / checkpoints --------------------------------------------------------------------------------
  // The agent snapshots files before each prompt. "Rewind" returns the chat (and, if you choose, the files) to
  // just before a message, and puts that message back in the composer so you can edit and resend it.

  private async rewindPoints(): Promise<{ index: number; preview: string; files: boolean; at: string }[]> {
    if (!this.client?.running || !this.sessionId) return [];
    try {
      const res = await this.client.request("_friday/rewind/points", { sessionId: this.sessionId });
      return (res?.rewind_points ?? []).map((p: any) => ({ index: p.prompt_index, preview: String(p.prompt_preview ?? ""), files: !!p.has_file_changes, at: p.created_at }));
    } catch {
      return [];
    }
  }

  async sendRewindPoints() {
    this.emit({ t: "rewindPoints", points: await this.rewindPoints() }, false);
  }

  async rewind(target: { index?: number; text?: string }) {
    if (!this.client?.running || !this.sessionId) return;
    const points = await this.rewindPoints();
    let index = target.index;
    if (index === undefined && target.text) {
      const want = target.text.replace(/\s+/g, " ").trim().slice(0, 50);
      const hit = [...points].reverse().find((p) => p.preview.replace(/\s+/g, " ").trim().startsWith(want));
      index = hit?.index;
    }
    if (index === undefined || !points.some((p) => p.index === index)) {
      this.emit({ t: "notice", level: "error", text: "FridayX can't rewind to that message (it isn't a restorable checkpoint)." }, false);
      return;
    }
    const point = points.find((p) => p.index === index)!;
    const detail = point.files
      ? "Everything after this message is removed from the chat. Files FridayX changed since then can be restored too."
      : "Everything after this message is removed from the chat. FridayX changed no files at this step.";
    const choice = await vscode.window.showWarningMessage("Rewind to before this message?", { modal: true, detail }, ...(point.files ? ["Restore code and conversation", "Conversation only"] : ["Rewind"]));
    if (!choice) return;
    const mode = choice === "Restore code and conversation" ? "all" : "conversation_only";
    const sid = this.sessionId;
    try {
      const res = await this.client.request("_friday/rewind/execute", { sessionId: sid, targetPromptIndex: index, force: true, mode });
      if (!res?.success) throw new Error(res?.error ?? "The rewind did not complete.");
      const text = String(res.prompt_text ?? point.preview).replace(/^\[Editor context[\s\S]*?\[\/Editor context\]\s*/, "");
      await this.loadSession(sid);
      this.emit({ t: "prefill", text }, false);
      const n = (res.reverted_files ?? []).length;
      if (n) void vscode.window.showInformationMessage(`Rewound. Restored ${n} file${n === 1 ? "" : "s"}.`);
    } catch (e: any) {
      this.emit({ t: "notice", level: "error", text: friendly(e) }, false);
    }
  }

  // ---- pasted / dropped images -----------------------------------------------------------------------------
  savePastedImage(dataUrl: string): { path: string; rel: string } | null {
    const m = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,(.+)$/i.exec(dataUrl);
    if (!m) return null;
    const dir = path.join(os.tmpdir(), "friday-x", "images");
    fs.mkdirSync(dir, { recursive: true });
    const name = `pasted-${Date.now()}.${m[1].toLowerCase().replace("jpeg", "jpg")}`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(m[2], "base64"));
    return { path: file, rel: name };
  }


  private cancelPermissions() {
    for (const [id, r] of [...this.permissionResolvers]) {
      this.permissionResolvers.delete(id);
      r(null);
    }
  }

  // ---- attachments --------------------------------------------------------------------------------------

  private label(a: Attachment) {
    const rel = this.relative(a.path);
    return a.startLine ? `${rel}#L${a.startLine}${a.endLine && a.endLine !== a.startLine ? `-${a.endLine}` : ""}` : rel;
  }

  private async attachmentBlock(a: Attachment) {
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(a.path)) {
      // The agent reads images through its file tool (it describes them accurately), so hand it the path.
      return { type: "text", text: `[Attached image: ${a.path}. Open it with your read tool to look at it.]` };
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(a.path));
      const range = a.startLine
        ? new vscode.Range(a.startLine - 1, 0, (a.endLine ?? a.startLine) - 1, Number.MAX_SAFE_INTEGER)
        : undefined;
      const text = doc.getText(range ? doc.validateRange(range) : undefined);
      return {
        type: "resource",
        resource: { uri: vscode.Uri.file(a.path).toString(), mimeType: "text/plain", text: `// ${this.label(a)}\n${text}` },
      };
    } catch {
      return null; // binary or deleted: skip rather than fail the whole message
    }
  }

  // ---- manage: plugins, MCP servers, skills, settings ----------------------------------------------------
  // Everything goes through the CLI's own `plugin` / `mcp` commands, so the editor and the terminal can never
  // disagree about what is installed, and a new CLI capability needs no work here.

  private async cli(args: string[]): Promise<{ ok: boolean; out: string }> {
    const ready = await this.prepare();
    if (!ready) return { ok: false, out: "Not signed in." };
    return new Promise((resolve) => {
      cp.execFile(ready.exe, args, { cwd: workspaceRoot(), env: { ...process.env, ...ready.env }, timeout: 60_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: (stdout || stderr || err?.message || "").toString().trim() });
      });
    });
  }

  private async cliJson(args: string[]): Promise<any[]> {
    const r = await this.cli(args);
    try {
      const v = JSON.parse(r.out);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  async manageList() {
    const [plugins, mcp] = await Promise.all([this.cliJson(["plugin", "list", "--json", "--available"]), this.cliJson(["mcp", "list", "--json"])]);
    const skills = this.commands.filter((c) => c.scope);
    const home = process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday");
    this.emit(
      {
        t: "manage",
        plugins,
        mcp,
        skills,
        needsNewChat: this.needsNewChat,
        configPath: path.join(config().get<boolean>("isolateFromCli") ? this.binary.home : home, "config.toml"),
        version: this.binary.installed()?.version ?? null,
        shared: !config().get<boolean>("isolateFromCli"),
      },
      false,
    );
  }

  async manageAction(action: string, name: string, extra?: any) {
    const args: string[] | null =
      action === "pluginInstall" ? ["plugin", "install", name, "--trust"]
      : action === "pluginUninstall" ? ["plugin", "uninstall", name]
      : action === "pluginEnable" ? ["plugin", "enable", name]
      : action === "pluginDisable" ? ["plugin", "disable", name]
      : action === "pluginUpdate" ? ["plugin", "update", name]
      : action === "mcpRemove" ? ["mcp", "remove", name]
      : action === "mcpEnable" ? ["mcp", "enable", name]
      : action === "mcpDisable" ? ["mcp", "disable", name]
      : action === "mcpAdd" ? mcpAddArgs(name, extra)
      : null;
    if (!args) return;
    const r = await this.cli(args);
    if (r.ok) this.needsNewChat = true;
    this.emit({ t: "manageResult", ok: r.ok, message: r.ok ? "Done. Applies to new chats." : r.out.slice(0, 300) }, false);
    await this.manageList();
  }

  async openConfig() {
    const home = process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday");
    const file = path.join(config().get<boolean>("isolateFromCli") ? this.binary.home : home, "config.toml");
    if (!fs.existsSync(file)) fs.writeFileSync(file, "# FridayX settings. See `friday --help`.\n");
    await this.openFile(file);
  }

  async openProjectInstructions() {
    const root = workspaceRoot();
    if (!root) return;
    const file = ["FRIDAY.md", "AGENTS.md", "CLAUDE.md"].map((n) => path.join(root, n)).find((f) => fs.existsSync(f)) ?? path.join(root, "FRIDAY.md");
    if (!fs.existsSync(file)) fs.writeFileSync(file, "# Project instructions for FridayX\n\n");
    await this.openFile(file);
  }

  newChatApplied() {
    this.needsNewChat = false;
  }

  // ---- editor helpers -----------------------------------------------------------------------------------

  /** Resolves a path an answer mentioned (often relative) against the project folder; ignores paths that do not exist. */
  private resolvePath(p: string): string | null {
    const candidates = path.isAbsolute(p) ? [p] : [workspaceRoot(), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)].filter((r): r is string => !!r).map((r) => path.join(r, p));
    return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
  }

  /** Shows a file the agent just edited without taking focus from the chat, like other IDE agents do. */
  private async reveal(p: string) {
    const abs = this.resolvePath(p);
    if (!abs) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.One });
    } catch {
      /* binary or deleted: nothing to show */
    }
  }

  async openFile(p: string, line?: number) {
    const abs = this.resolvePath(p);
    if (!abs) return;
    p = abs;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
    const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  }

  async openDiff(p: string, oldText: string, newText: string) {
    const name = path.basename(p);
    const left = await vscode.workspace.openTextDocument({ content: oldText ?? "", language: languageFor(p) });
    const right = await vscode.workspace.openTextDocument({ content: newText ?? "", language: languageFor(p) });
    await vscode.commands.executeCommand("vscode.diff", left.uri, right.uri, `${name} (FridayX change)`);
  }
}

function languageFor(p: string): string | undefined {
  const ext = path.extname(p).slice(1);
  return ext || undefined;
}

function friendly(e: RpcError | undefined): string {
  const m = e?.message ?? "Something went wrong.";
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
}

function mcpAddArgs(name: string, extra: { target?: string; transport?: string; scope?: string; args?: string }): string[] | null {
  const target = String(extra?.target ?? "").trim();
  if (!/^[\w.-]{1,60}$/.test(name) || !target) return null;
  const args = ["mcp", "add", name];
  if (extra?.transport === "http" || extra?.transport === "sse") args.push("-t", extra.transport);
  if (extra?.scope === "project") args.push("-s", "project");
  args.push(target);
  const rest = String(extra?.args ?? "").trim();
  if (rest) args.push("--", ...rest.split(/\s+/));
  return args;
}
