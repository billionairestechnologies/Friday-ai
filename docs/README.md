# Friday docs — start here

```
docs/
  architecture/   how the platform is built
  operations/     deploying, running, testing, incident runbooks
  product/        roadmap and product specs
  diagrams/       Mermaid sources + PNG/SVG exports + the one-file boss pack
```

## By role

| I am… | Read |
|---|---|
| New developer | [architecture/PLATFORM_BRIEFING.md](architecture/PLATFORM_BRIEFING.md), then the root [CLAUDE.md](../CLAUDE.md) (commands, conventions, backend map) |
| Deploying / on call | [operations/OPERATIONS.md](operations/OPERATIONS.md) (env vars, runbook), [operations/EC2_DEPLOY.md](operations/EC2_DEPLOY.md) (live production), [operations/AWS_DEPLOY.md](operations/AWS_DEPLOY.md) (ECS option) |
| Testing a branch | [operations/V2_TEST_AND_OPS_GUIDE.md](operations/V2_TEST_AND_OPS_GUIDE.md) |
| Mail hosting | [operations/MAIL_HOSTING.md](operations/MAIL_HOSTING.md) |
| Planning | [product/UPGRADE_ROADMAP.md](product/UPGRADE_ROADMAP.md) |
| Showing someone the system | [diagrams/README.md](diagrams/README.md) (index) and `diagrams/BOSS_PACK.html` |

## Repo map

| Folder | What it is |
|---|---|
| `backend/` | Express + TypeScript API; also serves `frontend/dist` in production |
| `frontend/` | React 19 + Vite web app, incl. the Team Console (`/admin`) |
| `android/` · `ios/` | Native apps (Kotlin/Compose, SwiftUI) |
| `cli/` | **Friday X CLI** — terminal coding agent (Rust, Apache-2.0 fork; see its own LICENSE/NOTICE) |
| `ide/` | **Friday X IDE extensions** — VS Code first, then JetBrains and other ACP editors; same Friday login, models and credits as the CLI |
| `supabase/` | SQL migrations, applied in order |
| `infra/` | AWS CloudFormation + deploy script |
| `scripts/` | Repo tooling (migration verifier, preview shell generator) |

Keep these in sync when you change architecture: the diagram sources in `diagrams/`, the backend map in
[CLAUDE.md](../CLAUDE.md), and the briefing in `architecture/`.
