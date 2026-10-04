# Friday diagrams

Every architecture and product diagram, grouped by area. Each is a Mermaid source (`.mmd`) with generated `.svg` and `.png`.
**Do not edit the generated files or this index by hand:** edit the `.mmd` (or `diagrams.json`) and run
`node scripts/build-diagrams.mjs`.

## For leadership (one file)

Open **[BOSS_PACK.html](./BOSS_PACK.html)** in Chrome or Edge, then **Print / Save as PDF**, or download SVG/PNG under each
diagram. Or take the zip: **[friday-ai-diagrams.zip](./friday-ai-diagrams.zip)**.

## Overview

| # | Diagram | PNG | SVG | Source |
|---|---|---|---|---|
| 02 | What the system can do | [png](./overview/02-what-system-can-do.png) | [svg](./overview/02-what-system-can-do.svg) | [mmd](./overview/02-what-system-can-do.mmd) |
| 03 | What users can do | [png](./overview/03-what-users-can-do.png) | [svg](./overview/03-what-users-can-do.svg) | [mmd](./overview/03-what-users-can-do.mmd) |
| 10 | Go-live checklist | [png](./overview/10-go-live-checklist.png) | [svg](./overview/10-go-live-checklist.svg) | [mmd](./overview/10-go-live-checklist.mmd) |

## Platform

| # | Diagram | PNG | SVG | Source |
|---|---|---|---|---|
| 01 | System architecture | [png](./platform/01-system-architecture.png) | [svg](./platform/01-system-architecture.svg) | [mmd](./platform/01-system-architecture.mmd) |
| 05 | How login works (web, mobile, terminal) | [png](./platform/05-how-login-works.png) | [svg](./platform/05-how-login-works.svg) | [mmd](./platform/05-how-login-works.mmd) |
| 08 | Data model | [png](./platform/08-data-model.png) | [svg](./platform/08-data-model.svg) | [mmd](./platform/08-data-model.mmd) |
| 09 | Identity and access | [png](./platform/09-identity-and-access.png) | [svg](./platform/09-identity-and-access.svg) | [mmd](./platform/09-identity-and-access.mmd) |

## Chat and agents

| # | Diagram | PNG | SVG | Source |
|---|---|---|---|---|
| 04 | How chat works (agent loop) | [png](./chat-and-agents/04-how-chat-works.png) | [svg](./chat-and-agents/04-how-chat-works.svg) | [mmd](./chat-and-agents/04-how-chat-works.mmd) |
| 11 | Agent tool loop | [png](./chat-and-agents/11-agent-tool-loop.png) | [svg](./chat-and-agents/11-agent-tool-loop.svg) | [mmd](./chat-and-agents/11-agent-tool-loop.mmd) |
| 12 | Build Mode coding agent + GitHub PRs | [png](./chat-and-agents/12-build-mode-coding-agent.png) | [svg](./chat-and-agents/12-build-mode-coding-agent.svg) | [mmd](./chat-and-agents/12-build-mode-coding-agent.mmd) |
| 13 | Automations scheduler | [png](./chat-and-agents/13-automations.png) | [svg](./chat-and-agents/13-automations.svg) | [mmd](./chat-and-agents/13-automations.mmd) |
| 14 | MCP servers | [png](./chat-and-agents/14-mcp-servers.png) | [svg](./chat-and-agents/14-mcp-servers.svg) | [mmd](./chat-and-agents/14-mcp-servers.mmd) |
| 07 | How connectors and MCP tools work | [png](./chat-and-agents/07-how-connectors-work.png) | [svg](./chat-and-agents/07-how-connectors-work.svg) | [mmd](./chat-and-agents/07-how-connectors-work.mmd) |
| 18 | Documents, Library and skills | [png](./chat-and-agents/18-documents-library-skills.png) | [svg](./chat-and-agents/18-documents-library-skills.svg) | [mmd](./chat-and-agents/18-documents-library-skills.mmd) |

## Money and limits

| # | Diagram | PNG | SVG | Source |
|---|---|---|---|---|
| 16 | Plans, entitlements and the credit meter | [png](./money-and-limits/16-plans-entitlements-quota.png) | [svg](./money-and-limits/16-plans-entitlements-quota.svg) | [mmd](./money-and-limits/16-plans-entitlements-quota.mmd) |
| 06 | How Razorpay billing works | [png](./money-and-limits/06-how-billing-works.png) | [svg](./money-and-limits/06-how-billing-works.svg) | [mmd](./money-and-limits/06-how-billing-works.mmd) |

## Company back office

| # | Diagram | PNG | SVG | Source |
|---|---|---|---|---|
| 15 | Team Console (back office) | [png](./company/15-team-console.png) | [svg](./company/15-team-console.svg) | [mmd](./company/15-team-console.mmd) |
| 17 | Status page, incidents, problem and crash reports | [png](./company/17-status-and-reports.png) | [svg](./company/17-status-and-reports.svg) | [mmd](./company/17-status-and-reports.mmd) |

## Friday X (terminal and editor agent)

| # | Diagram | PNG | SVG | Source |
|---|---|---|---|---|
| 19 | Friday X architecture | [png](./friday-x/19-friday-x-architecture.png) | [svg](./friday-x/19-friday-x-architecture.svg) | [mmd](./friday-x/19-friday-x-architecture.mmd) |
| 20 | Friday X sign-in (device code) | [png](./friday-x/20-friday-x-device-login.png) | [svg](./friday-x/20-friday-x-device-login.svg) | [mmd](./friday-x/20-friday-x-device-login.mmd) |
| 21 | Friday X gateway and metering | [png](./friday-x/21-friday-x-gateway-metering.png) | [svg](./friday-x/21-friday-x-gateway-metering.svg) | [mmd](./friday-x/21-friday-x-gateway-metering.mmd) |
| 22 | Friday X install and release | [png](./friday-x/22-friday-x-install-release.png) | [svg](./friday-x/22-friday-x-install-release.svg) | [mmd](./friday-x/22-friday-x-install-release.mmd) |

## Regenerating

```bash
node scripts/build-diagrams.mjs            # re-render changed diagrams, rebuild index, pack and zip
node scripts/build-diagrams.mjs --all      # re-render everything
node scripts/build-diagrams.mjs --no-render   # index, pack and zip only (no browser needed)
```

Written briefing: [`../architecture/PLATFORM_BRIEFING.md`](../architecture/PLATFORM_BRIEFING.md) · Friday X: [`../product/FRIDAY_X.md`](../product/FRIDAY_X.md) · Roadmap: [`../product/UPGRADE_ROADMAP.md`](../product/UPGRADE_ROADMAP.md)
