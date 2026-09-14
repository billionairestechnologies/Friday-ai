# Friday AI

Multi-model AI chat platform. Users chat with any AI model (OpenAI, Anthropic, Gemini, OpenRouter, Sarvam AI, ElevenLabs, Ollama) selected from a model picker on the auth and chat pages, with mic-based speech-to-text. Admins manage provider API keys, auto-discover available models per provider, choose which models are shown to users, and monitor live health (working/not working) of every key from the Admin Panel — no redeploy needed to add/remove a provider key or model.

## Repo layout

```
backend/    Node.js + TypeScript + Express API, Supabase (Postgres) as the database
frontend/   React + Vite + TypeScript SPA (Auth, Chat, Admin Panel)
supabase/   SQL migrations (schema for profiles, providers, api_keys, models, conversations, messages)
```

## Branching model

This repo is built branch-by-branch, one feature per branch, merged into `main` only once that slice works on its own:

- `feature/backend-scaffold` — Express/TS server skeleton
- `feature/db-schema` — Supabase SQL schema
- `feature/auth` — Supabase Auth (name + email + password; Google sign-in wired but locked)
- `feature/provider-management` — provider adapters + admin CRUD for API keys/models + health checks
- `feature/chat` — chat API routed through the selected provider/model
- `feature/voice` — speech-to-text endpoint for the mic button
- `feature/frontend-scaffold` — React app: Auth page, Chat page, Admin Panel

## Getting started

See `backend/README.md` and `frontend/README.md` for setup once those branches land.
