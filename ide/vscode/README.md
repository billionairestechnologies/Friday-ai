# FridayX for VS Code

**Friday's coding agent, in a chat panel beside your code.** Ask FridayX to build features, fix bugs, explain code, run
commands and edit files across your whole project. It works with your Friday account: the same plan, models and usage
as the Friday web and mobile apps.

Installing the extension is all you do. It already contains the agent, signs you in with your browser, and connects to
Friday. No separate install, no terminal.

## Get started

1. Install the extension and click the **FridayX** icon in the Activity Bar (or press `Cmd/Ctrl+Alt+F`).
2. Click **Sign in with browser**, check the code matches, and approve.
3. Open a project folder and ask for something: *"add input validation to the signup form and run the tests"*.

You need a Friday account whose plan includes FridayX. Create one at
[friday.billionairestechnologies.com](https://friday.billionairestechnologies.com).

## What you get

- **A real coding agent.** It reads and searches your project, edits files, runs commands, and can delegate to
  subagents. Every step shows as a card: the command and its output, the diff, the files it read.
- **You stay in control.** Choose **Ask first** (approve each edit and command), **Plan** (it researches and proposes a
  plan, no edits), or **Auto-approve**. Edits open as a normal VS Code diff with **Accept / Reject** in the tab bar.
- **It knows what you're looking at.** The open file, your selection, open tabs and the problems VS Code shows are shared
  with the agent automatically, so "fix this" just works. Add files with `@`, paste or drop screenshots.
- **Rewind.** Click `↩` on any of your messages to go back to before it, restoring the files FridayX changed if you want.
- **Your tools, your way.** Plugins (GitHub, Gmail, Drive, Notion, Vercel, Supabase and more), MCP servers and skills
  from the `/` menu. Slash commands, past chats, model picker.
- **See your usage.** A small meter shows how much of your plan you've used and when it resets, the same numbers as the
  Friday web app.

## Commands

| Command | |
|---|---|
| **FridayX: Open** (`Cmd/Ctrl+Alt+F`) | Open the chat panel |
| **FridayX: New Chat** (`Cmd/Ctrl+Alt+N`) | Start a fresh chat |
| **FridayX: Add Selection to Chat** (`Cmd/Ctrl+Alt+K`) | Send the selected code as context |
| **FridayX: Open in New Tab** | Move the chat into an editor tab |
| **FridayX: Sign In / Sign Out** | Manage your account in this editor |
| **FridayX: Open Terminal UI (CLI)** | The full terminal version of the same agent |

## Settings

| Setting | Default | |
|---|---|---|
| `fridayX.reviewInEditor` | on | Open edits as a diff with Accept/Reject before anything is written |
| `fridayX.revealEdits` | on | Show files in the editor as FridayX edits them |
| `fridayX.isolateFromCli` | off | Keep FridayX's settings and history separate from the `friday` terminal app |
| `fridayX.serverUrl` | Friday | Only for self-hosted Friday deployments |
| `fridayX.executable` | empty | Advanced: use a specific `friday` binary instead of the bundled one |

## Privacy and security

- The agent runs **on your machine**, with access to your project folder and the commands you approve. Your code is sent
  to the AI models through your Friday account to answer your requests, as in the Friday apps.
- Your sign-in token is stored in VS Code's secret storage (your operating system's keychain). It is never written to a
  settings file. **Sign out** revokes it on the server, and you can see and revoke devices in Friday → Settings → FridayX.
- By default the extension shares settings, skills, plugins and chat history with the `friday` terminal app
  (`~/.friday`). Turn on `fridayX.isolateFromCli` to keep them separate.

## Supported platforms

macOS (Apple Silicon), Linux (x64) and Windows (x64). Other platforms are coming.

## Troubleshooting

- **"You've reached your usage limit"**: your plan's window is used up; the message shows when it resets. Usage is shared
  with the Friday web and mobile apps.
- **Sign-in doesn't open a browser**: use **Open the page again** in the panel, or go to the page shown.
- **Something looks stale after an update**: run **Developer: Reload Window**.

Need help? Visit [friday.billionairestechnologies.com](https://friday.billionairestechnologies.com).

---
Third-party: the orbs and mascots are [Libraries.dev](https://github.com/Jakubantalik/Libraries.dev) `thinking-orbs` and
`bot-avatars` (MIT, © 2026 Jakub Antalik).
