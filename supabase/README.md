# Supabase schema

Run `migrations/0001_init.sql` once against your Supabase project (SQL editor, or `supabase db push` if you use the CLI).

## Making the first admin

New sign-ups default to `role = 'user'`. To promote yourself to admin so you can open the Admin Panel, run in the SQL editor:

```sql
update public.profiles set role = 'admin' where id = '<your-auth-user-id>';
```

Find `<your-auth-user-id>` under Authentication → Users in the Supabase dashboard, or via `select id, email from auth.users;`.

## Tables

| Table | Purpose |
|---|---|
| `profiles` | name + role (`user`/`admin`) per auth user |
| `providers` | fixed catalog: OpenAI, Anthropic, Gemini, OpenRouter, Sarvam AI, ElevenLabs, Ollama |
| `provider_api_keys` | admin-added keys, stored encrypted (AES-256-GCM) by the backend, admin-only via RLS |
| `provider_models` | models auto-discovered per provider; admin flips `is_enabled_for_users` to show/hide in the picker |
| `conversations` / `messages` | chat history, one row per turn, owner-only via RLS |
