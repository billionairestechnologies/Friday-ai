-- ─────────────────────────────────────────────────────────────────────────
-- Optional birthday, collected in Settings → Account. Powers a birthday
-- greeting and age-banded "thinking" one-liners. Entirely optional/nullable —
-- to remove this feature, `alter table public.profiles drop column birthday;`
-- undoes this migration with no other schema impact.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.profiles add column birthday date;
