import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { Attachment, ChatController } from "./controller";

/**
 * FridayX for VS Code: a native chat panel (sidebar or editor tab) over the same `friday` agent the terminal uses.
 * The extension only renders and relays: plans, models, limits and sign-in all belong to the CLI and the Friday
 * server, so a change in the Team Console reaches this panel without an extension update.
 */

let controller: ChatController;
let statusItem: vscode.StatusBarItem;

function webviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", f));
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = fs.readFileSync(vscode.Uri.joinPath(context.extensionUri, "media", "index.html").fsPath, "utf8");
  return html
    .replace(/{{nonce}}/g, nonce)
    .replace(/{{csp}}/g, webview.cspSource)
    .replace("{{css}}", media("main.css").toString())
    .replace("{{fx}}", media("fx.js").toString())
    .replace("{{js}}", media("main.js").toString())
    .replace("{{logo}}", media("logo.png").toString());
}

function wire(webview: vscode.Webview, context: vscode.ExtensionContext): vscode.Disposable {
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] };
  webview.html = webviewHtml(webview, context);
  let detach: (() => void) | null = null;

  const sub = webview.onDidReceiveMessage(async (m: any) => {
    switch (m.t) {
      case "ready":
        detach?.();
        detach = controller.attach((msg) => void webview.postMessage(msg));
        break;
      case "send":
        void controller.send(String(m.text ?? ""), (m.attachments ?? []) as Attachment[]);
        break;
      case "cancel":
        void controller.cancel();
        break;
      case "newChat":
        void controller.newChat();
        break;
      case "setModel":
        void controller.setModel(String(m.modelId));
        break;
      case "permission":
        controller.answerPermission(String(m.reqId), m.optionId ?? null);
        break;
      case "listSessions":
        void controller.listSessions();
        break;
      case "loadSession":
        void controller.loadSession(String(m.id));
        break;
      case "signIn":
        controller.signIn();
        break;
      case "install":
        void controller.updateAgent();
        break;
      case "updatesSeen":
        void controller.markUpdatesSeen(Array.isArray(m.ids) ? m.ids.map(String) : [], m.clickedId ? String(m.clickedId) : undefined);
        break;
      case "refreshUsage":
        void controller.refreshUsage();
        break;
      case "rewindPoints":
        void controller.sendRewindPoints();
        break;
      case "rewind":
        void controller.rewind({ index: typeof m.index === "number" ? m.index : undefined, text: typeof m.text === "string" ? m.text : undefined });
        break;
      case "pasteImage": {
        const saved = controller.savePastedImage(String(m.data ?? ""));
        if (saved) void webview.postMessage({ t: "picked", files: [{ path: saved.path, rel: saved.rel }] });
        break;
      }
      case "setMode":
        void controller.setMode(String(m.mode));
        break;
      case "manageList":
        void controller.manageList();
        break;
      case "manageAction":
        void controller.manageAction(String(m.action), String(m.name ?? ""), m.extra);
        break;
      case "openConfig":
        void controller.openConfig();
        break;
      case "openInstructions":
        void controller.openProjectInstructions();
        break;
      case "signOut":
        void controller.signOut();
        break;
      case "openUrl":
        if (typeof m.url === "string" && /^https:\/\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      case "cancelSignIn":
        controller.cancelSignIn();
        break;
      case "restart":
        void controller.restart();
        break;
      case "openFile":
        void controller.openFile(String(m.path), m.line);
        break;
      case "openDiff":
        void controller.openDiff(String(m.path), String(m.oldText ?? ""), String(m.newText ?? ""));
        break;
      case "pickFiles": {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach to FridayX" });
        if (picked) void webview.postMessage({ t: "picked", files: picked.map((u) => ({ path: u.fsPath, rel: controller.relative(u.fsPath) })) });
        break;
      }
      case "searchFiles": {
        const q = String(m.query ?? "").trim();
        const glob = q ? `**/*${q.split("").join("*")}*` : "**/*";
        const uris = await vscode.workspace.findFiles(glob, "**/{node_modules,.git,target,dist,out,build}/**", 12);
        void webview.postMessage({ t: "fileResults", query: q, files: uris.map((u) => ({ path: u.fsPath, rel: controller.relative(u.fsPath) })) });
        break;
      }
      case "settings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "fridayX");
        break;
    }
  });
  return new vscode.Disposable(() => {
    sub.dispose();
    detach?.();
  });
}

class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}
  resolveWebviewView(view: vscode.WebviewView) {
    const d = wire(view.webview, this.context);
    view.onDidDispose(() => d.dispose());
  }
}

function openInEditor(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel("fridayX.editor", "FridayX", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "logo.png");
  const d = wire(panel.webview, context);
  panel.onDidDispose(() => {
    d.dispose();
  });
}

/** The classic experience: the full terminal UI of the CLI, for people who prefer it. */
async function openTerminal() {
  // Same private agent and sign-in as the panel, so the terminal UI needs no `friday login` either.
  const ready = await controller.prepare();
  if (!ready) return void vscode.commands.executeCommand("fridayX.focus");
  const existing = vscode.window.terminals.find((t) => t.name === "FridayX CLI" && t.exitStatus === undefined);
  if (existing) return existing.show();
  const t = vscode.window.createTerminal({
    name: "FridayX CLI",
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    env: ready.env as Record<string, string>,
    location: { viewColumn: vscode.ViewColumn.Beside },
  });
  t.show();
  t.sendText(ready.exe.includes(" ") ? `"${ready.exe}"` : ready.exe);
}

async function focusChat() {
  await vscode.commands.executeCommand("fridayX.chat.focus");
}

function selectionAttachment(withSelection: boolean): Attachment | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return null;
  const sel = editor.selection;
  if (withSelection && !sel.isEmpty) {
    return { path: editor.document.uri.fsPath, startLine: sel.start.line + 1, endLine: sel.end.line + 1 };
  }
  return { path: editor.document.uri.fsPath };
}

export function activate(context: vscode.ExtensionContext) {
  controller = new ChatController(context);
  controller.noteEditor(vscode.window.activeTextEditor);

  // Before/after text of an edit under review is served to VS Code's diff editor from memory.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("fridayx", {
      provideTextDocumentContent: (uri) => controller.diffDocs.get(uri.toString()) ?? "",
    }),
    vscode.commands.registerCommand("fridayX.acceptEdit", () => {
      const id = controller.activeReviewId();
      if (id) controller.decide(id, true);
    }),
    vscode.commands.registerCommand("fridayX.rejectEdit", () => {
      const id = controller.activeReviewId();
      if (id) controller.decide(id, false);
    }),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = "fridayX.open";
  const paintStatus = (s: string) => {
    const label: Record<string, string> = {
      ready: "$(sparkle) FridayX",
      starting: "$(loading~spin) FridayX",
      auth: "$(account) FridayX: sign in",
      installing: "$(cloud-download) FridayX: setting up",
      signingIn: "$(account) FridayX: waiting for sign-in",
      error: "$(warning) FridayX",
    };
    statusItem.text = label[s] ?? "$(sparkle) FridayX";
    statusItem.tooltip = "Open FridayX";
  };
  controller.setStatusListener(paintStatus);
  paintStatus("idle");
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    { dispose: () => controller.dispose() },
    vscode.window.registerWebviewViewProvider("fridayX.chat", new SidebarProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      controller.noteEditor(e);
      controller.pushContext();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => controller.pushContext()),

    vscode.commands.registerCommand("fridayX.open", focusChat),
    vscode.commands.registerCommand("fridayX.focus", focusChat),
    vscode.commands.registerCommand("fridayX.openInEditor", () => openInEditor(context)),
    vscode.commands.registerCommand("fridayX.openTerminal", openTerminal),
    vscode.commands.registerCommand("fridayX.newChat", async () => {
      await focusChat();
      await controller.newChat();
    }),
    vscode.commands.registerCommand("fridayX.sendSelection", async () => {
      const a = selectionAttachment(true);
      if (!a) return void vscode.window.showInformationMessage("Open a file and select some code first.");
      await focusChat();
      controller.pushAttach(a);
    }),
    vscode.commands.registerCommand("fridayX.sendFile", async (uri?: vscode.Uri) => {
      // From the Explorer menu VS Code passes the clicked file; from the palette it is the active editor.
      const a = uri?.scheme === "file" ? { path: uri.fsPath } : selectionAttachment(false);
      if (!a) return void vscode.window.showInformationMessage("Open a file first.");
      await focusChat();
      controller.pushAttach(a);
    }),
    vscode.commands.registerCommand("fridayX.login", async () => {
      await focusChat();
      void controller.signIn();
    }),
    vscode.commands.registerCommand("fridayX.logout", () => controller.signOut()),
    vscode.commands.registerCommand("fridayX.install", () => controller.updateAgent()),
    vscode.commands.registerCommand("fridayX.restart", () => controller.restart()),
  );

  // Warm the agent so the first message does not wait for startup; harmless if the CLI is missing.
  setTimeout(() => void controller.ensureStarted(), 1500);
}

export function deactivate() {
  controller?.dispose();
}
