-- 0064 Image asset lineage (docs/product/V3_PROGRAM.md, phase 09).
--
-- Every image Friday generates or edits is recorded with its owner, conversation and the image it
-- was made from: an edit is a NEW asset (version = parent's + 1) and the original is never touched.
-- A failed edit records nothing, so it can't replace the last good version. The generate_image tool
-- lists a chat's images by number so "make image 2 brighter" edits exactly that one.

create table if not exists public.image_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid,
  url text not null,
  parent_id uuid references public.image_assets (id) on delete set null,
  version int not null default 1 check (version >= 1),
  operation text not null check (operation in ('generate', 'edit', 'edit_upload')),
  prompt text not null default '',
  size text,
  created_at timestamptz not null default now()
);
-- No policies: backend only
alter table public.image_assets enable row level security;
create index if not exists image_assets_conversation_idx on public.image_assets (conversation_id, created_at);
create index if not exists image_assets_user_url_idx on public.image_assets (user_id, url);
