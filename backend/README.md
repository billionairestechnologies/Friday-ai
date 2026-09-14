# Friday AI — Backend

Express + TypeScript API. Supabase (Postgres + Auth) is the database and identity provider.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
npm run dev
```

Server runs on `http://localhost:4000`. Health check: `GET /api/health`.

## Structure

- `src/config` — env loading, Supabase clients (service-role for backend, user-scoped for RLS)
- `src/middleware` — auth (verifies Supabase JWT, loads role), error handling
- `src/routes` / `src/controllers` — HTTP layer
- `src/services/providers` — one adapter per AI provider (OpenAI, Anthropic, Gemini, OpenRouter, Sarvam AI, ElevenLabs, Ollama), all implementing the same `ProviderAdapter` interface so the chat/admin layers never special-case a provider
- `src/utils/crypto.ts` — AES-256-GCM encryption for provider API keys at rest
