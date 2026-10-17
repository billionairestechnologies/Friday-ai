-- 0067 Team skills + skill scripts (docs/product/V3_PROGRAM.md, phase 13).
--
-- A published user skill can be SHARED with one of the author's organisations. An org owner/admin
-- reviews it (pending → approved | rejected); approved skills appear for every member as read-only
-- "Team skills" that run with the author's declared capabilities (still enforced by the tool loop).
-- The author keeps editing; members always get the latest PUBLISHED version. Unsharing is instant.
-- Scripts live inside the manifest (skill_versions.manifest / user_skills.scripts) and only ever run
-- in the isolated code sandbox (run_skill_script), never in the server process.

alter table public.user_skills
  add column if not exists organization_id uuid references public.organizations (id) on delete set null,
  add column if not exists share_status text not null default 'private',
  add column if not exists share_reviewed_by uuid,
  add column if not exists share_reviewed_at timestamptz,
  add column if not exists scripts jsonb not null default '[]'::jsonb;
do $$ begin
  alter table public.user_skills add constraint user_skills_share_status_check check (share_status in ('private', 'pending', 'approved', 'rejected'));
exception when duplicate_object then null; end $$;
create index if not exists user_skills_org_idx on public.user_skills (organization_id, share_status) where organization_id is not null;
