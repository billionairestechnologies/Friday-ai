# Air Dots voice bridge (Pipecat + Gemini Live)

The phone number carries audio; this small service turns it into Friday's voice. Gemini Live hears
and speaks; **Friday decides every word** through `POST /api/phone/turn` on the backend, so a call
shares the person's account, memory, usage meter, sandbox and connectors.

```
carrier ── websocket audio ──> bridge (bot.py) ──> Gemini Live (voice)
                                   │
                                   ├─ /api/phone/answer   who is calling, first line (a waiting callback greeting)
                                   ├─ /api/phone/turn     every thing the caller says → Friday's line + hold/release/hangup
                                   └─ /api/phone/end      seconds billed (atomic, per plan: Pro 15 / Premium 60 min)
```

Without this bridge the trunks still work: the backend answers with `<Say>/<Gather>` in the
carrier's own TTS voice. The bridge is what makes it sound like a person.

## Run

```bash
pip install -r requirements.txt
FRIDAY_API_URL=https://friday.billionairestechnologies.com \
PHONE_GATEWAY_SECRET=… GOOGLE_API_KEY=… \
python bot.py            # listens on :8765, websocket at /ws, health at /health
```

Docker: `docker build -t friday-voice . && docker run -p 8765:8765 --env-file voice.env friday-voice`.
Deploy it as its own service (Railway / ECS) next to the API, behind TLS: carriers need `wss://`.

| Variable | Value |
|---|---|
| `FRIDAY_API_URL` | the backend's public URL |
| `PHONE_GATEWAY_SECRET` | same value as the backend |
| `GOOGLE_API_KEY` | Gemini API key |
| `FRIDAY_LIVE_MODEL` / `FRIDAY_LIVE_VOICE` | optional (defaults: native-audio preview, Aoede) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`, `TELNYX_API_KEY` | let the bridge hang those calls up |

## Wire the carriers

- **Exotel (India).** In the Exotel dashboard create an app flow with the **Voicebot** applet pointing at
  `wss://<bridge>/ws`. Set the backend's `EXOTEL_FLOW_URL` to that flow's URL
  (`http://my.exotel.com/<sid>/exoml/start_voice/<app_id>`): Call now and callbacks then dial into the
  flow. Point the inbound number at the same flow.
- **Twilio (international).** Set the backend's `PIPECAT_WS_URL=wss://<bridge>/ws`. The number's voice
  webhook stays `https://<api>/api/phone/twilio/<PHONE_GATEWAY_SECRET>`; the backend answers with
  `<Connect><Stream>` to the bridge, passing the caller's numbers as stream parameters.
- **Telnyx.** Start media streaming to `wss://<bridge>/ws` from the call-control app.

## Tested here

`bot.py` was run against Pipecat 1.12.0 with a fake Twilio media stream and a mock Friday backend:
the handshake, `/answer`, pipeline start, Gemini Live connect (rejected: fake key) and `/end` with the
call's seconds all ran. Not yet tested: a real carrier call and real Gemini audio.
