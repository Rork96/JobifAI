"""
backend/ai_service.py — Gemini AI Service Layer
─────────────────────────────────────────────────────────────────────────────
This module owns ALL AI-specific logic.  Nothing else in the codebase should
import google.generativeai directly — all Gemini interactions go through here.

ARCHITECTURE — How do we get BOTH streaming text AND structured data?
─────────────────────────────────────────────────────────────────────
The fundamental challenge: we need the AI to simultaneously produce:
  1. A streaming conversational response (for the real-time typewriter effect)
  2. A structured JSON payload (to update DocumentPreview live)

Option A — Two API calls (extract after stream): Simple but doubles cost + latency.
Option B — Gemini Function Calling: Clean separation but function execution
           doesn't stream, so we still need a separate content stream.
Option C — Sentinel-delimited single stream (our choice):
           The system prompt instructs Gemini to output its response in two
           clearly separated sections divided by a sentinel token [DATA_EXTRACT]:

           [Conversational text in USER_LANG, streams to chat UI]
           [DATA_EXTRACT]
           {"step": "...", "advance": true, "data": {...structured JSON...}}

           The backend parser:
             • Forwards every chunk BEFORE the sentinel to the SSE stream in real-time
             • Once the sentinel is detected, switches to JSON-accumulation mode
             • After stream ends, parses and emits a single `data_extract` SSE event

           RESULT: Single API call, true real-time streaming for conversation,
           reliable structured extraction, no extra latency.

SENTINEL DETECTION DURING STREAMING:
─────────────────────────────────────
The sentinel [DATA_EXTRACT] can be split across Gemini chunks (e.g., chunk N
ends with "[DATA" and chunk N+1 starts with "_EXTRACT]\n{...").  We handle
this with an overlap buffer — we always keep the last len(SENTINEL)-1 characters
buffered until we're sure they don't form the start of the sentinel.

BILINGUAL OPERATION:
─────────────────────
  USER_LANG   — The BCP-47 code Mac converses in (from user's browser language).
  RESUME_LANG — The language of the extracted data (almost always 'en-CA').

  Example: A French speaker (USER_LANG='fr') asks about their experience.
           Mac replies in French, but the extracted responsibilities in the
           JSON block are in Canadian English (RESUME_LANG='en-CA').
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json
import logging
from typing import AsyncGenerator, Literal

import google.generativeai as genai
from google.generativeai.types import HarmBlockThreshold, HarmCategory

from .config.prompts import SENTINEL, PersonaFactory

logger = logging.getLogger("jobifai.ai")

# ─── Type Aliases ──────────────────────────────────────────────────────────────
InterviewStep = Literal[
    "idle", "target_title", "summary", "experience", "skills_education", "complete",
    "optimize",   # ← Optimization Mode: user has existing resume, Mac is a coach not interviewer
]

# The two top-level app modes — mirrors frontend AppMode type.
# Determines which system instruction tier PersonaFactory selects.
AppMode = Literal["OPTIMIZE", "SCRATCH"]

# Gemini role names differ from our convention: "model" not "assistant"
GeminiRole = Literal["user", "model"]

# ─── Constants ──────────────────────────────────────────────────────────────────

# The sentinel that separates conversational text from the structured JSON block.
# Chosen to be distinctive (unlikely to appear in normal prose) and unambiguous.
# The model is instructed to output this EXACTLY — no variations.
SENTINEL = "[DATA_EXTRACT]"

# Human-readable language names for injection into system prompts.
# BCP-47 tag → natural language name the model understands.
LANGUAGE_NAMES: dict[str, str] = {
    "en":    "English",
    "en-CA": "Canadian English",
    "fr":    "French",
    "fr-CA": "Canadian French (Québécois)",
    "es":    "Spanish",
    "zh-CN": "Simplified Chinese (Mandarin)",
    "zh-TW": "Traditional Chinese (Cantonese/Mandarin)",
    "ar":    "Arabic",
    "pt":    "Brazilian Portuguese",
    "hi":    "Hindi",
}

# Fields forbidden by the Canadian Human Rights Act and Quebec's Charter.
# Used BOTH in the system prompt (instruction) and in post-processing validation
# as a defence-in-depth sanity check before persisting data to Supabase.
FORBIDDEN_HR_FIELDS: frozenset[str] = frozenset({
    "date of birth", "date_of_birth", "dob", "born",
    "age", "years old", "year old",
    "gender", "sex", "pronouns", "he/him", "she/her", "they/them",
    "marital status", "married", "single", "divorced", "widowed",
    "family status", "children", "kids", "dependents",
    "nationality", "citizenship", "country of origin",
    "religion", "faith", "church", "mosque", "temple",
    "race", "ethnicity", "skin colour", "skin color",
    "sin", "social insurance", "social insurance number",
    "photo", "picture", "headshot",
    "disability", "disabled",
    "sexual orientation",
})

# Gemini model to use — Flash is the right call here:
#   • 3–5× lower latency than Pro (critical for real-time typewriter effect)
#   • Sufficiently capable for structured interview extraction
#   • ~10× cheaper (important at PLG scale)
DEFAULT_MODEL = "gemini-2.5-flash"


# ─── Legacy SENTINEL re-export ────────────────────────────────────────────────
# Other modules (tests, evaluate.py) import SENTINEL from ai_service.
# Re-exporting it here keeps those imports working after the move to config/prompts.
# New code should import directly from config.prompts.
# SENTINEL is already imported above from .config.prompts


# ─── System Prompt Construction ───────────────────────────────────────────────
# ALL prompt text lives in config/prompts.py.
# build_system_prompt() is a thin adapter that translates our internal
# ai_service params into the PersonaFactory.build() interface.
#
# This keeps ai_service.py free of template strings and persona logic.
# To change Mac's behaviour or wording, edit config/prompts.py.
# ──────────────────────────────────────────────────────────────────────────────

def build_system_prompt(
    user_lang: str,
    resume_lang: str,
    current_step: InterviewStep,
    job_description: str | None = None,
    score: int | None = None,
    mode: str = "OPTIMIZE",
    is_hardcore_mode: bool = False,
) -> str:
    """
    Build the system instruction by delegating to PersonaFactory.

    This thin adapter exists so _build_gemini_model can call a single function
    without knowing about the PersonaFactory interface.

    Args:
        user_lang:       BCP-47 code for the conversation language.
        resume_lang:     BCP-47 code for extracted data language.
        current_step:    Active InterviewStep string.
        job_description: Optional raw JD text (PersonaFactory truncates to 3k).
        score:           ATS score 0–100, or None (drives persona tier).
        mode:            'OPTIMIZE' or 'SCRATCH' (drives step section selection).

    Returns:
        Fully rendered system instruction string, ready for Gemini.
    """
    user_lang_name   = LANGUAGE_NAMES.get(user_lang,   user_lang)
    resume_lang_name = LANGUAGE_NAMES.get(resume_lang, resume_lang)

    return PersonaFactory.build(
        mode             = mode,
        score            = score,
        current_step     = current_step,
        user_lang_name   = user_lang_name,
        resume_lang_name = resume_lang_name,
        jd_text          = job_description,
        is_hardcore_mode = is_hardcore_mode,
    )


# ─── Gemini Client Helpers ─────────────────────────────────────────────────────

def _build_gemini_model(
    api_key: str,
    current_step: InterviewStep,
    user_lang: str,
    resume_lang: str,
    job_description: str | None = None,
    score: int | None = None,
    mode: str = "OPTIMIZE",
    is_hardcore_mode: bool = False,
) -> genai.GenerativeModel:
    """
    Build a configured GenerativeModel instance.

    We create a fresh model per request (not a shared singleton) because:
      1. The system_instruction varies per turn (different current_step)
      2. GenerativeModel construction is cheap (no network call)
      3. Avoids shared mutable state between concurrent requests

    Safety settings: we LOWER the harassment/dangerous-content thresholds
    to BLOCK_NONE for this use-case.  Why?  Strict safety filters can
    incorrectly block legitimate HR discussion (e.g., the user describing
    a stressful work environment, or mentioning weapons-related jobs for
    military veterans).  The system prompt already constrains behaviour.
    """
    genai.configure(api_key=api_key)

    return genai.GenerativeModel(
        model_name=DEFAULT_MODEL,
        system_instruction=build_system_prompt(user_lang, resume_lang, current_step, job_description, score, mode, is_hardcore_mode),
        safety_settings={
            # BLOCK_ONLY_HIGH allows almost all professional content through
            # while still blocking genuinely harmful outputs.
            HarmCategory.HARM_CATEGORY_HARASSMENT:        HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_HATE_SPEECH:       HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
        generation_config=genai.types.GenerationConfig(
            # Temperature 0.7: creative enough for warm conversation,
            # disciplined enough for reliable JSON output.
            temperature=0.7,
            # top_p + top_k together control the sampling distribution.
            top_p=0.9,
            top_k=40,
            # No max_output_tokens cap — we never know how long a user's
            # work history might be.  Gemini Flash default (~8k) is fine.
        ),
    )


def _convert_history_to_gemini(
    messages: list[dict[str, str]],
) -> list[dict]:
    """
    Convert our frontend message format to Gemini's Content format.

    Frontend format: [{"role": "user"|"assistant", "content": "..."}]
    Gemini format:   [{"role": "user"|"model", "parts": [{"text": "..."}]}]

    We also STRIP the [DATA_EXTRACT] blocks from historical model turns.
    Why?  The conversation history we keep on the frontend is the clean
    conversational text only — the JSON blocks are internal plumbing that
    the model doesn't need to see repeated in history.  It already knows
    the format from its system instruction.

    Note: We skip the last message (current user turn) — the caller adds
    that separately as the prompt.
    """
    converted: list[dict] = []

    for msg in messages:
        role    = "model" if msg["role"] == "assistant" else "user"
        content = msg["content"]

        # Strip any [DATA_EXTRACT] block that snuck into history
        if SENTINEL in content:
            content = content[: content.index(SENTINEL)].rstrip()

        if content.strip():  # skip empty messages after stripping
            converted.append({
                "role":  role,
                "parts": [{"text": content}],
            })

    return converted


# ─── SSE Event Formatters ──────────────────────────────────────────────────────
# SSE (Server-Sent Events) is a W3C standard for one-way streaming from server
# to browser.  The format is simple text lines:
#
#   event: <event_type>\n
#   data: <json_payload>\n
#   \n          ← blank line signals end of event
#
# The browser's EventSource API automatically reconnects on network errors.
# We use SSE (not WebSockets) because we only need one-way server→client flow.

def _sse_event(event_type: str, payload: dict) -> str:
    """Format a single SSE event as a string ready to yield from a generator."""
    return f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_token(text: str) -> str:
    """A chunk of conversational text to stream to the chat UI."""
    return _sse_event("token", {"text": text})


def sse_data_extract(payload: dict) -> str:
    """The structured JSON extracted from the AI response."""
    return _sse_event("data_extract", payload)


def sse_done() -> str:
    """Terminal event — client should close the EventSource connection."""
    return _sse_event("done", {})


def sse_error(message: str) -> str:
    """Error event — client should display an error and stop listening."""
    return _sse_event("error", {"message": message})


# ─── Core Streaming Generator ──────────────────────────────────────────────────

async def stream_interview_turn(
    *,
    api_key: str,
    user_message: str,
    current_step: InterviewStep,
    user_lang: str,
    resume_lang: str,
    history: list[dict[str, str]],
    job_description: str | None = None,
    score: int | None = None,
    mode: str = "OPTIMIZE",
    is_hardcore_mode: bool = False,
) -> AsyncGenerator[str, None]:
    """
    The heart of the AI engine.  Streams a single interview turn.

    Yields SSE-formatted strings in this order:
      1. `event: token`        — zero or more, streamed in real-time as Gemini generates
      2. `event: data_extract` — exactly one, containing the structured JSON
      3. `event: done`         — exactly one, signals stream completion

    On any error:
      1. `event: error`        — with a human-readable message
      2. `event: done`         — always sent so the client can close cleanly

    SENTINEL DETECTION:
    ───────────────────
    The sentinel [DATA_EXTRACT] may be split across Gemini chunks.
    We use an overlap-buffer strategy:

      safe_end pointer: we only yield up to (len(full_text) - OVERLAP_LEN)
      because the last OVERLAP_LEN chars might be the start of a sentinel.
      Once a chunk arrives and we confirm no sentinel starts there, we advance
      the pointer and yield the confirmed-safe text.

    After the stream ends, we do a final check on the entire accumulated text.

    Args:
        api_key:      Gemini API key (server default or BYOK from request).
        user_message: The user's current input.
        current_step: Interview state machine position.
        user_lang:    BCP-47 code for conversation language.
        resume_lang:  BCP-47 code for extracted data language.
        history:      Prior conversation turns (frontend format, excl. current msg).
    """
    # ── 1. Build the model and convert history ─────────────────────────────────
    model   = _build_gemini_model(api_key, current_step, user_lang, resume_lang, job_description, score, mode, is_hardcore_mode)
    contents = _convert_history_to_gemini(history) + [
        {"role": "user", "parts": [{"text": user_message}]},
    ]

    # ── 2. Buffer state ────────────────────────────────────────────────────────
    # full_text: everything Gemini has emitted so far
    # yielded_up_to: index of the last character we've yielded as a token event
    # sentinel_found: True once we've located [DATA_EXTRACT] in the stream
    full_text      = ""
    yielded_up_to  = 0
    sentinel_found = False

    # We keep a rolling overlap buffer of this many chars at the end to handle
    # sentinels split across chunk boundaries.
    OVERLAP = len(SENTINEL) - 1  # 13 chars — the max prefix that could be confused

    try:
        response = await model.generate_content_async(contents, stream=True)

        async for chunk in response:
            # Gemini can emit empty chunks (e.g., safety filter metadata)
            chunk_text = getattr(chunk, "text", "") or ""
            if not chunk_text:
                continue

            full_text += chunk_text

            # Skip yielding if we've already found the sentinel
            if sentinel_found:
                continue

            # Check if the sentinel has now appeared in the accumulated text
            sentinel_pos = full_text.find(SENTINEL)
            if sentinel_pos != -1:
                # Sentinel found!  Yield the conversational part up to it.
                sentinel_found = True
                if sentinel_pos > yielded_up_to:
                    yield sse_token(full_text[yielded_up_to:sentinel_pos])
                    yielded_up_to = sentinel_pos
            else:
                # Sentinel not found yet.  Yield only the "confirmed safe" region —
                # everything up to len(full_text) - OVERLAP, because the last
                # OVERLAP chars might form the prefix of a split sentinel.
                safe_end = max(yielded_up_to, len(full_text) - OVERLAP)
                if safe_end > yielded_up_to:
                    yield sse_token(full_text[yielded_up_to:safe_end])
                    yielded_up_to = safe_end

        # ── 3. Stream ended — process any remaining buffered text ─────────────
        if not sentinel_found:
            # No sentinel in the entire response.  This means the model didn't
            # follow the format instruction (rare but possible).
            # Yield any remaining text and log a warning.
            if yielded_up_to < len(full_text):
                yield sse_token(full_text[yielded_up_to:])
            logger.warning(
                "Gemini response missing sentinel — step=%s, response_len=%d",
                current_step, len(full_text),
            )
            # Emit a safe fallback data_extract so the frontend doesn't hang
            yield sse_data_extract({
                "step":    current_step,
                "advance": False,
                "data":    {},
                "_warn":   "sentinel_missing",
            })
        else:
            # Parse the JSON block that follows the sentinel
            json_part = full_text[full_text.index(SENTINEL) + len(SENTINEL):].strip()

            try:
                data_payload = json.loads(json_part)

                # ── Post-processing: Canadian HR compliance sanity check ────────
                # Even if the model slipped forbidden data into the JSON, catch it.
                data_payload = _scrub_forbidden_fields(data_payload)

                yield sse_data_extract(data_payload)

            except json.JSONDecodeError as exc:
                logger.error(
                    "JSON parse failed — step=%s, raw=%r, err=%s",
                    current_step, json_part[:200], exc,
                )
                # Yield a degraded payload so the frontend can continue
                yield sse_data_extract({
                    "step":    current_step,
                    "advance": False,
                    "data":    {},
                    "_error":  "json_parse_failed",
                })

    except Exception as exc:  # noqa: BLE001
        # Catch-all: Gemini API errors, network errors, etc.
        logger.exception("Gemini streaming error — step=%s", current_step)
        yield sse_error(f"AI service error: {type(exc).__name__}: {exc!s}")

    finally:
        # Always send the done event so the frontend can close cleanly,
        # even if an error occurred mid-stream.
        yield sse_done()


# ─── Post-processing Utilities ─────────────────────────────────────────────────

def _scrub_forbidden_fields(payload: dict) -> dict:
    """
    Defence-in-depth: scan the extracted JSON for any forbidden HR fields
    and remove them before the data reaches the frontend or database.

    This is a SECONDARY check — the system prompt is the PRIMARY enforcement.
    Having both means we have two independent safeguards against accidental
    inclusion of legally protected personal information.

    Args:
        payload: The raw parsed JSON dict from the Gemini response.

    Returns:
        Cleaned payload dict with forbidden field values redacted.
    """
    if not isinstance(payload, dict):
        return payload

    data = payload.get("data", {})
    if not isinstance(data, dict):
        return payload

    flagged: list[str] = []

    # Scan all string values in the data dict for forbidden terms
    def _scan_value(value: object) -> object:
        if isinstance(value, str):
            lower = value.lower()
            for forbidden in FORBIDDEN_HR_FIELDS:
                if forbidden in lower:
                    flagged.append(f"'{forbidden}' found in value")
                    # Don't return the value — log and return a placeholder
                    return "[REDACTED — forbidden HR field]"
            return value
        if isinstance(value, list):
            return [_scan_value(v) for v in value]
        if isinstance(value, dict):
            return {k: _scan_value(v) for k, v in value.items()}
        return value

    payload["data"] = _scan_value(data)

    if flagged:
        logger.warning(
            "HR scrubber removed forbidden fields: %s", flagged
        )
        payload["_scrubbed"] = flagged

    return payload


def sanitise_extracted_data(data: dict, step: InterviewStep) -> dict:
    """
    Public helper: validate that the extracted data matches the expected
    schema for the given step.  Called by the router before returning to client.

    Returns a safe subset of the data — unexpected keys are silently dropped.
    This prevents prompt injection attacks where the model tries to include
    extra fields (e.g., "admin": true) in the JSON payload.
    """
    # Allowlist of keys per step — anything not on the list is dropped
    ALLOWED_KEYS: dict[str, set[str]] = {
        "idle":             set(),
        "target_title":     {"targetTitle"},
        "summary":          {"summary"},
        "experience":       {"experiences"},
        "skills_education": {"skills", "education"},
        "complete":         set(),
        # Optimization mode can add bullets to existing experience entries
        "optimize":         {"experiences", "skills"},
    }

    allowed = ALLOWED_KEYS.get(step, set())
    return {k: v for k, v in data.items() if k in allowed}
