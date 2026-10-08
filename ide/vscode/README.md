# FridayX for VS Code

Friday's coding agent in a chat panel beside your code. **Installing the extension is all you do**: it signs you in
with your Friday account in the browser, already contains the agent (the same engine as the `friday` CLI, shipped inside the extension for your platform) and connects to the
Friday server. No terminal, no `friday login`, no separate CLI install. Your plan, models and usage meter are the
same as in the web and mobile apps and are decided by the server.

## What it does

- **FridayX: Open** (`Cmd/Ctrl+Alt+F`): opens FridayX beside your editor, in your project folder.
- **Send Selection** (`Cmd/Ctrl+Alt+K`): puts `@path#L10-24` for the selected code in the prompt; type your question.
- **Sign In / Sign Out**: browser sign-in with your Friday account, inside the panel.
- **Check for Agent Update**: fetches a newer agent from the Friday server; it also checks on start.

The token is kept in VS Code's secret storage (your OS keychain). The agent runs from the extension's private
storage with its own config and history, separate from a terminal install of `friday`. Sign out revokes the token on
the server; you can also see and revoke signed-in devices in Friday → Settings → FridayX.

## Settings

| Setting | Default | |
|---|---|---|
| `fridayX.serverUrl` | `https://friday.billionairestechnologies.com` | The Friday server (change only for your own deployment) |
| `fridayX.executable` | _(empty)_ | Advanced: a `friday` binary to use instead of the managed download |
| `fridayX.openInEditorArea` | `true` | Terminal beside the editor instead of the bottom panel |

## Build

```sh
npm install
npm run compile
npm run package   # produces friday-x-0.1.0.vsix
```

---
Third-party: Libraries.dev thinking-orbs and bot-avatars, MIT, Copyright (c) 2026 Jakub Antalik (bundled in media/fx.js; see vendor/libraries-dev/NOTICE.md in the source repository).
