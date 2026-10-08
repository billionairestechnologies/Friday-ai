# FridayX for VS Code

The editor face of FridayX: a chat panel in the VS Code sidebar (or an editor tab) that runs the **same `friday` agent
as the terminal CLI**. Same models, same tools, same plan and credit meter, same skills/plugins/MCP servers. Code lives in
[`ide/vscode/`](../../ide/vscode). The CLI itself is documented in [FRIDAY_X.md](FRIDAY_X.md); this page covers the extension.

Supported editor today: **VS Code** (and forks that read Open VSX: Cursor, Windsurf, VSCodium). JetBrains and Zed can use
the CLI over ACP (`friday agent stdio`, see [`ide/README.md`](../../ide/README.md)); there is no dedicated plugin.

Diagrams: [architecture](../diagrams/friday-x/23-friday-x-vscode-architecture.svg) ·
[one chat turn](../diagrams/friday-x/24-friday-x-vscode-chat-turn.svg) ·
[build and publish](../diagrams/friday-x/25-friday-x-vscode-release.svg) ·
[where data and tokens live](../diagrams/friday-x/26-friday-x-vscode-data.svg).

## The idea

The extension is a **thin client**: it renders, relays and integrates with the editor. It contains no model, plan or limit
logic ("no client holds plans, models or limits"). Everything comes from the agent over ACP and from the Friday server at
runtime, so a change in the Team Console reaches every editor at its next start.

```
webview (UI)  <-postMessage->  extension host  <-ACP/stdio->  friday agent  <-HTTPS Bearer fxt_->  Friday /api/x
```

## Source map (`ide/vscode`)

| File | What it does |
|---|---|
| `src/extension.ts` | Activation, commands, the sidebar view + editor-tab panel, webview message routing, the `fridayx:` diff content provider |
| `src/controller.ts` | One per window. Owns the agent process and the ACP session; fans events to every webview (replays a log to new ones); mode, rewind, manage (plugins/MCP/skills), usage, What's New, agent update checks, editor context, edit review |
| `src/acp.ts` | Minimal Agent Client Protocol client (newline-delimited JSON-RPC 2.0 over stdio). No dependencies |
| `src/auth.ts` | Device-code sign-in (RFC 8628), token in `SecretStorage`, `/me`, `/updates`, revoke on sign-out |
| `src/binary.ts` | Finds the agent: bundled copy, a newer downloaded copy, or a current terminal install; background updates with checksum verification |
| `media/index.html`, `main.css`, `main.js` | The chat UI (plain JS, no framework): markdown, step cards, composer, menus, Manage screens, usage meter |
| `media/fx.js` | Built bundle of the Libraries.dev orbs and mascots (see Third-party) |
| `fx/entry.tsx`, `vendor/libraries-dev/` | Source of that bundle (MIT, unmodified) |
| `scripts/fetch-agent.mjs` | Puts the agent for one platform into `resources/native-binary/` (checksum verified) |
| `scripts/build-fx.mjs` | esbuild bundle of the orbs/mascots; runs as part of `npm run compile` |

## Sign-in (its own, not the CLI's)

1. Panel shows **Sign in with browser**. The extension calls `POST /api/x/oauth2/device/code` with `client_id=friday-x-vscode`.
2. It opens `/device?code=…`, shows the code, and polls `/api/x/oauth2/token`.
3. On approval the `fxt_` token is stored in `SecretStorage` (OS keychain), keyed by server URL.
4. The agent receives it only as `FRIDAY_X_TOKEN` in its environment. It never touches a settings file or the webview.
5. Every start validates it with `GET /api/x/me`; a 401/403 clears it and returns to sign-in. **Sign out** calls
   `POST /api/x/auth/logout` (revokes server-side) and clears the keychain entry.

The server enforces the `fridayX` entitlement on every request (`middleware/cliAuth.ts`), exactly as for the CLI.

## The agent: bundled, like other agent extensions

The Marketplace supports **per-platform extension builds**. Each build contains the agent in `resources/native-binary/`
(with a `VERSION` file), so installing the extension is the only download and the first run starts in milliseconds, offline.

- Build: `node scripts/fetch-agent.mjs <target>` then `npm run package:target -- <target>` (VS Code targets: `darwin-arm64`,
  `darwin-x64`, `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`, `win32-x64`, `win32-arm64`). The release server has
  binaries for **`darwin-arm64`, `linux-x64`, `win32-x64` only** (checked 2026-10-08; the rest answer 403), so CI builds those three.
  Intel Macs, ARM Linux/Windows and Alpine get no build until their `friday-<platform>` binaries are uploaded to the releases
  bucket; then add the target to the matrix in `friday-x-ide.yml`.
- Local dev build: `npm run bundle:local` copies the CLI installed on this machine, then `vsce package --target <yours>`.
- Resolution order at start (`binary.ts#bestLocal`): newest of {downloaded copy in extension storage, bundled copy,
  `~/.friday/bin/friday`}. `fridayX.executable` (absolute path) overrides everything.
- Updates: on start and every 6 h the extension asks `/x/version`; a newer agent is downloaded in the background into
  extension storage (SHA-256 from `/x/sha256/<platform>` must match), and the panel offers **Restart FridayX**. A running agent
  is never swapped under a live chat. A failed update never removes a working agent.

## ACP: what the extension speaks

Client → agent: `initialize` (declares `fs.readTextFile`, no terminal), `session/new`, `session/load`, `session/list`,
`session/prompt`, `session/cancel`, `session/set_model`, `session/set_mode`, `_friday/rewind/points`, `_friday/rewind/execute`.
Agent → client requests: `fs/read_text_file` (answered from the editor so unsaved edits are visible), `session/request_permission`.
Agent → client notifications used: `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
`tool_call_update`, `plan`, `user_message_chunk` on replay, `available_commands_update`, `current_mode_update`),
`_friday/models/update`, `_friday/session_notification` (`retry_state`, `session_summary_generated`).

Facts learned by running the agent (keep these in mind when changing the UI):
- Commands the agent runs stream output through repeated `tool_call_update` with `content`; each update **replaces** `content`.
- A subagent spawn (`spawn_subagent`, `rawInput.variant = "Task"`) **completes immediately** ("Subagent started in background",
  `subagent_id: …`); the result arrives later on a separate "get task output" call whose final title is
  `[subagent:<type>] <description> (<id8>)`. The panel links them so the mascot keeps working until the result arrives.
- `promptCapabilities.image` is false: the agent does not take image blocks but **does read image files by path**.
- Slash commands like `/always-approve on|off` are handled locally in milliseconds (no model call).
- A usage limit surfaces as a `retry_state` whose reason says "usage limit … resets <ISO>". Retrying cannot fix it, so the
  extension cancels the turn and shows a plain message with the reset time.

## Features and how they work

| Feature | Mechanism |
|---|---|
| Chat panel in sidebar or editor tab | One controller, many webviews; a replay log lets a new view show the whole conversation |
| Editor context | Every prompt starts with a hidden `[Editor context …]` block: project folder, open file and selection, open tabs, problems in that file. VS Code reports no active editor while a webview has focus, so the last real editor is remembered |
| Mode: Ask first / Plan / Auto-approve | `session/set_mode` (`default`/`plan`) + `/always-approve on|off`; remembered per workspace and re-applied to every new/loaded chat so it never silently follows `config.toml` |
| Edit review | On a permission request with a diff, a real VS Code diff opens (`fridayx:` scheme, whole file before/after) with **Accept/Reject** in the title bar; the chat card offers the same buttons. Setting `fridayX.reviewInEditor` |
| Reveal edits | Completed edits open in the editor without taking focus (`fridayX.revealEdits`) |
| Rewind / checkpoints | `_friday/rewind/points` + `execute` with `force: true`; mode `all` (code and chat) or `conversation_only`; then `session/load` replays the shortened chat and the message returns to the composer |
| Images | Paste or drop → saved to `$TMPDIR/friday-x/images/` → attached as `[Attached image: <path>]` |
| Manage (plugins, MCP, skills, settings) | Runs the CLI's own `friday plugin …` / `friday mcp …` with `--json`; the editor and terminal can never disagree. Opened from the `/` menu |
| Usage meter | `GET /api/x/me` every minute and after each turn; percent + reset time, the same numbers as the web app |
| What's New | `GET /api/x/updates` (same published updates, audience rules and "seen once" ledger as the web); `POST /api/x/updates/seen` |
| Orbs and mascots | Thinking orb (20 px) on the status line and running steps; one mascot per subagent (26 px) |
| Rich answers | Tables, nested/task lists, quotes, code blocks with Copy, clickable file paths (`src/a.ts:42`) |

## Settings

| Setting | Default | |
|---|---|---|
| `fridayX.serverUrl` | production URL | The Friday server (own deployment) |
| `fridayX.executable` | empty | Absolute path to a `friday` binary instead of the bundled/managed one |
| `fridayX.isolateFromCli` | `false` | Private `FRIDAY_HOME` in extension storage instead of sharing `~/.friday` |
| `fridayX.reviewInEditor` | `true` | Open edits as a diff with Accept/Reject |
| `fridayX.revealEdits` | `true` | Show edited files in the editor |

## Server side (this repo)

- Reused: `/api/x/oauth2/*` (client ids `friday-x-vscode`/`friday-x-jetbrains`/… are named in `routes/cli.ts`), `/api/x/me`,
  `/api/x/auth/logout`, `/x/version|download|sha256`.
- Added for the editors: `GET /api/x/updates` and `POST /api/x/updates/seen` in `backend/src/routes/cli.ts`, reusing
  `announcementService.pendingForUser/markSeen`. Until deployed, the extension simply shows no What's New.

## Test it

```bash
cd ide/vscode && npm ci && npm run compile          # tsc + media/fx.js
node scripts/fetch-agent.mjs --local                # bundle this machine's CLI (dev)
npx vsce package --no-dependencies --target darwin-arm64
code --install-extension friday-x-darwin-arm64-*.vsix --force   # then: Developer: Reload Window
```

Without VS Code, the pieces are testable on their own:
- Protocol: spawn `friday agent stdio` with `FRIDAY_X_TOKEN`, send `initialize`, `session/new`, `session/prompt` (see `src/acp.ts`).
- Sign-in/update/download logic: `require("./out/auth.js")` and `require("./out/binary.js")` run in plain Node against production.
- UI: load `media/index.html` (replace `{{css}} {{fx}} {{js}} {{logo}}`, stub `acquireVsCodeApi`) in a headless browser and
  `postMessage` events like `{t:"update", update:{...}}`; this is how the screens were checked.

## Publishing

CI: `.github/workflows/friday-x-ide.yml` builds the three published platform packages on changes under `ide/` and publishes on a tag
`ide-vX.Y.Z` when the secrets exist (`VSCE_PAT`, `OVSX_PAT`). Nothing publishes without them.

1. Create the publisher `billionairestechnologies` at <https://marketplace.visualstudio.com/manage> (the ID must equal
   `publisher` in `package.json`; it is permanent).
2. Create a PAT with scope **Marketplace → Manage**, "All accessible organizations". **Microsoft retires global PATs on
   1 Dec 2026**; move CI to Entra ID workload identity (`vsce publish --azure-credential`) before then.
3. Open VSX: create an account/token and run `ovsx create-namespace billionairestechnologies` once.
4. `git tag ide-v0.2.0 && git push --tags`.

## Known gaps

- Inline accept/reject needs a manual pass in real VS Code (built against the documented API; not click-tested here).
- No effort/thinking toggle, bookmarks or export (present in some other agent UIs).
- Commands run inside the agent's own shell (visible as IN/OUT cards), not in a VS Code terminal.
- Only `darwin-arm64` was run locally; the Linux and Windows packages are built by CI (it builds them; they were not run).
- No build for Intel Macs, ARM Linux/Windows or Alpine until those agent binaries are published.

## Third-party

`thinking-orbs` and `bot-avatars` from [Libraries.dev](https://github.com/Jakubantalik/Libraries.dev), MIT, © 2026 Jakub Antalik,
vendored unmodified under `ide/vscode/vendor/libraries-dev/` with their licenses. The library site's own font (Saans) is not
used; text follows the IDE font.
