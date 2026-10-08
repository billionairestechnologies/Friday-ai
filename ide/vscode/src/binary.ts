import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * The extension's own copy of the `friday` agent. Installing the extension is all a person does: on first use the
 * agent is downloaded from the Friday server (checksum verified) into the extension's private storage, and it is
 * updated there when the server publishes a newer version. It is separate from any terminal install, so the two
 * never fight over versions, sign-ins or session history.
 */

function platformId(): string | null {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) return null;
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "win32") return `windows-${arch}`;
  if (process.platform === "linux") {
    const musl = fs.existsSync("/lib/ld-musl-x86_64.so.1") || fs.existsSync("/lib/ld-musl-aarch64.so.1");
    return `linux-${arch}${musl ? "-musl" : ""}`;
  }
  return null;
}

export class AgentBinary {
  /** @param bundledDir the extension's resources/native-binary: the agent that shipped inside this very build. */
  constructor(private readonly dir: vscode.Uri, private readonly bundledDir?: string) {}

  private get binDir() {
    return path.join(this.dir.fsPath, "bin");
  }

  /** Private home for the agent's config, sessions and logs: nothing is shared with ~/.friday. */
  get home() {
    const h = path.join(this.dir.fsPath, "home");
    fs.mkdirSync(h, { recursive: true });
    return h;
  }

  private file(version: string) {
    return path.join(this.binDir, `friday-${version}${process.platform === "win32" ? ".exe" : ""}`);
  }

  /** The newest copy already downloaded, if any. */
  installed(): { path: string; version: string } | null {
    if (!fs.existsSync(this.binDir)) return null;
    const versions = fs
      .readdirSync(this.binDir)
      .map((f) => /^friday-(\d+\.\d+\.\d+)(\.exe)?$/.exec(f)?.[1])
      .filter((v): v is string => Boolean(v))
      .sort((a, b) => cmp(b, a));
    const v = versions[0];
    return v ? { path: this.file(v), version: v } : null;
  }

  async latest(server: string): Promise<string | null> {
    const res = await fetch(`${server}/x/version`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!res?.ok) return null;
    const v = (await res.text()).trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  }

  /** The agent that shipped inside this extension build (per-platform VSIX), if any. */
  bundled(): { path: string; version: string } | null {
    if (!this.bundledDir) return null;
    const exe = path.join(this.bundledDir, process.platform === "win32" ? "friday.exe" : "friday");
    if (!fs.existsSync(exe)) return null;
    const version = (() => {
      try {
        return fs.readFileSync(path.join(this.bundledDir!, "VERSION"), "utf8").trim();
      } catch {
        return "";
      }
    })();
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
    // A VSIX does not reliably keep the executable bit; set it before the first run.
    try {
      fs.chmodSync(exe, 0o755);
    } catch {
      /* read-only install: it is already executable or will fail loudly at spawn */
    }
    return { path: exe, version };
  }

  /** The newest agent available on this machine without any network: managed copy, bundled, or a current terminal install. */
  private bestLocal(): { path: string; version: string } | null {
    const all = [this.installed(), this.bundled(), this.systemCli()].filter((x): x is { path: string; version: string } => Boolean(x));
    return all.sort((a, b) => cmp(b.version, a.version))[0] ?? null;
  }

  /**
   * The agent to start with, instantly. Marketplace builds carry the agent inside the extension, so this never waits
   * on the network; only a build without a bundled agent (a developer build) downloads on first run.
   */
  async startExe(server: string, progress?: (note: string, percent?: number) => void): Promise<string> {
    const local = this.bestLocal();
    if (local) return local.path;
    const latest = await this.latest(server);
    if (!latest) throw new Error("Couldn't reach the Friday server to download FridayX. Check your connection and try again.");
    return this.download(server, latest, progress);
  }

  /** Background update: downloads a newer agent when the server has one. Returns its path, or null when already current. */
  async update(server: string, progress?: (note: string, percent?: number) => void): Promise<string | null> {
    const latest = await this.latest(server);
    if (!latest) return null;
    const local = this.bestLocal();
    if (local && cmp(local.version, latest) >= 0) return null;
    return this.download(server, latest, progress);
  }

  /** The CLI installed by the one-line installer, if present and runnable. */
  systemCli(): { path: string; version: string } | null {
    const exe = path.join(os.homedir(), ".friday", "bin", process.platform === "win32" ? "friday.exe" : "friday");
    if (!fs.existsSync(exe)) return null;
    const r = cp.spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 8000 });
    const v = /(\d+\.\d+\.\d+)/.exec(r.stdout ?? "")?.[1];
    return r.status === 0 && v ? { path: exe, version: v } : null;
  }

  private async download(server: string, version: string, progress?: (note: string, percent?: number) => void): Promise<string> {
    const platform = platformId();
    if (!platform) throw new Error(`FridayX isn't available for ${process.platform}/${process.arch} yet.`);
    progress?.(`Downloading the FridayX agent ${version}…`, 0);
    const [binRes, shaRes] = await Promise.all([
      fetch(`${server}/x/download/${platform}?version=${version}`, { redirect: "follow", signal: AbortSignal.timeout(600_000) }),
      fetch(`${server}/x/sha256/${platform}?version=${version}`, { signal: AbortSignal.timeout(15_000) }),
    ]);
    if (!binRes.ok || !binRes.body) throw new Error(`The download failed (HTTP ${binRes.status}).`);
    if (!shaRes.ok) throw new Error("Couldn't fetch the checksum, so the download was not installed.");
    const expected = (await shaRes.text()).trim().split(/\s+/)[0]!.toLowerCase();
    const total = Number(binRes.headers.get("content-length")) || 0;
    const hash = crypto.createHash("sha256");
    const parts: Buffer[] = [];
    let got = 0;
    let lastPct = -1;
    for await (const chunk of binRes.body as unknown as AsyncIterable<Uint8Array>) {
      const b = Buffer.from(chunk);
      parts.push(b);
      hash.update(b);
      got += b.length;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== lastPct) {
        lastPct = pct;
        progress?.(`Downloading the FridayX agent ${version}… ${(got / 1048576).toFixed(0)}${total ? ` of ${(total / 1048576).toFixed(0)}` : ""} MB`, pct >= 0 ? pct : undefined);
      }
    }
    const bytes = Buffer.concat(parts);
    const actual = hash.digest("hex");
    if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      throw new Error("The download didn't match its checksum, so it was not installed.");
    }
    fs.mkdirSync(this.binDir, { recursive: true });
    const target = this.file(version);
    const tmp = `${target}.part-${process.pid}`;
    fs.writeFileSync(tmp, bytes, { mode: 0o755 });
    fs.renameSync(tmp, target); // atomic: a half-written binary is never executed
    if (process.platform === "darwin") {
      try {
        // Downloaded by us, not a browser, so there is no quarantine flag; this is a no-op safety net.
        require("node:child_process").spawnSync("xattr", ["-d", "com.apple.quarantine", target]);
      } catch {
        /* not present */
      }
    }
    // Keep the two newest copies for rollback; older ones are just disk.
    const rest = fs
      .readdirSync(this.binDir)
      .map((f) => ({ f, v: /^friday-(\d+\.\d+\.\d+)/.exec(f)?.[1] }))
      .filter((x): x is { f: string; v: string } => Boolean(x.v))
      .sort((a, b) => cmp(b.v, a.v))
      .slice(2);
    for (const x of rest) fs.rmSync(path.join(this.binDir, x.f), { force: true });
    return target;
  }
}

function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

