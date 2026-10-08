import * as cp from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * A minimal Agent Client Protocol (ACP) client over the stdio of `friday agent stdio`.
 *
 * Why hand-written: ACP is newline-delimited JSON-RPC 2.0 and the extension needs about ten methods, so a
 * dependency would only add weight to the .vsix. Everything the agent knows (plans, models, limits, tools) arrives
 * over this wire, so nothing here encodes product rules.
 */

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

type Pending = { resolve: (v: any) => void; reject: (e: RpcError) => void };
type RequestHandler = (params: any) => Promise<unknown> | unknown;

export class AcpClient extends EventEmitter {
  private proc: cp.ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private handlers = new Map<string, RequestHandler>();
  stderrTail = "";

  constructor(
    private readonly exe: string,
    private readonly cwd: string | undefined,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /** Handle a request the AGENT sends us (fs reads, permission prompts). */
  onRequest(method: string, handler: RequestHandler) {
    this.handlers.set(method, handler);
  }

  start() {
    const proc = cp.spawn(this.exe, ["agent", "stdio"], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      // On Windows the installer drops friday.exe; no shell needed, and a shell would mangle paths with spaces.
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    proc.on("error", (err) => this.emit("exit", { code: null, error: err.message }));
    proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject({ code: -32000, message: "FridayX stopped unexpectedly." });
      this.pending.clear();
      this.emit("exit", { code });
    });
  }

  stop() {
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.proc = null;
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.running) return reject({ code: -32000, message: "FridayX is not running." });
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (this.running) this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown) {
    this.proc?.stdin.write(JSON.stringify(message) + "\n");
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a stray log line on stdout must never kill the session
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any) {
    this.emit("message", msg); // raw tap for diagnostics and tests
    if (msg.method && msg.id !== undefined) {
      void this.answer(msg);
    } else if (msg.method) {
      this.emit("notification", msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
    }
  }

  private async answer(msg: any) {
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }
    try {
      const result = await handler(msg.params);
      this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
    } catch (e: any) {
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
  }
}
