# Delivery

## On the call

They name the place in the same turn, or after the result.

- "Just tell me." → `call`
- "Put it in the app." → `app`
- "Send it on Telegram." → `telegram`
- "WhatsApp." → `whatsapp`, if admin has it on
- "Email it." → `email`
- "Telegram and email." → both

## When they do not name a place

Friday settings supply the list. The app still stores the artifact.

## After a long job

The call is already over. The notifier sends `running` when there is something worth saying, then `ready` with the link, or `failed` with one line. A callback is a new short call, only if `call` is on the list, quiet hours allow it, and minutes remain.

## WhatsApp

The channel is in the model so a user can choose it. The transport stays off until it can be used without a per-message bill. Until that flag flips, Friday says WhatsApp is not on yet and uses the next channel they have.
