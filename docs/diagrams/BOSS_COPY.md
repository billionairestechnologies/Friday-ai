# Friday AI — copy for your boss

**Branch:** `claude/architecture-analysis-p7x2lr` · **Folder:** `docs/diagrams/`

Friday AI is now an agent platform, not only a multi-model chat app: models use real tools (web search and full page reading, code execution, the user's connected GitHub / Gmail / Drive / Calendar / Notion / Vercel / Railway / Supabase / Razorpay, and any MCP server), remember users across chats, run scheduled Automations, and Build Mode works like a coding agent that can open GitHub pull requests.

**Users can** chat with any model (Single / Auto / Team Up), turn on Deep Research for cited reports, let Friday remember facts, schedule daily/weekly automations with push notifications, search every past message, share read-only chat links, connect apps and MCP servers, build and run projects, and pay on Razorpay.

**To go live** apply Supabase migrations `0001`–`0027`, set production secrets, deploy, then check `/api/health/ready`.

Download the full pack: [friday-ai-diagrams.zip](./friday-ai-diagrams.zip) or open [BOSS_PACK.html](./BOSS_PACK.html) and Print → Save as PDF.

## System architecture

![System architecture](./01-system-architecture.png)

## What the system can do

![What the system can do](./02-what-system-can-do.png)

## What users can do

![What users can do](./03-what-users-can-do.png)

## How chat works (agent loop)

![How chat works (agent loop)](./04-how-chat-works.png)

## How login works

![How login works](./05-how-login-works.png)

## How Razorpay billing works

![How Razorpay billing works](./06-how-billing-works.png)

## How connectors and MCP tools work

![How connectors and MCP tools work](./07-how-connectors-work.png)

## Data model

![Data model](./08-data-model.png)

## Identity and access

![Identity and access](./09-identity-and-access.png)

## Go-live checklist

![Go-live checklist](./10-go-live-checklist.png)

## Agent tool loop

![Agent tool loop](./11-agent-tool-loop.png)

## Build Mode coding agent + GitHub PRs

![Build Mode coding agent + GitHub PRs](./12-build-mode-coding-agent.png)

## Automations scheduler

![Automations scheduler](./13-automations.png)

## MCP servers

![MCP servers](./14-mcp-servers.png)
