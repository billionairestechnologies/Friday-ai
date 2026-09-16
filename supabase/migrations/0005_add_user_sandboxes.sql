-- ─────────────────────────────────────────────────────────────────────────
-- One CodeSandbox VM per user (real per-user isolated execution environment,
-- not just a shared process) — see codesandboxService.ts. Reused across runs
-- via resume() rather than creating a fresh VM every time; hibernated by
-- CodeSandbox itself after inactivity, not deleted, so state/installed
-- packages persist between sessions.
-- ─────────────────────────────────────────────────────────────────────────
create table public.user_sandboxes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sandbox_id text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

alter table public.user_sandboxes enable row level security;

-- Only the backend (service role) ever touches this table directly; it's an
-- implementation detail of code execution, not something the client reads.
create policy "service role only" on public.user_sandboxes
  for all using (auth.role() = 'service_role');
