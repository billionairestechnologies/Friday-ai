# FridayX

**FridayX** (`friday`) is Friday's coding agent for the terminal and your editor. It reads your project, edits
files, runs commands and manages long tasks, using your Friday account: the same plan, the same models and the
same usage meter as the Friday web, Android and iOS apps.

It is a modified fork of [Grok Build](https://github.com/xai-org/grok-build) (Apache-2.0). See
[NOTICE](NOTICE) for what changed.

## Install

```sh
# macOS, Linux, WSL
curl -fsSL https://friday.billionairestechnologies.com/x/install.sh | bash

# Windows PowerShell
irm https://friday.billionairestechnologies.com/x/install.ps1 | iex

# Windows CMD
curl -fsSL https://friday.billionairestechnologies.com/x/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Then run `friday` in any project. The first run opens your browser to sign in with your Friday account.
`friday update` upgrades in place (the download is verified against a published SHA-256 first).

## How it fits together

- **Login:** a device-code flow. `friday login` shows a short code, you approve it in the signed-in web app
  (`/device`), and the CLI keeps a revocable token. Sign a device out from the web app: Settings → FridayX.
- **Models and limits come from the server.** `friday models` lists what your plan allows; the default,
  `friday-x/auto`, lets the server pick the best coding model. Change a plan, add or remove a model in the
  Team Console and every terminal and editor sees it at its next start. Nothing about plans or models is
  compiled in.
- **One meter.** Terminal usage drains the same bar as the apps; the CLI shows percent used and reset time only.
- **Project memory:** FridayX reads `AGENTS.md`, `CLAUDE.md` and Cursor rules, and keeps its own `FRIDAY.md`
  (the same file web Build Mode keeps) so a project moves between the two without translation.
- **Private by construction:** no telemetry, no analytics, no feedback uploads. The client talks to the Friday
  backend and nothing else the original product's vendor operated. `scripts/audit-egress.py` enforces that
  in CI, and the authenticated HTTP layer refuses any request to the Friday server outside a short allow-list.

## Editors

FridayX speaks the Agent Client Protocol (ACP): `friday agent stdio` runs it as an agent for JetBrains IDEs, Zed and any
other ACP editor. A VS Code extension lives in [`../ide/vscode`](../ide/vscode).

## Building from source

Requirements: the Rust toolchain pinned in [`rust-toolchain.toml`](rust-toolchain.toml) (rustup installs it) and
`protoc` (`PROTOC=/path/to/protoc` if it is not on `PATH`).

```sh
cargo build -p xai-grok-pager-bin            # target/debug/friday
cargo build --profile release-dist -p xai-grok-pager-bin
```

Point a build at a local backend with `FRIDAY_X_URL=http://localhost:4000`.

## Layout

| Path | Contents |
|------|----------|
| `crates/codegen/xai-grok-pager-bin` | Composition root; builds the `friday` binary |
| `crates/codegen/xai-grok-pager` | The TUI |
| `crates/codegen/xai-grok-shell` | Agent runtime, headless and ACP entry points |
| `crates/codegen/xai-grok-login` | Sign-in (Friday device code), token storage |
| `crates/codegen/xai-grok-update` | `friday update` against the Friday release endpoints |
| `crates/codegen/xai-grok-tools` | Tool implementations (terminal, file edit, search…) |
| `scripts/audit-egress.py` | Fails if a vendor host appears in production code |

The crate names keep their original `xai-*` prefixes to keep upstream merges tractable.

## License

Apache License 2.0 ([LICENSE](LICENSE)); third-party notices in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
