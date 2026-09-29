# Deploying Friday (branch `v2`) on AWS

One command builds the image inside AWS and deploys it; no local Docker needed.

```
Users ──HTTPS──► Application Load Balancer (idle timeout 1 h, for long SSE streams)
                      │
                      ▼
               ECS Fargate service "api" (2+ tasks, CPU autoscaling, rollback on failed deploy)
                 │         │                 │
                 ▼         ▼                 ▼
        ElastiCache    Secrets Manager    CloudWatch Logs
          Redis        (<stack>/app-env)
                 │
                 ▼
        Supabase (Postgres + Auth + Storage) · model providers · E2B · Resend · Razorpay
```

Files: `infra/aws/friday-stack.yaml` (network, ALB, ECS, Redis, autoscaling),
`infra/aws/friday-build.yaml` (ECR, source bucket, CodeBuild), `infra/aws/buildspec.yml`,
`infra/aws/deploy.sh`, `infra/aws/app.env.example`.

## 1. Before the first deploy

1. **AWS access**: an IAM user or role allowed to manage CloudFormation, ECR, ECS, EC2 (VPC, security
   groups), Elastic Load Balancing, ElastiCache, IAM roles, Secrets Manager, CodeBuild, S3, CloudWatch
   Logs and Application Auto Scaling. Region: `ap-south-1` (Mumbai) unless you set `AWS_REGION`.
2. **Database**: apply every migration in `supabase/migrations/` (`0001…0036`) to the Supabase project
   this deployment uses, in order. All v2 migrations are additive (`create … if not exists`,
   `add column if not exists`), so applying them to an existing project is safe.
3. **Settings**: `cp infra/aws/app.env.example infra/aws/app.env` and fill it in (it's git-ignored).
   Moving from Railway: copy the values from the Railway `friday` service's Variables — keep the same
   `KEY_ENCRYPTION_SECRET`, or stored connector tokens and provider API keys can't be decrypted.

## 2. Deploy

```bash
git checkout v2 && git pull
infra/aws/deploy.sh --env-file infra/aws/app.env      # first time (stores the settings secret)
infra/aws/deploy.sh                                   # every later deploy (current commit)
```

It prints the app URL (the load balancer's DNS name) when the service is healthy. A failed deploy rolls
back automatically to the last working version.

## 3. Domain + HTTPS

1. Request a certificate in **ACM (same region)** for your domain (e.g. `friday.billionairestechnologies.com`)
   and validate it via DNS.
2. Redeploy with it: `CERTIFICATE_ARN=arn:aws:acm:... infra/aws/deploy.sh` (HTTP then redirects to HTTPS).
3. Point the domain at the load balancer: a `CNAME` (or Route 53 alias) to the `LoadBalancerDns` output.
4. Set `PUBLIC_APP_URL`, `PUBLIC_API_URL`, `SITE_URL`, `CORS_ORIGIN` to `https://your-domain` in
   `app.env` and redeploy with `--env-file`.

## 4. Point external services at the new URL

- **Google** OAuth client: authorised redirect URIs `https://your-domain/api/auth/google/callback` and
  `https://your-domain/api/connectors/google/callback`.
- **GitHub** OAuth app: callback `https://your-domain/api/connectors/github/callback`.
- **Razorpay** webhook: `https://your-domain/api/billing/razorpay/webhook` (same secret).
- **Supabase Auth**: add the domain to Site URL / redirect URLs.
- **Inbound support email** (optional): your email provider's webhook to
  `https://your-domain/api/support/inbound` with `SUPPORT_INBOUND_SECRET`.
- **Mobile apps**: their `API_BASE_URL` build setting must point at the new domain.

## 5. Operating it

- Logs: `aws logs tail /ecs/friday --follow --region ap-south-1`
- Change a setting: edit `app.env`, run `infra/aws/deploy.sh --env-file infra/aws/app.env` (running tasks
  pick it up when they're replaced — force it with
  `aws ecs update-service --cluster <ClusterName> --service <ServiceName> --force-new-deployment`).
- Scale: `DESIRED_COUNT=3 infra/aws/deploy.sh` (autoscaling adds tasks up to 6 at 60% CPU).
- Roll back: `git checkout <good-commit> && infra/aws/deploy.sh` (images are tagged by commit).
- Tear down: delete the `friday` stack, then `friday-build` (empty the ECR repo and S3 bucket first).

## Cost (ap-south-1, rough, per month)

Load balancer ≈ $20 · 2 Fargate tasks (1 vCPU, 2 GB) ≈ $65 · Redis `cache.t4g.micro` ≈ $12 · logs,
Secrets Manager, ECR, CodeBuild ≈ $5. About **$100/month** at the old 2-task sizing; defaults are now 1 task (0.5 vCPU, 1 GB) autoscaling to 3, roughly **$50/month** (raise with `DESIRED_COUNT`, `TaskCpu`, `TaskMemory`). No NAT gateway (tasks use
public IPs but only accept traffic from the load balancer).
