import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Friday X for VS Code is a thin client: the agent, the login and the models all live in the `friday` CLI and the
 * Friday backend, so the editor adds only what a terminal cannot (a launcher that finds the project, "send this
 * selection", an installer, a status entry). Nothing here knows about plans, models or limits.
 */

const TERMINAL_NAME = "Friday X";
let statusItem: vscode.StatusBarItem;

function config() {
  return vscode.workspace.getConfiguration("fridayX");
}

function serverUrl(): string {
  return String(config().get("serverUrl") ?? "https://friday.billionairestechnologies.com").replace(/\/+$/, "");
}

/** The friday executable: the setting, ~/.friday/bin (where the installer puts it), then PATH. */
function resolveExecutable(): string | null {
  const configured = String(config().get("executable") ?? "friday");
  const exe = process.platform === "win32" ? "friday.exe" : "friday";
  const candidates = [
    path.isAbsolute(configured) ? configured : null,
    path.join(os.homedir(), ".friday", "bin", exe),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const probe = cp.spawnSync(process.platform === "win32" ? "where" : "which", [configured], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.split(/\r?\n/)[0]!.trim() || configured : null;
}

function installCommand(): string {
  const base = serverUrl();
  return process.platform === "win32" ? `irm ${base}/x/install.ps1 | iex` : `curl -fsSL ${base}/x/install.sh | bash`;
}

function workspaceFolder(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

function findTerminal(): vscode.Terminal | undefined {
  return vscode.window.terminals.find((t) => t.name === TERMINAL_NAME && t.exitStatus === undefined);
}

async function ensureInstalled(): Promise<string | null> {
  const exe = resolveExecutable();
  if (exe) return exe;
  const pick = await vscode.window.showInformationMessage(
    "Friday X isn't installed yet. Install it now? (It downloads the `friday` command and verifies its checksum.)",
    "Install",
    "Not now",
  );
  if (pick === "Install") await installOrUpdate();
  return null;
}

async function installOrUpdate() {
  const terminal = vscode.window.createTerminal({ name: "Friday X install" });
  terminal.show();
  terminal.sendText(installCommand());
  vscode.window.showInformationMessage("When the installer finishes, run “Friday X: Open”.");
}

function launch(exe: string, args: string[] = []): vscode.Terminal {
  const existing = findTerminal();
  if (existing) {
    existing.show();
    return existing;
  }
  const inEditor = config().get<boolean>("openInEditorArea", true);
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd: workspaceFolder(),
    env: { FRIDAY_X_URL: serverUrl(), FRIDAY_X_CLIENT: "vscode" },
    location: inEditor ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false } : vscode.TerminalLocation.Panel,
  });
  terminal.show();
  const quoted = exe.includes(" ") ? `"${exe}"` : exe;
  terminal.sendText([quoted, ...args].join(" "));
  return terminal;
}

async function open() {
  const exe = await ensureInstalled();
  if (exe) launch(exe);
}

function mentionFor(uri: vscode.Uri, range?: vscode.Range): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const rel = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
  const normalized = rel.split(path.sep).join("/");
  const lines = range && !range.isEmpty ? `#L${range.start.line + 1}-${range.end.line + 1}` : "";
  return `@${normalized}${lines} `;
}

async function sendToFriday(text: string) {
  const exe = await ensureInstalled();
  if (!exe) return;
  const terminal = launch(exe);
  // No newline: the person adds their question and presses Enter themselves.
  terminal.sendText(text, false);
}

async function sendSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a file and select some code first.");
    return;
  }
  await sendToFriday(mentionFor(editor.document.uri, editor.selection));
}

async function sendFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a file first.");
    return;
  }
  await sendToFriday(mentionFor(editor.document.uri));
}

async function runSubcommand(sub: string) {
  const exe = await ensureInstalled();
  if (!exe) return;
  const terminal = vscode.window.createTerminal({ name: `Friday X ${sub}`, env: { FRIDAY_X_URL: serverUrl(), FRIDAY_X_CLIENT: "vscode" } });
  terminal.show();
  terminal.sendText(`${exe.includes(" ") ? `"${exe}"` : exe} ${sub}`);
}

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = "fridayX.open";
  statusItem.text = "$(sparkle) Friday X";
  statusItem.tooltip = "Open Friday X";
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("fridayX.open", open),
    vscode.commands.registerCommand("fridayX.sendSelection", sendSelection),
    vscode.commands.registerCommand("fridayX.sendFile", sendFile),
    vscode.commands.registerCommand("fridayX.login", () => runSubcommand("login")),
    vscode.commands.registerCommand("fridayX.logout", () => runSubcommand("logout")),
    vscode.commands.registerCommand("fridayX.install", installOrUpdate),
  );
}

export function deactivate() {}
