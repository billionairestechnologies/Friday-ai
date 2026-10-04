# Friday X — product and architecture

Friday X is Friday's coding agent for the **terminal** and your **editor**. Same account, plan, models and usage
meter as the web, Android and iOS apps. Diagrams: 19 (architecture), 20 (device login), 21 (gateway and metering),
22 (install and release) in [`../diagrams`](../diagrams/README.md).

## Principles

1. **The backend is the single source of truth.** No client holds a plan table, a model list or a limit. The CLI
   fetches `/api/x/v1/models`, `/v1/settings` and `/v1/user` at start; the gateway enforces everything per request.
   Edit a plan, add or remove a model, flip the Friday X entitlement in the Team Console and every installed
   terminal and editor follows, with no update.
2. **One meter.** A terminal turn is charged through the same credit accounting and 5-hour / weekly / monthly
   windows as a chat turn and appears in the same Usage breakdown (feature `code`). Clients only ever see percent
   and reset time.
3. **A Friday account is required.** There are no API keys and no anonymous mode.
4. **Private by construction.** No telemetry, analytics, crash or feedback upload. The client talks to the Friday
   backend and nothing else the forked product's vendor operated. CI enforces it (`cli/scripts/audit-egress.py`),
   and the authenticated HTTP layer refuses any Friday request outside a short allow-list.

## Who gets Friday X (admin control)

`fridayX` is an entitlement like Build Mode: **Console → Plans → (plan) → Entitlements → Friday X (CLI + IDE)**.
It is on for every plan today. To make it Pro-and-up later, switch it off for Free; to give one person access
anyway, give them a package or access grant that includes it (the personal layer wins). It is checked on **every**
request, so revoking it cuts off already-signed-in terminals within the entitlement cache TTL (30 s).

## Components

| Piece | Where |
|---|---|
| Device login, tokens, gateway, installers | `backend/src/services/cli/`, `routes/cli.ts`, `routes/install.ts`, migration `0050_friday_x.sql` |
| Web approval page and device list | `frontend/src/routes/device.tsx`, Settings → Friday X |
| The agent (Rust, Apache-2.0 fork of Grok Build) | `cli/` → binary `friday` |
| VS Code extension | `ide/vscode/` |
| JetBrains, Zed, other ACP editors | `friday agent stdio` — see `ide/README.md` |
| Release pipeline | `.github/workflows/friday-x-release.yml` |

## API surface (`/api/x`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /oauth2/device/code`, `POST /oauth2/token` | none | RFC 8628 device login (form-encoded; the CLI's native flow) |
| `POST /auth/device`, `POST /auth/token` | none | the same handshake, JSON |
| `GET /auth/device/:code`, `POST /auth/device/approve\|deny` | Friday web session | the `/device` page |
| `GET /sessions`, `DELETE /sessions/:id` | Friday web session | list and sign out devices |
| `GET /v1/models`, `/models` | Friday X token | plan-filtered list (`friday-x/auto` first); `/models` also flags locked models |
| `GET /v1/user`, `/v1/settings`, `/me` | Friday X token | account, server-driven client settings, plan and usage percent |
| `POST /v1/chat/completions` | Friday X token | the metered, OpenAI-compatible model gateway (streaming, tools, images) |

`/x/install.sh|ps1|cmd`, `/x/version`, `/x/download/<platform>`, `/x/sha256/<platform>` are public (outside `/api`).

## Operating it

| Setting | Meaning |
|---|---|
| `FRIDAY_X_RELEASES_URL` | where CI publishes binaries (`latest.json`, `v<version>/friday-<platform>[.exe][.sha256]`) |
| `FRIDAY_X_VERSION_PIN` | force a version, e.g. to pause a bad release without touching any machine |
| `FRIDAY_X_SETTINGS_JSON` | JSON object served at `/v1/settings` (fleet-wide client switches) |
| `FRIDAY_X_URL` (client) | point a CLI/editor at another Friday server (dev, staging) |

Apply migration `0050` before deploying. Signing the macOS/Windows binaries needs developer certificates (the
release workflow has the steps and skips them until the secrets exist).

## Verified

Against a mock Friday server behind a proxy that refuses every outside connection: sign-in, model list,
`AGENTS.md` / `CLAUDE.md` / `FRIDAY.md` reaching the model, a streamed answer, ACP initialize, self-update with a
checksum, and a tampered download refused. The client asks the server for exactly: models, settings, user, token,
chat completions. Not yet verified: live provider keys, a real deployment, signed binaries.
