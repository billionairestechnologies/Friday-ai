# Memory

One store per user. The Friday website, the Air Dot, and the phone share it. There is no call-only memory and no second memory for the bot.

The key is `user_id`. Caller ID is only how the gateway found that account.

## What is kept

Nothing the user says is dropped.

- Website chat, already on the account
- Every call transcript, written when the line ends
- Every Air Dot job: the request, the steps, the result, the open loops
- Preferences, names, and the passphrase hash

## What a new call or a new Dot run sees

Both load the same user memory before the first reply.

The live voice session receives the memories that match this conversation, plus the open loops. It does not receive a replay of every past minute of audio. Those minutes are already saved as text. Loading them again as audio would re-bill Gemini and end the call.

She can answer from any of it. "What did I say last time" is a lookup, not a guess. She does not recite the archive as a greeting.

## Limits

Memory never grants a tool. Send, delete, and pay still need a spoken yes, and the passphrase when the action leaves the account.

Quiet hours and language apply to callbacks. They do not delete memory.
