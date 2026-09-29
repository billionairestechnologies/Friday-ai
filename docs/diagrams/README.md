# Friday AI diagrams (downloadable)

All architecture and product diagrams live in this folder (updated on branch `v2`: Team Console, plans & entitlements, usage metering, status page, documents, Library and skills — on top of the agent-platform upgrade).

## For your boss (one file)

1. Download **[BOSS_PACK.html](./BOSS_PACK.html)**
2. Open it in Chrome or Edge
3. Use **Print / Save as PDF**, or download SVG/PNG under each diagram

Or download the zip: **[friday-ai-diagrams.zip](./friday-ai-diagrams.zip)**

## Diagram index

| # | What it shows | PNG | SVG | Source |
|---|---|---|---|---|
| 01 | System architecture | [png](./01-system-architecture.png) | [svg](./01-system-architecture.svg) | [mmd](./01-system-architecture.mmd) |
| 02 | What the system can do | [png](./02-what-system-can-do.png) | [svg](./02-what-system-can-do.svg) | [mmd](./02-what-system-can-do.mmd) |
| 03 | What users can do | [png](./03-what-users-can-do.png) | [svg](./03-what-users-can-do.svg) | [mmd](./03-what-users-can-do.mmd) |
| 04 | How chat works (agent loop) | [png](./04-how-chat-works.png) | [svg](./04-how-chat-works.svg) | [mmd](./04-how-chat-works.mmd) |
| 05 | How login works | [png](./05-how-login-works.png) | [svg](./05-how-login-works.svg) | [mmd](./05-how-login-works.mmd) |
| 06 | How Razorpay billing works | [png](./06-how-billing-works.png) | [svg](./06-how-billing-works.svg) | [mmd](./06-how-billing-works.mmd) |
| 07 | How connectors and MCP tools work | [png](./07-how-connectors-work.png) | [svg](./07-how-connectors-work.svg) | [mmd](./07-how-connectors-work.mmd) |
| 08 | Data model | [png](./08-data-model.png) | [svg](./08-data-model.svg) | [mmd](./08-data-model.mmd) |
| 09 | Identity and access | [png](./09-identity-and-access.png) | [svg](./09-identity-and-access.svg) | [mmd](./09-identity-and-access.mmd) |
| 10 | Go-live checklist | [png](./10-go-live-checklist.png) | [svg](./10-go-live-checklist.svg) | [mmd](./10-go-live-checklist.mmd) |
| 11 | Agent tool loop | [png](./11-agent-tool-loop.png) | [svg](./11-agent-tool-loop.svg) | [mmd](./11-agent-tool-loop.mmd) |
| 12 | Build Mode coding agent + GitHub PRs | [png](./12-build-mode-coding-agent.png) | [svg](./12-build-mode-coding-agent.svg) | [mmd](./12-build-mode-coding-agent.mmd) |
| 13 | Automations scheduler | [png](./13-automations.png) | [svg](./13-automations.svg) | [mmd](./13-automations.mmd) |
| 14 | MCP servers | [png](./14-mcp-servers.png) | [svg](./14-mcp-servers.svg) | [mmd](./14-mcp-servers.mmd) |
| 15 | Team Console (back office) | [png](./15-team-console.png) | [svg](./15-team-console.svg) | [mmd](./15-team-console.mmd) |
| 16 | Plans, entitlements and usage metering | [png](./16-plans-entitlements-quota.png) | [svg](./16-plans-entitlements-quota.svg) | [mmd](./16-plans-entitlements-quota.mmd) |
| 17 | Status page, incidents, problem and crash reports | [png](./17-status-and-reports.png) | [svg](./17-status-and-reports.svg) | [mmd](./17-status-and-reports.mmd) |
| 18 | Documents, Library and skills | [png](./18-documents-library-skills.png) | [svg](./18-documents-library-skills.svg) | [mmd](./18-documents-library-skills.mmd) |

## Regenerating

Edit the `.mmd` source, then render with mermaid-cli:

```bash
npx -p @mermaid-js/mermaid-cli mmdc -i 11-agent-tool-loop.mmd -o 11-agent-tool-loop.svg -b white
npx -p @mermaid-js/mermaid-cli mmdc -i 11-agent-tool-loop.mmd -o 11-agent-tool-loop.png -b white -s 2
```

`BOSS_PACK.html` embeds the `.mmd` sources — regenerate its sections when a source changes.

Written briefing (no images required): [`../PLATFORM_BRIEFING.md`](../PLATFORM_BRIEFING.md) · Upgrade roadmap: [`../UPGRADE_ROADMAP.md`](../UPGRADE_ROADMAP.md)
