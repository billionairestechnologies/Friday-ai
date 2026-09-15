# Friday AI — Frontend

React + Vite + TypeScript SPA.

## Setup

```bash
cd frontend
npm install
npm run dev
```

Runs on `http://localhost:5173` and proxies `/api` to the backend on port 4000 (see `vite.config.ts`). For a production build, set `VITE_API_BASE_URL` to your deployed backend URL (copy `.env.example` to `.env`).

## Pages

- `/` — the chat app: sidebar of conversations, model picker (per-provider models plus Auto and
  Team Up), streaming replies, mic button for voice input, Settings (account/appearance/behavior/
  data), and a Canvas panel for code/HTML/markdown artifacts. Sign in/up happens inline from the
  account menu (email + password) — no separate route.
- `/admin` — hidden, unlinked admin gate: add/remove provider API keys, see live working/not-working
  status, re-sync discovered models, and choose which models are shown to users.

Built with `@tanstack/react-router` (client-side only — no server routes/SSR), Tailwind v4, Radix
primitives, and zustand for chat/UI state. Single- and Auto-mode replies stream token-by-token from
the backend's SSE endpoint; Team Up (fans a message out to several providers) uses the regular
JSON endpoint and shows each attributed reply once all of them land.
