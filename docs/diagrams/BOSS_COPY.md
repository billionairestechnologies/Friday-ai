# Friday AI — copy for your boss

**Branch:** `cursor/cloud-agent-1789643679414-qaev6` · **PR:** #2 · **Folder:** `docs/diagrams/`

Friday AI is now a production-shaped assistant platform: secure login, saved chats and files, teams, Razorpay billing, app connectors, and usage/cost tracking.

**Users can** sign in (email OTP, Google, or company SSO), chat, attach files, use Search / Think / Canvas / voice, create Work or Developer projects, connect GitHub/Google/Notion and other tools, pay on Razorpay, and export or delete their data.

**To go live** apply Supabase migrations `0001`–`0014`, set production secrets, deploy, then check `/api/health/ready`.

Download the full pack: [friday-ai-diagrams.zip](./friday-ai-diagrams.zip) or open [BOSS_PACK.html](./BOSS_PACK.html) and Print → Save as PDF.

## System architecture

![System architecture](./01-system-architecture.png)

## What the system can do

![What the system can do](./02-what-system-can-do.png)

## What users can do

![What users can do](./03-what-users-can-do.png)

## How chat works

![How chat works](./04-how-chat-works.png)

## How login works

![How login works](./05-how-login-works.png)

## How billing works

![How Razorpay billing works](./06-how-billing-works.png)

## How connectors work

![How connectors work](./07-how-connectors-work.png)

## Data model

![Data model](./08-data-model.png)

## Identity and access

![Identity and access](./09-identity-and-access.png)

## Go-live checklist

![Go-live checklist](./10-go-live-checklist.png)
