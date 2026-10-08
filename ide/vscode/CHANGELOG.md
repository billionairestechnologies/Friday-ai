# Changelog

## 0.2.0
- New: a native FridayX chat panel in the sidebar (or an editor tab), like the other agent extensions. Streamed answers, tool cards with input and output, edit diffs with "View diff", plans, permission prompts, past chats, slash commands, `@` file mentions, queued messages, model picker.
- Self-contained: signs in by itself (device code in the browser, token in the OS keychain) and ships the `friday` agent inside the extension (a build per platform, like other agent extensions), so there is no download at first run. No `friday login` or CLI install needed; newer agents are fetched silently in the background.
- Mode selector (Ask first / Plan / Auto-approve) remembered per workspace; Manage screen for plugins (marketplace + any repo), MCP servers, skills and settings, all driven by the CLI's own commands.
- Shares settings, skills, plugins, MCP servers and chat history with the terminal CLI (`fridayX.isolateFromCli` keeps them separate).
- Runs on the same `friday` engine as the terminal CLI, so the models, tools and coding ability are identical, and the account, plan and usage meter are shared.
- Add the current selection or file to the chat (`Cmd/Ctrl+Alt+K`, editor and Explorer menus).
- The terminal UI is still available as "FridayX: Open Terminal UI (CLI)".

## 0.1.0
- First release: launcher for the CLI in a terminal.
