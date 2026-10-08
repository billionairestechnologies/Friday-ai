// Puts the `friday` agent for one platform inside the extension (resources/native-binary/), the same way other
// agent extensions ship their engine: the Marketplace then delivers the right per-platform build and the first run
// needs no download. The binary comes from the Friday release server and its SHA-256 is checked here, at build time.
//
//   node scripts/fetch-agent.mjs darwin-arm64        # VS Code target name; also: darwin-x64 linux-x64 linux-arm64
//                                                    #   alpine-x64 alpine-arm64 win32-x64 win32-arm64
//   node scripts/fetch-agent.mjs --local             # copy the already-installed CLI for THIS machine (dev builds)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SERVER = process.env.FRIDAY_X_URL?.replace(/\/+$/, "") || "https://friday.billionairestechnologies.com";
// VS Code target -> FridayX release platform
const MAP = {
  "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
  "alpine-x64": "linux-x64-musl", "alpine-arm64": "linux-arm64-musl",
  "win32-x64": "windows-x64", "win32-arm64": "windows-arm64",
};
const arg = process.argv[2];
const out = path.join(import.meta.dirname, "..", "resources", "native-binary");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (arg === "--local") {
  const exe = path.join(os.homedir(), ".friday", "bin", process.platform === "win32" ? "friday.exe" : "friday");
  const version = /(\d+\.\d+\.\d+)/.exec(execFileSync(exe, ["--version"], { encoding: "utf8" }))?.[1];
  if (!version) throw new Error("Couldn't read the version of " + exe);
  fs.copyFileSync(exe, path.join(out, path.basename(exe)));
  fs.writeFileSync(path.join(out, "VERSION"), version + "\n");
  console.log(`bundled local CLI ${version}`);
  process.exit(0);
}

const platform = MAP[arg];
if (!platform) { console.error("usage: fetch-agent.mjs <" + Object.keys(MAP).join("|") + "|--local>"); process.exit(2); }
const version = (await (await fetch(`${SERVER}/x/version`)).text()).trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Bad version from server: " + version);
const expected = (await (await fetch(`${SERVER}/x/sha256/${platform}?version=${version}`)).text()).trim().split(/\s+/)[0].toLowerCase();
const res = await fetch(`${SERVER}/x/download/${platform}?version=${version}`, { redirect: "follow" });
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const bytes = Buffer.from(await res.arrayBuffer());
const actual = crypto.createHash("sha256").update(bytes).digest("hex");
if (actual !== expected) throw new Error(`checksum mismatch for ${platform}: expected ${expected}, got ${actual}`);
const name = platform.startsWith("windows") ? "friday.exe" : "friday";
fs.writeFileSync(path.join(out, name), bytes, { mode: 0o755 });
fs.writeFileSync(path.join(out, "VERSION"), version + "\n");
console.log(`bundled ${platform} ${version} (${(bytes.length / 1048576).toFixed(0)} MB, sha256 verified)`);
