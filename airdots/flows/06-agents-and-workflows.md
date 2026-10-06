# Agents and workflows

Loops and schedules are Friday jobs. The phone creates and controls them. It does not host them.

## Always-on agent or a loop

1. They describe what should keep running.
2. Friday repeats it and waits for yes.
3. On yes, the agent runtime starts the loop and the call ends.
4. Later they call and ask "where is that?" That status read is a short job and is spoken.
5. "Pause it" or "change it" is another short or long job on the same agent, with a yes when the change is destructive.
6. One word, "rukho" or "stop", pauses the loop immediately. The job moves to `paused`. The loop stays in the agent runtime. The line does not keep hosting it.

## Workflow

1. They describe the trigger and the work. "Every morning, research this and email it."
2. Friday repeats the trigger, the action, and the channel, and waits for yes.
3. The scheduler stores the workflow.
4. When it fires, it runs as a job with the delivery stored on the workflow.
5. They can edit or cancel it from a later call, from the app, or from the CLI. Same record.
