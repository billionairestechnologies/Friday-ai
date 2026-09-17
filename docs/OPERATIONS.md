# Friday AI operations runbook

## Release gate

Run these checks before deploying:

```bash
npm run verify:migrations
npm run typecheck
npm --prefix backend test
npm run build
```

CI runs the same checks on pull requests and pushes to `main`.

## Environment

Production must set:

- `NODE_ENV=production`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `KEY_ENCRYPTION_SECRET` with at least 32 unique bytes
- `RESEND_API_KEY`
- `CORS_ORIGIN`
- `TRUST_PROXY` when behind a reverse proxy
- `REDIS_URL` when running more than one API instance
- `PUBLIC_APP_URL` / `PUBLIC_API_URL` for OAuth redirects
- Razorpay + GitHub connector secrets when those features are enabled

Optional provider keys are managed through the admin panel. Missing provider keys should degrade
model availability, not process startup.

## Migrations

Apply every SQL file under `supabase/migrations/` in numeric order before deploying backend code
that depends on it.

Recommended deploy order:

1. Apply new migrations against staging.
2. Run the application verification checks against staging.
3. Apply new migrations against production.
4. Deploy the backend/frontend image.
5. Check `/api/health/ready`.

Rollback code first. Roll database state forward with a corrective migration rather than manually
editing existing migration files after they have reached production.

## Health checks

- `/api/health/live` confirms the process can answer HTTP.
- `/api/health/ready` and `/api/health` confirm the process is not draining and Supabase is reachable.

Use readiness for load balancers and deploy gates. Use liveness only for process restarts.

## Backups and restore

Enable Supabase point-in-time recovery for paid production projects. For launch, rehearse restore
into a staging project before every major schema change:

1. Restore the latest production backup into staging.
2. Apply pending migrations.
3. Start the app against staging.
4. Verify login, chat history, attachment reload, export, and deletion.

Keep the latest successful restore timestamp in the release notes.

## Incident response

For provider-cost or abuse incidents:

1. Disable affected models or provider keys in the admin panel.
2. Reduce relevant rate-limit environment values.
3. Restart the API after config changes.
4. Export logs filtered by `request_id` and user id where available.
5. Add a regression test or limiter before re-enabling capacity.

For failed deploys:

1. Remove the new instance from readiness.
2. Roll back to the previous image.
3. Confirm `/api/health/ready`.
4. Ship a forward migration or patch branch for data fixes.

## Current limitations

- Set `REDIS_URL` for multi-instance deployments. Without it, rate and concurrency limits are
  per-process and fall back automatically if Redis is unreachable.
- Attachments prefer Supabase Storage (`message-attachments` bucket) when
  `ATTACHMENT_OBJECT_STORAGE=true`. Inline `data_url` remains as a fallback for failed uploads.
- Provider cost telemetry records `token_usage` events from stream usage when available, with a
  conservative character-based estimate fallback. Figures are for budgets, not invoices.
- GitHub and Google (Calendar/Gmail/Drive) OAuth connectors are live when client credentials are set.
- SSO is entry-point ready via `SSO_ENABLED` / `SSO_ENTRY_URL` (and `/api/auth/sso`); configure the IdP in Supabase Auth.
