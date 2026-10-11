# Production on EC2 (what is actually live)

Production is ONE EC2 instance, not the ECS stack in `AWS_DEPLOY.md`.

- Account `095713295449`, region `ap-south-1`, instance `friday-v2` (`i-0414cc992c753285f`, m7i-flex.large).
- No SSH key and port 22 is closed. Connect with **SSM Session Manager** (EC2 → Connect → SSM Session Manager)
  or `aws ssm send-command` (AWS profile `vps`).
- Docker containers: `friday` (the API + web app, network `friday`, `--restart always`), the self-hosted
  Supabase stack (`supabase-db` Postgres 17, auth, rest, storage, realtime, studio, …), `caddy`, `redis`.
- The `friday` container's settings are env vars `PORT`, `TRUST_PROXY`, `REDIS_URL` and `FRIDAY_ENV_JSON`
  (the same JSON as the Secrets Manager secret `friday/app-env`; keep the two in step).
- Image: ECR `friday-build-app:<12-char commit>`, built in CodeBuild project `friday-build-image`
  (stack `friday-build`). The EC2 role can pull from ECR but cannot read the source S3 bucket.

## Auto-deploy (default path)

Every push to `main` that passes CI (`.github/workflows/ci.yml`, job `deploy`) builds the image in
CodeBuild and swaps the `friday` container on this instance automatically via SSM — no manual steps
below are needed for an ordinary code change. It auto-rolls back to the previous container (renamed
`friday-old` during the swap) if the post-swap health check (`$HEALTH_URL`) doesn't come back healthy
within ~60s, same as the manual rollback in step 5 below.

GitHub Actions authenticates via OIDC to IAM role `friday-github-actions-deploy` (trust restricted to
`repo:billionairestechnologies/Friday-ai:ref:refs/heads/main`; no long-lived AWS keys stored in GitHub),
with an inline policy scoped to exactly: `codebuild:StartBuild`/`BatchGetBuilds` on `friday-build-image`,
`s3:*` on the `friday-build-sourcebucket-*` bucket, `ssm:SendCommand`/`GetCommandInvocation` scoped to
instance `i-0414cc992c753285f`, and `cloudformation:DescribeStacks`. The role ARN lives in the repo
secret `AWS_DEPLOY_ROLE_ARN`.

**Database migrations are never auto-applied** — the workflow only posts a `::warning::` if a push
touches `supabase/migrations/`. Apply new migrations by hand (step 3 below) before or after the
auto-deploy lands, same care as always (back up first).

To redo a deploy manually (debugging the pipeline, or a migration needs to go first), the steps below
are exactly what the `deploy` job automates.

## Deploy a new version (manual — what the auto-deploy job does under the hood)

1. Merge to `main`, run `npm run verify`.
2. Build the image (from the repo root, AWS profile with access):
   ```bash
   TAG=$(git rev-parse --short=12 HEAD)
   BUCKET=$(aws cloudformation describe-stacks --stack-name friday-build --query "Stacks[0].Outputs[?OutputKey=='SourceBucket'].OutputValue" --output text)
   git archive --format=zip -o /tmp/source.zip HEAD && aws s3 cp /tmp/source.zip s3://$BUCKET/source.zip
   aws codebuild start-build --project-name friday-build-image \
     --environment-variables-override "name=IMAGE_TAG,value=$TAG,type=PLAINTEXT"
   ```
3. New migrations: back up first, then apply each file in order on the server:
   ```bash
   docker exec supabase-db pg_dump -U supabase_admin -d postgres | gzip > /opt/backup-$(date +%F).sql.gz
   docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -1 < 00NN_name.sql
   ```
   (The server cannot read the build bucket; send the SQL through the SSM command, base64-encoded.)
4. Swap the container, reusing the current settings, keeping the old one for rollback:
   ```bash
   IMG=095713295449.dkr.ecr.ap-south-1.amazonaws.com/friday-build-app:$TAG
   aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 095713295449.dkr.ecr.ap-south-1.amazonaws.com
   docker pull $IMG
   g(){ docker inspect friday | jq -r --arg k "$1" '.[0].Config.Env[]|select(startswith($k+"="))|sub("^[^=]*=";"")'; }
   docker stop friday && docker rename friday friday-old
   docker run -d --name friday --network friday --restart always \
     -e PORT="$(g PORT)" -e TRUST_PROXY="$(g TRUST_PROXY)" -e REDIS_URL="$(g REDIS_URL)" -e FRIDAY_ENV_JSON="$(g FRIDAY_ENV_JSON)" \
     -e FRIDAY_X_RELEASES_URL="https://friday-x-releases-095713295449.s3.ap-south-1.amazonaws.com" $IMG
   ```
   `FRIDAY_X_RELEASES_URL` is NOT in `FRIDAY_ENV_JSON`, so it must be passed on every swap — without it `/x/version` answers
   "FridayX downloads aren't published yet" and every FridayX installer and `friday update` fails (happened 2026-10-07).
   Verify with `curl -s https://friday.billionairestechnologies.com/x/version`.
   Never print `docker inspect friday` in full — it contains every secret.
5. Check `https://friday.billionairestechnologies.com/api/health` (database + redis `ok`). Roll back with
   `docker rm -f friday && docker rename friday-old friday && docker start friday`; when happy, `docker rm friday-old`.

Not yet set: `MAILCOW_URL` / `MAILCOW_API_KEY` (company mail hosting stays inactive until they are added).
