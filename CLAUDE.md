# CLAUDE.md — Friday AI

Project memory for Claude Code (VS Code / CLI / web). Read this first; keep it current when you change
architecture, commands or conventions.

## What Friday is

A multi-model AI assistant platform (web + native Android + iOS) that is now an **agent platform**:
models call real tools (web, code, the user's connected apps, MCP servers), remember users, run scheduled
automations, and Build Mode works as a coding agent that can open GitHub pull requests. Friday owns no
model — it orchestrates OpenAI, Anthropic, Gemini, OpenRouter, ScaleMax, Sarvam, Ollama (+ ElevenLabs voice).

## Repo layout

```
backend/    Express + TypeScript API (ESM, Node 22). Also serves frontend/dist in production.
frontend/   React 19 + Vite + TanStack Router + Tailwind SPA
android/    Kotlin + Jetpack Compose app        ios/  SwiftUI app (XcodeGen project.yml)
supabase/   SQL migrations 0001…0030 (apply in order; RLS on, backend uses service role)
docs/       OPERATIONS.md, PLATFORM_BRIEFING.md, UPGRADE_ROADMAP.md, diagrams/ (Mermaid .mmd → png/svg)
scripts/    verify-migrations.mjs, react preview shell generator
```

## Commands (run before every push — same as CI in .github/workflows/ci.yml)

```bash
npm --prefix backend ci && npm --prefix frontend ci      # first time
npm run verify:migrations                                  # numbering + no unguarded DROP
npm --prefix backend run typecheck
npm --prefix frontend run typecheck
npm --prefix backend test                                  # node:test via tsx, test/setup.ts gives placeholder Supabase env
npm --prefix backend run build && npm --prefix frontend run build
npm run verify                                             # all of the above in one go
cd backend && npm run dev        # API on :4000   |   cd frontend && npm run dev   # Vite on :5173, proxies /api
```

Gotchas:
- `frontend/tsconfig.tsbuildinfo` is tracked and changes on every typecheck/build — `git checkout` it, don't commit it.
- No Android SDK / Swift toolchain in cloud containers: mobile edits can't be compiled there — keep them small and review by hand.
- Don't `pkill -f <pattern>` in a shell whose own command line matches the pattern (kills your shell).

## Backend map (backend/src)

- `app.ts` routes: `/api/{health,auth,admin/providers,admin/quota,models,chat,share,push,library,memory,automations,mcp,build,voice,sandbox,usage,projects,billing,connectors,organizations,app}`
- `services/providers/` — one adapter per vendor implementing `ProviderAdapter` (`types.ts`):
  `listModels`, `chat`, `chatStream`, `healthCheck`, optional **`chatStreamWithTools`**.
  `toolCalling.ts` holds the three tool dialects: OpenAI-compatible (openai, openrouter), Anthropic
  (anthropic, scalemax), Gemini (incl. `thoughtSignature` round-trip; no-arg tools omit `parameters`).
- `services/chat/index.ts` — `streamMessage()`: the whole chat turn. Order: save user msg → parallel
  probes (live search, build intent, plan, memory) → history (+ attachments, OCR) → image gen shortcut →
  pinned context (memory + project, added AFTER trimming) → Team Up | Build Mode | **agent tool loop** |
  plain `streamWithHedging` fallback → persist + token/quota accounting.
- `services/agent/` — `toolLoop.ts` (bounded rounds, parallel calls, forced final answer, context
  compaction), `toolset.ts` (which tools a user gets + guidance/Deep Research prompts), `tools/*`
  (web, code, github, google, connectors, memory), `safeFetch.ts` (SSRF guard at socket level — use it
  for ANY server-side fetch of a user/model-supplied URL), `mcpClient.ts` + `mcpService.ts` (MCP over
  Streamable HTTP).
- `services/providers/promptCache.ts` — prompt caching shared by every dialect: Anthropic/ScaleMax
  explicit `cache_control` breakpoints (stable system block + a rolling breakpoint on the last 1-2
  messages — the growing agent-tool-loop transcript is the biggest win), OpenAI/OpenRouter
  `prompt_cache_key` + reading `cached_tokens`, Gemini's implicit caching (stable-first
  `systemInstruction.parts` + reading `cachedContentTokenCount`). `ChatMessage.volatile` marks
  per-turn-different system text (search results, Canvas snapshot, attachment nudge) so it never
  breaks the cacheable stable prefix. Kill switch: `FRIDAY_PROMPT_CACHE=off`.
- `services/projectBuild/` — Build Mode: `agent.ts` (plan → build/run/verify/fix loop → done gate),
  `tools.ts` (native tools: write_file, edit_file, read_file, list_files, grep, run_command, start_server,
  check_app, update_progress, open_pull_request, finish — the preferred path), `protocol.ts` (text-tag
  fallback `<friday-write|edit|run|start|read|grep|ls|pr|progress|done>` for models without tools),
  `sandbox.ts` (E2B; `run()` for model commands, `runScript()` for trusted scripts with env-passed values),
  `github.ts` (clone + PR). Both protocols share ONE executor; a "done" claim is only accepted after
  known-failed commands, the project's own typecheck/build/tests and a real-browser check pass
  (each skipped if the agent already passed it since its last edit). Also: `web_search`/`fetch_url`
  tools, FRIDAY.md project memory kept in every project (read back each turn, nudged at the done
  gate), `summarize.ts` (auto-compacts the transcript past 150k chars), `activity.ts` (size-capped
  step payloads: live command output, code previews, edit diffs — steps carry cmd/output/exitCode/
  path/code/lang/added/removed/startedAt/ms).
- Build workspace: `conversations.workspace = 'build'` (migration 0030) — every message goes straight
  to the Build agent. Web: `/build` + `/build/$conversationId` (Home with `workspace="build"`), its own
  "Builds" history in the sidebar (build sessions + chats with `has_build`), and the project panel
  (`BuildCanvas`: Preview / Files / Terminal) docked on the right.
- `services/automations/` — schedule math (`schedule.ts`, DST-safe) + service/scheduler (atomic lease).
- `services/memoryService.ts`, `services/chat/searchAndShare.ts`, `services/quota/*`, `services/connectorService.ts`.

## Conventions

- Comments explain WHY (often with the production incident that motivated them) — keep that style.
- zod for request validation in controllers; services throw `HttpError`.
- Every new table: numbered migration, `enable row level security`, "No policies: backend only" comment.
- Secrets at rest go through `utils/crypto.ts` (`encryptSecret`/`decryptSecret`).
- Tool results are untrusted data: never let them change instructions; the system prompt says so.
- GitHub tokens only ever go to server-built scripts via env (`runScript`), sent as a one-off header, redacted from output.
- Tools must degrade, never break chat: a model rejecting tools falls back to plain streaming.
- Clients (web/Android/iOS) must tolerate unknown SSE event fields/kinds; tool activity reuses `step` events with `kind: "tool"`.

## Current state (branch `v2`)

v2 adds: a dedicated Build workspace (own history, docked Preview/Files/Terminal), live terminals and
code/diff cards in chat while building, web lookups + FRIDAY.md memory + transcript summarisation in the
Build agent (100 rounds / 40 min), Build Mode on native tool calling with a hard verify gate, live step rows
the moment a tool call starts (`onToolStart`), lower time-to-first-token (search probe skipped when the
model has tools; toolset preloaded), SSE anti-buffering headers, a smooth adaptive typewriter + glitch-free
markdown streaming on web, and a direct/well-structured response-style prompt.

Earlier:

Shipped (see `docs/UPGRADE_ROADMAP.md` for the full list with status):
native tool calling · agent loop · web_search/fetch_url · run_code · GitHub/Gmail/Drive/Calendar/Notion/
Vercel/Railway/Supabase/Razorpay tools · MCP servers · long-term memory (+ Settings UI) · Deep Research ·
Automations (+ page) · full-text chat search · share links · Build Mode edit/grep/ls/GitHub import/PR ·
AGENTS.md/FRIDAY.md/CLAUDE.md read by Build Mode · Team Up metered · current date in prompts ·
connector audit log · fixed env-dependent tests · removed committed scratch script.

Deploy requires migrations `0023`–`0030`. Kill switches: `FRIDAY_DISABLE_TOOLS=1`, `FRIDAY_DISABLE_AUTOMATIONS=1`,
`FRIDAY_PROMPT_CACHE=off`, `FRIDAY_BUILD_NATIVE_TOOLS=off` (Build Mode back on the text protocol).

Also shipped since: prompt caching restored (Anthropic/ScaleMax/OpenAI/OpenRouter/Gemini, with
cache-aware cost accounting in `token_ledger` — migration `0028`) and Team Up now fans out to more
than 3 models when the message itself calls for it (`chat/candidates.ts#teamUpProposerCount`).

Not yet verified with real credentials: live provider tool calls, E2B clone/PR flow, connector APIs,
mobile builds.

## Next up (highest value first)

1. Android/iOS parity: Memory, MCP servers, Automations, Deep Research toggle, Share, server search.
2. Build agent: diff view; background jobs; sub-agents; one-click deploy.
3. RAG (pgvector) over chats/files; project knowledge bases.
4. Tests for chat pipeline + Build agent with mocked providers/sandbox; eval suite; OpenTelemetry.
5. CSP (Helmet has it disabled), secret scanning in CI, native reasoning controls, data-driven routing.

## Git

Develop on a feature branch; commit messages describe what + why. Never commit `.env`, tokens or user ids.
