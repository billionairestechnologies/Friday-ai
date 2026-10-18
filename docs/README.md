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
| Branching (how we work) | [operations/BRANCHING.md](operations/BRANCHING.md) |
| Testing a branch | [operations/V2_TEST_AND_OPS_GUIDE.md](operations/V2_TEST_AND_OPS_GUIDE.md) |
| Mail hosting | [operations/MAIL_HOSTING.md](operations/MAIL_HOSTING.md) |
| Usage metering, plans and quotas | [operations/MONTHLY_ALLOWANCE.md](operations/MONTHLY_ALLOWANCE.md) (policy, ledger, migration 0051, rollback, tests) |
| Planning | [product/UPGRADE_ROADMAP.md](product/UPGRADE_ROADMAP.md) |
| Working on the VS Code extension | [product/FRIDAY_X_IDE.md](product/FRIDAY_X_IDE.md) (architecture, ACP facts, publishing), diagrams 23–26 |
| Showing someone the system | [diagrams/README.md](diagrams/README.md) (index) and `diagrams/BOSS_PACK.html` |

## Repo map

| Folder | What it is |
|---|---|
| `backend/` | Express + TypeScript API; also serves `frontend/dist` in production |
| `frontend/` | React 19 + Vite web app, incl. the Team Console (`/admin`) |
| `android/` · `ios/` | Native apps (Kotlin/Compose, SwiftUI) |
| `cli/` | **FridayX CLI** — terminal coding agent (Rust, Apache-2.0 fork; see its own LICENSE/NOTICE) |
| `ide/` | **FridayX for VS Code** — chat panel extension ([FRIDAY_X_IDE.md](product/FRIDAY_X_IDE.md)); JetBrains/Zed use the CLI over ACP. Same Friday models and credits as the CLI |
| `supabase/` | SQL migrations, applied in order |
| `infra/` | AWS CloudFormation + deploy script |
| `scripts/` | Repo tooling (migration verifier, preview shell generator) |

Keep these in sync when you change architecture: the diagram sources in `diagrams/`, the backend map in
[CLAUDE.md](../CLAUDE.md), and the briefing in `architecture/`.
