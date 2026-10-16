"""
Friday's voice on the phone: Pipecat carries the call audio between the carrier and Gemini Live.

    Exotel (India, Voicebot applet)  ─┐
    Twilio (Media Streams)           ─┼─ websocket ─> this bridge ─> Gemini Live (ear + mouth)
    Telnyx (media streaming)         ─┘                    │
                                                           └─ ask_friday ─> Friday API /api/phone/turn

Gemini Live only hears and speaks. Every request goes to Friday through the ask_friday tool, so the
call shares the person's account, memory, usage meter, sandbox and connectors, and the Friday backend
decides the words, when the line is released, and what needs a yes + passphrase (services/phone/*).

Environment:
    FRIDAY_API_URL         https://friday.billionairestechnologies.com   (the backend)
    PHONE_GATEWAY_SECRET   same value as the backend's PHONE_GATEWAY_SECRET
    GOOGLE_API_KEY         Gemini API key
    FRIDAY_LIVE_MODEL      optional, default models/gemini-2.5-flash-native-audio-preview-12-2025
    FRIDAY_LIVE_VOICE      optional, default Aoede
    TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN, TELNYX_API_KEY   (let Pipecat hang up those calls)
"""

import asyncio
import os
import time

import httpx
from fastapi import FastAPI, WebSocket
from loguru import logger

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import EndTaskFrame, LLMMessagesAppendFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameDirection
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.services.google.gemini_live.llm import ContextWindowCompressionParams, GeminiLiveLLMService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner

FRIDAY_API_URL = os.environ.get("FRIDAY_API_URL", "http://localhost:4000").rstrip("/")
GATEWAY_SECRET = os.environ.get("PHONE_GATEWAY_SECRET", "")
MODEL = os.environ.get("FRIDAY_LIVE_MODEL", "models/gemini-2.5-flash-native-audio-preview-12-2025")
VOICE = os.environ.get("FRIDAY_LIVE_VOICE", "Aoede")

VOICE_INSTRUCTION = """You are the voice of Friday on a phone call. You do not decide what to say: Friday does.
- When the call connects you are given a line. Say exactly that line, then listen.
- Whenever the caller says something that needs an answer, call ask_friday with their exact words (in their language).
  While it runs you may say one very short filler like "one sec" or "ek second", nothing else.
- Then say the `say` text from the result exactly, word for word. Add nothing, drop nothing, no questions of your own.
- If the result's `then` is "hangup" or "release", say the line and call end_call.
- Pure backchannel ("hello?", "hmm", "are you there?") gets a short "I'm here." without calling ask_friday.
- If the caller talks over you, stop speaking and listen.
Speak naturally and warmly, at a conversational pace, in English or Hindi as the caller does."""

app = FastAPI()
http = httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=5.0))


async def friday(path: str, body: dict) -> dict:
    res = await http.post(f"{FRIDAY_API_URL}/api/phone/{path}", json=body, headers={"x-friday-phone-secret": GATEWAY_SECRET})
    res.raise_for_status()
    return res.json()


def serializer_for(transport_type: str, call):
    """The carrier's wire format (μ-law 8 kHz etc.), resampled by Pipecat to Gemini's rates."""
    if transport_type == "twilio":
        from pipecat.serializers.twilio import TwilioFrameSerializer

        sid, token = os.getenv("TWILIO_ACCOUNT_SID", ""), os.getenv("TWILIO_AUTH_TOKEN", "")
        # With credentials, ending the pipeline hangs the call up too; without them the carrier
        # hangs up when the stream closes.
        return TwilioFrameSerializer(
            stream_sid=call["stream_id"],
            call_sid=call["call_id"],
            account_sid=sid,
            auth_token=token,
            params=TwilioFrameSerializer.InputParams(auto_hang_up=bool(sid and token)),
        )
    if transport_type == "exotel":
        from pipecat.serializers.exotel import ExotelFrameSerializer

        return ExotelFrameSerializer(stream_sid=call["stream_id"], call_sid=call["call_id"])
    if transport_type == "telnyx":
        from pipecat.serializers.telnyx import TelnyxFrameSerializer

        key = os.getenv("TELNYX_API_KEY", "")
        return TelnyxFrameSerializer(
            stream_id=call["stream_id"],
            call_control_id=call["call_id"],
            outbound_encoding=call["outbound_encoding"],
            inbound_encoding="PCMU",
            api_key=key,
            params=TelnyxFrameSerializer.InputParams(auto_hang_up=bool(key)),
        )
    raise ValueError(f"unsupported carrier {transport_type}")


def numbers(transport_type: str, call) -> tuple[str, str]:
    # Twilio carries them as <Parameter>s the backend put in the <Stream> (phone/trunk.ts renderTwilioStream).
    body = call.get("body", {}) or {}
    caller = call.get("from") or body.get("from") or ""
    callee = call.get("to") or body.get("to") or ""
    return str(caller), str(callee)


@app.get("/health")
async def health():
    return {"ok": True}


@app.websocket("/ws")
async def call(websocket: WebSocket):
    await websocket.accept()
    transport_type, call_data = await parse_telephony_websocket(websocket)
    session_id = str(call_data["call_id"])
    caller, callee = numbers(transport_type, call_data)
    started = time.monotonic()
    logger.info(f"call {session_id} via {transport_type}")

    # Who is this, and what does Friday say first? (a waiting callback greeting, or "Friday here.")
    try:
        first = await friday("answer", {"from": caller, "to": callee, "sessionId": session_id, "trunk": transport_type})
    except Exception as err:  # Friday unreachable: say so and hang up rather than leave dead air
        logger.error(f"answer failed: {err}")
        first = {"speak": "Friday can't take calls right now. Please try again in a minute.", "hangup": True}

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer_for(transport_type, call_data),
        ),
    )

    async def ask_friday(params: FunctionCallParams):
        text = str(params.arguments.get("text", "")).strip()
        if not text:
            await params.result_callback({"say": "Sorry, say that again?", "then": "listen"})
            return
        try:
            turn = await friday("turn", {"from": caller, "text": text, "sessionId": session_id, "trunk": transport_type})
            await params.result_callback({"say": turn.get("speak") or "", "then": turn.get("action") or "listen"})
        except Exception as err:
            logger.error(f"turn failed: {err}")
            await params.result_callback({"say": "Something went wrong on my side. It's saved in the app.", "then": "hangup"})

    async def end_call(params: FunctionCallParams):
        await params.result_callback({"ok": True})
        await params.llm.push_frame(EndTaskFrame(), FrameDirection.UPSTREAM)

    tools = ToolsSchema(
        standard_tools=[
            FunctionSchema(
                name="ask_friday",
                description="Send what the caller said to Friday. Returns `say` (speak it exactly) and `then` (listen, hold, speak, hangup or release).",
                properties={"text": {"type": "string", "description": "The caller's exact words."}},
                required=["text"],
                handler=ask_friday,
            ),
            FunctionSchema(
                name="end_call",
                description="Hang up. Only after saying Friday's last line when `then` was hangup or release.",
                properties={},
                required=[],
                handler=end_call,
            ),
        ]
    )

    llm = GeminiLiveLLMService(
        api_key=os.environ["GOOGLE_API_KEY"],
        system_instruction=VOICE_INSTRUCTION,
        tools=tools,
        settings=GeminiLiveLLMService.Settings(
            model=MODEL,
            voice=VOICE,
            # Long calls must not re-bill all earlier audio on every turn.
            context_window_compression=ContextWindowCompressionParams(enabled=True, trigger_tokens=8000),
        ),
    )

    opening = (first.get("speak") or "Friday here.").strip()
    then = "Then call end_call." if first.get("hangup") else "Then listen."
    context = LLMContext([{"role": "user", "content": f"(The call just connected.) Say exactly this: \"{opening}\" {then}"}])
    aggregators = LLMContextAggregatorPair(context)

    pipeline = Pipeline([transport.input(), aggregators.user(), llm, transport.output(), aggregators.assistant()])
    worker = PipelineWorker(pipeline, params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000), idle_timeout_secs=120)
    runner = WorkerRunner(handle_sigint=False)

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(_transport, _client):
        seconds = int(time.monotonic() - started)
        try:
            await friday("end", {"sessionId": session_id, "seconds": seconds})
        except Exception as err:
            logger.error(f"end failed: {err}")
        await runner.cancel()

    await runner.add_workers(worker)
    await runner.run()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8765")))
