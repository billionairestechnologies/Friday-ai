# Memory

Memory is account context for the next call. It is not a second brain, and it does not live in the voice vendor.

## Write

When the call ends, store the transcript on the session. The key is the verified account (`user_id`), not the raw caller ID alone. Caller ID is only how the gateway found that account.

Also store a short session summary: last job, last delivery channel, open loops. That summary is what the next call may see.

## Read

On the next call, after authorize, inject a capped recap into the voice context:

- last job
- last delivery channel
- open loops

Do not dump the full history. A simple vector store over session summaries is enough to pick the relevant lines. The recap is context. She does not open the call by reading it aloud.

Quiet hours and language from Friday settings apply to callbacks. They do not apply to this recap.

## Limits

Memory never grants a tool. Send, delete, and pay still need a spoken yes, and a voice PIN when the action leaves the account.

The curious beat may use one line of the recap ("yesterday you left the Surat note half done") and then wait. That is still one sentence. It does not start the old job again unless they pick it up on the next turn.
