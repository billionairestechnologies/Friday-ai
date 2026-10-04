# Friday X in your editor

One engine, every editor. The agent, the login and the model access are the same `friday` CLI and the same Friday
backend everywhere, so VS Code, JetBrains, Zed and the terminal share your account, your plan, the model list and
the usage meter. The server decides plans and models, so a change in the Team Console reaches every editor at its
next start: no extension update.

| Editor | How | Status |
|---|---|---|
| **VS Code** (and forks: Cursor, Windsurf, VSCodium) | the extension in [`vscode/`](vscode) | built, packages to a `.vsix` |
| **JetBrains IDEs** (IntelliJ, PyCharm, WebStorm, GoLand, Rider, …) | Agent Client Protocol (ACP): add Friday X as a custom agent | works with the CLI today |
| **Zed** | ACP custom agent | works with the CLI today |
| **Neovim, Emacs, others with ACP** | ACP custom agent | works with the CLI today |

Install the CLI once (it is what every editor runs):

```sh
curl -fsSL https://friday.billionairestechnologies.com/x/install.sh | bash        # macOS, Linux, WSL
irm https://friday.billionairestechnologies.com/x/install.ps1 | iex               # Windows PowerShell
```

Then sign in once with `friday login` (or on first use); every editor reuses that session.

## JetBrains (ACP)

In the IDE's AI chat, open the agent settings → **Add custom agent**, or edit `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "Friday X": {
      "command": "friday",
      "args": ["agent", "stdio"]
    }
  }
}
```

On Windows use the full path if `friday` is not on the IDE's PATH (`%USERPROFILE%\.friday\bin\friday.exe`).

## Zed (ACP)

In `settings.json`:

```json
{
  "agent_servers": {
    "Friday X": {
      "command": "friday",
      "args": ["agent", "stdio"]
    }
  }
}
```

## What an editor gets over ACP

`friday agent stdio` speaks ACP over stdin/stdout: sessions, streamed answers, tool calls with diffs and permission
prompts, plan mode, slash commands, MCP servers, and the project instruction files (`FRIDAY.md`, `AGENTS.md`,
`CLAUDE.md`). Sign-in runs through the same device-code flow: the editor shows the link and code, you approve it in
your browser.

## Point an editor at a different Friday server

Set `FRIDAY_X_URL` in the environment the editor launches the agent with (the VS Code extension has a
`fridayX.serverUrl` setting for the same thing).
