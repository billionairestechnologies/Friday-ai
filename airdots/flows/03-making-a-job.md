# Making a job

This is the path from a spoken request to something the user can use.

## Steps

1. **Hear.** The user states the work and the requirements. "Build me this app." "Research this." "Draft this mail." "Make the deck." "Run it in the sandbox."
2. **Classify.** The runtime sets `kind` and `duration`.
3. **Repeat.** For anything that creates, sends, deletes, pays, or starts a loop, Friday repeats the job in one or two sentences and waits for yes. Short lookups skip this and run.
4. **Run.** Short jobs run on the call. Long jobs are queued on the runtime: build mode, deep research, the sandbox, or the scheduler.
5. **Finish.** A short job is spoken. A long job moves to `ready` or `failed` and the notifier fires.
6. **Hand off.** The link is in the app. It is also sent to every channel on the job's delivery list. They open it, or Friday reads a short summary on a callback if that was the channel.

The same steps apply if the request later arrives from the app or, in a later pass, from Telegram. The maker is the runtime. The phone is only the first door.
