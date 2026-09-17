# Friday AI — Backend

Express + TypeScript API. Supabase (Postgres + Auth) is the database and identity provider.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # fill in Supabase values; production also requires a strong encryption secret and Resend
npm run dev
```

Server runs on `http://localhost:4000`.

- Readiness (database included): `GET /api/health` or `GET /api/health/ready`
- Process liveness only: `GET /api/health/live`
- Security tests: `npm test`

When deployed behind a trusted reverse proxy, set `TRUST_PROXY` to its hop count so IP-based
rate limits cannot be bypassed through forwarded headers. Set `REDIS_URL` so rate and concurrency
limits are shared across API instances; without it the in-memory limiter is used automatically.

## Structure

- `src/config` — env loading, Supabase clients (service-role for backend, user-scoped for RLS)
- `src/middleware` — auth (verifies Supabase JWT, loads role), error handling
- `src/routes` / `src/controllers` — HTTP layer
- `src/services/providers` — one adapter per AI provider (OpenAI, Anthropic, Gemini, OpenRouter, Sarvam AI, ElevenLabs, Ollama), all implementing the same `ProviderAdapter` interface so the chat/admin layers never special-case a provider
- `src/utils/crypto.ts` — AES-256-GCM encryption for provider API keys at rest
