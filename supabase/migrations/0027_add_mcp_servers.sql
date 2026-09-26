-- Remote MCP servers (Model Context Protocol, Streamable HTTP) a user adds in Settings. Their tools
-- are offered to the chat agent next to Friday's built-in tools. The optional auth header value is
-- encrypted like every other connector secret.
create table if not exists public.mcp_servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  url text not null check (url ~ '^https://'),
  auth_header_encrypted text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
alter table public.mcp_servers enable row level security;
-- No policies: only the backend (service role) reads/writes this table.
