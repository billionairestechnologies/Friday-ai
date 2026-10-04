# Diagrams

Sources are Mermaid. SVG and PNG sit next to each source after render.

| # | What it shows | PNG | Source |
|---|---|---|---|
| 01 | Phone, app, and CLI on one runtime | [png](01-phone-session.png) | [mmd](01-phone-session.mmd) |
| 02 | Discussion turns | [png](02-discussion.png) | [mmd](02-discussion.mmd) |
| 03 | Hold the call or release it | [png](03-hold-or-release.png) | [mmd](03-hold-or-release.mmd) |
| 04 | Making a job | [png](04-making-a-job.png) | [mmd](04-making-a-job.mmd) |
| 05 | Where the result goes | [png](05-delivery.png) | [mmd](05-delivery.mmd) |
| 06 | Co-working with a sandbox or a connected system | [png](06-coworking.png) | [mmd](06-coworking.mmd) |
| 07 | Premium gate, minutes, admin | [png](07-entitlements.png) | [mmd](07-entitlements.mmd) |
| 08 | Agents and workflows | [png](08-agents-and-workflows.png) | [mmd](08-agents-and-workflows.mmd) |
| 09 | Persona and memory on a turn | [png](09-persona-and-memory.png) | [mmd](09-persona-and-memory.mmd) |

Regenerate from this folder:

```bash
npx -p @mermaid-js/mermaid-cli mmdc -i 01-phone-session.mmd -o 01-phone-session.svg -b white
npx -p @mermaid-js/mermaid-cli mmdc -i 01-phone-session.mmd -o 01-phone-session.png -b white -s 2
```

Open [view.html](view.html) in a browser to see all nine without exporting.
