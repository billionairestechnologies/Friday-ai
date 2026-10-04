# Friday X for VS Code

Friday's coding agent, in your editor. It uses **your Friday account**: the same plan, models and usage meter as
the web and mobile apps. Which models you see and how much you can use are decided by the Friday server, so a plan
change or a new model shows up here without updating the extension.

## What it does

- **Friday X: Open** (`Cmd/Ctrl+Alt+F`): opens Friday X beside your editor, in your project folder.
- **Send Selection** (`Cmd/Ctrl+Alt+K`): puts `@path#L10-24` for the selected code in the prompt; type your question.
- **Sign In / Sign Out**: browser sign-in with your Friday account (`friday login`).
- **Install or Update**: runs the one-line installer, which verifies a SHA-256 checksum before installing.

The extension is a thin client over the `friday` command line tool; everything else is in the CLI
(the `cli/` folder of the Friday repository).

## Settings

| Setting | Default | |
|---|---|---|
| `fridayX.serverUrl` | `https://friday.billionairestechnologies.com` | The Friday server (change only for your own deployment) |
| `fridayX.executable` | `friday` | Path to the CLI if it is not on PATH |
| `fridayX.openInEditorArea` | `true` | Terminal beside the editor instead of the bottom panel |

## Build

```sh
npm install
npm run compile
npm run package   # produces friday-x-0.1.0.vsix
```
