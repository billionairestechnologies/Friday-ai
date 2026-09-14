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

- `/auth` — sign up (name, email, password) or log in, with a model-preference selector; Google sign-in is visible but locked
- `/chat` — pick a model to start a conversation, chat, and use the mic button to speak instead of type
- `/admin` — admin-only: add/remove provider API keys, see live working/not-working status, re-sync discovered models, and choose which models are shown to users
