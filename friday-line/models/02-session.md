# Session

A phone session is a Friday session with a voice transport. Chat history, memory, and jobs are the same ones the app shows.

## Fields

- `session_id`
- `user_id`
- `transport` — `phone` or `app_voice`
- `caller_id` — verified number, phone transport only
- `interaction_id` — Sarvam call id, for the audit log
- `started_at`, `ended_at`
- `held_seconds` — time the line was actually up
- `language`
- `transcript` — written when the call ends, attached to this session so the app can show it

## Turn rule

The session is a discussion.

1. User turn arrives as text (Sarvam already transcribed it).
2. Runtime answers.
3. The answer is spoken.
4. The session waits. It does not produce another assistant turn until the user speaks again.

A clarifying question is an assistant turn. After it, the session waits. It does not stack questions.

## Authorize, then talk

The session is created only after authorize succeeds: registered user, caller ID match, plan allowed, minutes remaining. A failed authorize is not a session. It is one spoken sentence and a hang-up.
