"""
backend/routers/interview.py — The Interview SSE Endpoint
─────────────────────────────────────────────────────────────────────────────
This router exposes a single endpoint:

    POST /api/chat/interview

It streams the AI response back to the browser using Server-Sent Events (SSE).

WHY SSE INSTEAD OF WEBSOCKETS?
───────────────────────────────
Our communication is fundamentally one-way during a turn:
  - The client POSTs a message (HTTP is great for this — auth headers, body)
  - The server streams tokens back (SSE is perfect — simple, auto-reconnect)
  - The client POSTs the NEXT message (starts a new SSE stream)

WebSockets make sense for true bidirectional real-time (e.g., multiplayer game).
For a turn-based interview chatbot, SSE is simpler, firewall-friendlier, and
works natively with the browser's EventSource API or with fetch + ReadableStream.

SSE RESPONSE FORMAT:
─────────────────────
The response body is a sequence of SSE events:

  event: token
  data: {"text": "Great choice — Senior Software"}

  event: token
  data: {"text": " Engineer is highly sought after..."}

  ...

  event: data_extract
  data: {"step": "target_title", "advance": true, "data": {"targetTitle": "..."}}

  event: done
  data: {}

BYOK (Bring Your Own Key) EASTER EGG:
──────────────────────────────────────
If the request includes `byok_api_key`, we use THAT key instead of the server's
GEMINI_API_KEY.  This lets power users supply their own Gemini key for unlimited
usage.  We validate the key format but don't verify against Google's servers
(the first streaming call will fail naturally if the key is invalid, and the
client will receive an `event: error`).
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from ..ai_service import (
    InterviewStep,
    sanitise_extracted_data,
    stream_interview_turn,
)
from ..config import Settings, get_settings

logger = logging.getLogger("jobifai.interview")

# ─── Router ───────────────────────────────────────────────────────────────────
# Prefix and tags are set here rather than in main.py so this file is
# self-describing — you can read it in isolation and know where it mounts.
router = APIRouter(
    prefix="/api/chat",
    tags=["interview"],
)


# ─── Request / Response Models ─────────────────────────────────────────────────

class ConversationMessage(BaseModel):
    """
    A single message in the conversation history.
    Mirrors the ChatMessage type from the frontend's types/index.ts.
    """
    role:    str  # "user" | "assistant"
    content: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("user", "assistant"):
            raise ValueError("role must be 'user' or 'assistant'")
        return v


class InterviewRequest(BaseModel):
    """
    The request body for POST /api/chat/interview.

    Every field is documented here because this is the contract between
    frontend and backend — it should be obvious what each field does.
    """

    # The user's current message (what they typed in the ChatPanel input)
    user_message: str = Field(
        ...,
        min_length=1,
        max_length=4000,  # ~3k tokens, well within Gemini Flash context window
        description="The user's latest message to Mac.",
    )

    # Current position in the interview state machine (from Zustand store)
    current_step: InterviewStep = Field(
        ...,
        description="The active interview step. Drives system-prompt step behaviour.",
    )

    # BCP-47 code — Mac will converse in this language
    user_lang: str = Field(
        default="en",
        min_length=2,
        max_length=10,
        description="The language Mac replies in (e.g. 'fr', 'en-CA', 'zh-CN').",
    )

    # BCP-47 code — extracted resume data will be written in this language
    resume_lang: str = Field(
        default="en-CA",
        min_length=2,
        max_length=10,
        description="The language of the final resume document (almost always 'en-CA').",
    )

    # Prior conversation turns — used to maintain context across the interview.
    # The CURRENT user_message is NOT included in this list.
    conversation_history: list[ConversationMessage] = Field(
        default_factory=list,
        max_length=100,  # cap history to avoid context window overflow
        description="Previous messages, oldest first, excluding the current user_message.",
    )

    # BYOK Easter Egg — optional user-supplied Gemini API key.
    # If provided, we use it instead of the server's key.
    # This lets power users have unlimited usage with their own quota.
    byok_api_key: str | None = Field(
        default=None,
        min_length=39,   # Google API keys are 39 chars
        max_length=45,
        description="Optional: user's own Google AI Studio API key (BYOK).",
    )

    # Collected resume data from previous steps — included for AI context.
    # The model uses this to avoid re-asking for information it already has.
    resume_data_context: dict = Field(
        default_factory=dict,
        description="Previously extracted resume fields (passed for model context).",
    )

    # Optional target job description — when provided, Mac tailors its interview
    # questions to the JD's specific keywords, skills, and requirements.
    # This is the key differentiator between generic resume building and
    # ATS-targeted resume optimisation.
    job_description: str | None = Field(
        default=None,
        max_length=10_000,
        description="Optional: target job posting text.  Mac uses this to guide "
                    "interview questions toward the JD's specific skill requirements.",
    )

    model_config = {"json_schema_extra": {
        "example": {
            "user_message": "I was a Senior Developer at Shopify from 2021 to 2023.",
            "current_step": "experience",
            "user_lang": "en",
            "resume_lang": "en-CA",
            "conversation_history": [
                {"role": "assistant", "content": "Tell me about your most recent role!"},
            ],
        }
    }}


# ─── Dependency: Resolve API Key ───────────────────────────────────────────────

def resolve_api_key(
    body: InterviewRequest,
    settings: Settings = Depends(get_settings),
) -> str:
    """
    FastAPI dependency that resolves which Gemini API key to use.

    Priority order:
      1. BYOK key from request body (user-supplied, easter egg)
      2. Server's GEMINI_API_KEY from environment

    We validate BYOK key format (starts with 'AIza') but don't verify
    against Google's servers — a bad key will fail on the first API call,
    producing an `event: error` SSE event on the stream.
    """
    if body.byok_api_key:
        # Basic format validation — Google AI Studio keys start with 'AIza'
        if not body.byok_api_key.startswith("AIza"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid BYOK API key format. Google AI Studio keys start with 'AIza'.",
            )
        logger.info("Using BYOK Gemini API key for this request")
        return body.byok_api_key

    return settings.gemini_api_key


# ─── The SSE Endpoint ──────────────────────────────────────────────────────────

@router.post(
    "/interview",
    summary="Stream an interview turn with Mac",
    description="""
Streams the AI response for one interview turn using Server-Sent Events.

**Event types emitted:**
- `token` — A chunk of Mac's conversational reply (stream to chat UI)
- `data_extract` — Structured JSON payload with extracted resume data
- `done` — Stream complete (client should close EventSource)
- `error` — Unrecoverable error (client should show error state)

**Authentication:** Will require Supabase JWT in Task 4 (currently open).
    """,
    response_class=StreamingResponse,
    responses={
        200: {"description": "SSE stream of interview turn events"},
        400: {"description": "Invalid request body"},
        429: {"description": "Gemini rate limit hit — retry after backoff"},
        500: {"description": "Internal server error"},
    },
)
async def interview_turn(
    body: InterviewRequest,
    settings: Settings = Depends(get_settings),
    # TODO (Task 4): add Supabase JWT auth dependency here
    # current_user: User = Depends(require_authenticated_user),
) -> StreamingResponse:
    """
    POST /api/chat/interview — Single interview turn, streamed via SSE.

    The endpoint itself is thin — all business logic lives in ai_service.py.
    The router's job is:
      1. Validate the request (Pydantic handles this automatically)
      2. Resolve the API key (BYOK or server key)
      3. Start the SSE stream
      4. Return a StreamingResponse with the correct headers

    NOTE ON CORS + SSE:
    The StreamingResponse must include `Cache-Control: no-cache` and
    `X-Accel-Buffering: no` to prevent Nginx (our future reverse proxy)
    from buffering the SSE stream.  Without these, the Pi's Nginx would
    wait for the entire response before sending it, killing the streaming effect.
    """

    api_key = resolve_api_key(body, settings)

    # Convert Pydantic models to plain dicts for the ai_service layer.
    # We keep ai_service.py free of Pydantic to make it independently testable.
    history = [
        {"role": msg.role, "content": msg.content}
        for msg in body.conversation_history
    ]

    # Build the user message, optionally prepending resume context.
    # This gives the model awareness of previously extracted data without
    # polluting the conversation history with internal JSON blobs.
    user_message = body.user_message
    if body.resume_data_context:
        context_hint = (
            f"[System context — do NOT read this to the user] "
            f"Previously extracted resume data: {body.resume_data_context}"
        )
        # Prepend context as a system note inside the user turn.
        # Gemini treats this as part of the user message, but the system
        # prompt instructs Mac to treat bracketed [System context ...] as
        # internal notes.
        user_message = f"{context_hint}\n\nUser message: {user_message}"

    logger.info(
        "Interview turn — step=%s lang=%s→%s history_len=%d byok=%s jd=%s",
        body.current_step,
        body.user_lang,
        body.resume_lang,
        len(history),
        bool(body.byok_api_key),
        f"{len(body.job_description)} chars" if body.job_description else "none",
    )

    async def event_generator():
        """
        Async generator that yields raw SSE-formatted strings.

        This is what StreamingResponse calls repeatedly to build the response body.
        We add a try/except at the generator level as a last-resort safety net —
        ai_service.py already handles its own errors, but any unexpected exception
        here would otherwise cause a silent incomplete response.
        """
        try:
            async for sse_event in stream_interview_turn(
                api_key=api_key,
                user_message=user_message,
                current_step=body.current_step,
                user_lang=body.user_lang,
                resume_lang=body.resume_lang,
                history=history,
                job_description=body.job_description,
            ):
                yield sse_event
        except Exception:  # noqa: BLE001
            logger.exception("Unexpected error in SSE event generator")
            # Yield a final error + done so the client doesn't hang
            import json as _json
            yield f"event: error\ndata: {_json.dumps({'message': 'Internal server error'})}\n\n"
            yield "event: done\ndata: {}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            # SSE MUST use no-cache — tells browser not to cache the stream
            "Cache-Control": "no-cache",
            # Tells Nginx NOT to buffer — critical for real-time streaming on Pi
            "X-Accel-Buffering": "no",
            # Keep connection alive — SSE streams can be long (10-30 sec interview)
            "Connection": "keep-alive",
            # CORS for the EventSource connection (in addition to the middleware)
            "Access-Control-Allow-Origin": "*",  # tightened in Task 4 with JWT
        },
    )


# ─── Health sub-endpoint ───────────────────────────────────────────────────────

@router.get("/health", summary="AI service health check")
async def interview_health(settings: Settings = Depends(get_settings)) -> dict:
    """
    Checks that the Gemini API key is configured (not that it's valid — that
    would require an API call).  Used by monitoring dashboards.
    """
    has_key = bool(settings.gemini_api_key and len(settings.gemini_api_key) > 10)
    return {
        "status":    "ok" if has_key else "degraded",
        "ai_key":    "configured" if has_key else "missing",
        "model":     "gemini-2.5-flash",
        "byok":      "supported",
    }
