# Friday AI — Upgrade roadmap

Every upgrade Friday needs to go from "multi-model chat app + app builder" to a full agent platform
that can stand next to ChatGPT, Claude, Grok, Gemini (as a product) and Claude Code / Codex (as a
coding agent). Grouped by area, ordered by impact inside each group.

Status: ✅ done · 🚧 partly done · ⬜ not started

---

## A. Agent core — tools the models can actually use

| # | Upgrade | Why | Status |
|---|---|---|---|
| A1 | Native tool calling in `ProviderAdapter` (OpenAI-compatible, Anthropic, ScaleMax, Gemini) with streaming tool-call parsing | Every real agent is built on structured tool use; today only text tags exist | ✅ |
| A2 | Agentic tool loop in chat (model → tool calls → results → model, bounded rounds) with graceful fallback to plain streaming | Lets chat *do* things instead of only answering | ✅ |
| A3 | `fetch_url` tool — read a full web page as text, with SSRF protection | Search snippets alone are too thin to answer from | ✅ |
| A4 | `web_search` as a tool the model calls when *it* decides (not only the pre-flight probe) | Multi-step research, follow-up queries | ✅ |
| A5 | Connectors as tools: GitHub (repos, code search, read file, issues/PRs), Gmail (search/read), Drive (search/read), Calendar (events) | Connectors are stored + verified today but never used by the model | ✅ |
| A6 | Google access-token refresh (stored refresh token) | Google tokens expire after 1h, so connector tools would silently die | ✅ |
| A7 | Tool activity shown live in chat (reuses the step rows on web/Android/iOS) and persisted on the message | Transparency — users see what Friday looked up | ✅ |
| A8 | Code-interpreter tool in chat (run Python/JS in E2B and return stdout/charts) | Data analysis, math, file conversions like ChatGPT's ADA | ✅ |
| A9 | Token connectors as tools (Notion search/read, Vercel deployments, Railway services, Supabase query, Razorpay payments) | Same reason as A5 for the remaining connectors | ✅ |
| A10 | Write actions with explicit user approval (send email, create issue, create calendar event) | Useful agents act, but only with consent | ⬜ |
| A11 | MCP client: users/admins add remote MCP servers; their tools join the tool list | Instant access to hundreds of integrations | ✅ |
| A12 | Tool-output prompt-injection guard (tool results fenced + marked untrusted in the system prompt) | Fetched pages/emails can contain hostile instructions | ✅ |

## B. Coding agent — Claude Code / Codex level

| # | Upgrade | Why | Status |
|---|---|---|---|
| B1 | Build agent on native tool calling (keep the text-tag protocol as fallback for models without tools) | Reliability; no more malformed/cut-off tags | ⬜ |
| B2 | `edit_file` (exact search/replace) instead of rewriting whole files | Big files, cheaper, fewer regressions | ✅ (text protocol `<friday-edit>`) |
| B3 | `grep` / `list_files` tools in the sandbox | Navigate real codebases | ✅ (`<friday-grep>`, `<friday-ls>`) |
| B4 | Import a GitHub repo into the sandbox (clone with the user's connector token) | Work on existing code, not only new apps | ✅ |
| B5 | Commit, push a branch and open a PR from the sandbox | The Codex/Claude Code workflow | ✅ |
| B6 | Run the project's tests/linters as a gate before "done" | Correctness, not just "it renders" | 🚧 prompted, not yet a hard gate |
| B7 | Diff view of every change in the UI (web/Android/iOS) | Reviewability | ⬜ |
| B8 | Context compaction by summarisation for long runs; raise the 45-iteration / 18-minute ceiling for background jobs | Long tasks | ⬜ |
| B9 | Background build jobs (queue + resumable progress, survives server restarts) | Tasks that take hours | ⬜ |
| B10 | Sub-agents (parallel explore/test/review workers) | Speed and quality on large tasks | ⬜ |
| B11 | Project instruction file (`FRIDAY.md` / `AGENTS.md`) read automatically | Repo-specific conventions | ✅ |
| B12 | One-click deploy (Vercel/Railway via the connectors) | Ship what was built | ⬜ |
| B13 | Friday CLI + VS Code extension talking to the same API | Work on the user's own machine | ⬜ |

## C. Memory & knowledge

| # | Upgrade | Why | Status |
|---|---|---|---|
| C1 | Long-term user memory (facts the user asks Friday to remember; model can save/forget via tools) injected into every chat | ChatGPT/Claude-style personalisation | ✅ |
| C2 | Memory management API + Settings UI (view / delete / clear) | User control and privacy | ✅ API + web (mobile ⬜) |
| C3 | Full-text search across all chats | Find old answers | ✅ |
| C4 | pgvector RAG over past chats and uploaded files | Recall beyond the 90k-char window | ⬜ |
| C5 | Project knowledge bases (upload docs once, used in every chat in the project) | Claude Projects parity | ⬜ |

## D. Research

| # | Upgrade | Why | Status |
|---|---|---|---|
| D1 | Deep Research mode (plan → many searches → read pages → synthesise a cited report) | ChatGPT/Gemini/Perplexity parity | ✅ web toggle (mobile ⬜) |
| D2 | Pluggable search providers (Brave / Tavily / Exa) beyond TinyFish + DuckDuckGo | Search quality | ⬜ |
| D3 | Inline numbered citations tied to fetched sources | Trust | 🚧 inline links + citation chips |

## E. Models & routing

| # | Upgrade | Why | Status |
|---|---|---|---|
| E1 | Data-driven routing profiles (admin-editable in DB) instead of hardcoded regex | New models without a deploy | ⬜ |
| E2 | Per-model capability metadata: tool support, context window, price | Correct routing + cost control | ⬜ |
| E3 | Native reasoning controls (Anthropic extended thinking, OpenAI `reasoning_effort`, Gemini `thinkingConfig`) instead of a prompted "Think" | Better answers from reasoning models | ⬜ |
| E4 | Prompt caching for long chats / Build Mode / the agent tool loop (Anthropic+ScaleMax explicit breakpoints, OpenAI/OpenRouter `prompt_cache_key`, Gemini implicit) | Large cost/latency savings on long contexts and multi-round agent turns | ✅ |
| E5 | Meter Team Up against the token quota | It's currently unmetered | ✅ |
| E8 | Current date in every system prompt | Models otherwise answer "latest/this year" from their training cutoff | ✅ |
| E9 | Team Up fans out to more than the default 3 models when the message itself calls for it (explicit "use N models"/"ask all models", comparison/thoroughness language, several distinct signals at once) | A hardcoded 3 undersells Team Up on genuinely hard/broad asks | ✅ |
| E6 | Structured outputs / JSON mode for internal probes | Fewer parsing failures | ⬜ |
| E7 | Rate-limit-aware failover (429 → next provider) with backoff | Reliability | 🚧 failover exists (hedgedStream); no backoff |

## F. Multimodal

| # | Upgrade | Why | Status |
|---|---|---|---|
| F1 | Realtime speech-to-speech voice mode | GPT/Gemini Live parity | ⬜ |
| F2 | File outputs (generate .docx / .pptx / .xlsx / .pdf) | Office work | ⬜ |
| F3 | More image models (OpenAI, Gemini Imagen) + video understanding | Breadth | ⬜ |

## G. Automations

| # | Upgrade | Why | Status |
|---|---|---|---|
| G1 | Scheduled prompts (cron) with push/email delivery — replaces the "Coming soon" page | Proactive assistant | ✅ |
| G2 | Triggers (webhook, new email, GitHub event) | Workflow automation | ⬜ |

## H. Platform & ecosystem

| # | Upgrade | Why | Status |
|---|---|---|---|
| H1 | Public developer API with per-user API keys + usage billing | Platform revenue | ⬜ |
| H2 | Custom assistants ("Friday Agents": instructions + tools + knowledge), shareable | GPTs / Claude Projects parity | ⬜ |
| H3 | Shareable read-only chat links | Growth | ✅ |
| H4 | Team collaboration on projects and chats | Enterprise | ⬜ |

## I. Reliability & quality

| # | Upgrade | Why | Status |
|---|---|---|---|
| I1 | Fix env-dependent backend tests (CI was red without Supabase env) | Green CI | ✅ |
| I2 | Unit tests for provider tool calling, tool loop, SSRF guard, memory | Safety net for the new core | ✅ |
| I3 | Tests for the chat pipeline and Build agent with mocked providers/sandbox | Largest untested code today | ⬜ |
| I4 | Eval suite (golden prompts, tool-use tasks, build tasks) run in CI | Measure quality, catch regressions | ⬜ |
| I5 | Observability: OpenTelemetry traces + error tracking | Debug production | ⬜ |
| I6 | Move in-memory generation state (`activeGenerations`) to Redis for multi-instance | Horizontal scaling | ⬜ |
| I7 | Job queue (Redis/BullMQ) for builds, research, automations | Long-running work | ⬜ |

## J. Security

| # | Upgrade | Why | Status |
|---|---|---|---|
| J1 | Remove the committed scratch script with a hardcoded user id (`backend/e2e5.tmp.ts`) | Hygiene / data exposure | ✅ |
| J2 | SSRF guard for any server-side URL fetch | Tool safety | ✅ |
| J3 | Content-Security-Policy (currently disabled in Helmet) | XSS hardening | ⬜ |
| J4 | Audit log entry per connector tool call | Enterprise compliance | ✅ |
| J5 | Secret scanning + dependency audit in CI | Supply chain | ⬜ |

## K. Clients

| # | Upgrade | Why | Status |
|---|---|---|---|
| K1 | Tool steps rendered on web / Android / iOS | Parity | ✅ |
| K2 | Android / iOS parity for Memory, MCP servers, Automations, Deep Research toggle, Share and server search | Parity with web | ⬜ |
| K3 | Desktop app + browser extension | Reach | ⬜ |

---

## Shipped on `claude/architecture-analysis-p7x2lr` — deploy notes

1. **Apply migrations `0023`–`0027`** (Supabase SQL editor, in order):
   `0023_add_user_memories`, `0024_add_build_project_repo`, `0025_add_automations`,
   `0026_add_chat_search_and_sharing` (adds a generated column + GIN index on `messages` — takes a
   moment on a large table), `0027_add_mcp_servers`.
2. **Environment** — nothing new is required. Optional:
   - `E2B_API_KEY` (already used by Build Mode) also enables the `run_code` tool in chat.
   - `GOOGLE_CLIENT_ID/SECRET` (already used) now also refresh expired Google connector tokens.
   - `FRIDAY_DISABLE_TOOLS=1` turns the chat tool loop off (plain streaming, as before).
   - `FRIDAY_DISABLE_AUTOMATIONS=1` stops the in-process scheduler on an instance.
3. **Behaviour changes to know about**
   - Models with native tool calling (OpenAI, Anthropic, ScaleMax, Gemini, OpenRouter) now answer
     through the tool loop in Single/Auto mode; others (Sarvam, Ollama) are unchanged. A model that
     rejects tools falls back to plain streaming automatically.
   - Team Up now counts against the token quota.
   - Tool rows render as "Used N tools" in the existing step list on web/Android/iOS.
4. **Not verified here** (needs real keys / devices): live provider tool-calling calls, E2B git
   import/PR flow, Google/Notion/Vercel/Railway/Supabase/Razorpay APIs, Android/iOS builds (no SDKs in
   the build container — the mobile edits are small and were reviewed by hand).
