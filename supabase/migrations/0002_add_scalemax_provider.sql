-- ─────────────────────────────────────────────────────────────────────────
-- Adds ScaleMax as a provider: an Anthropic-compatible proxy for Claude
-- models (Opus 5, Sonnet 5, Fable 5).
-- ─────────────────────────────────────────────────────────────────────────
insert into public.providers (slug, display_name, base_url) values
  ('scalemax', 'ScaleMax (Claude)', 'https://api.scalemax.pro/token/v1')
on conflict (slug) do nothing;
