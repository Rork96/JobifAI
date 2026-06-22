"""
agents/surgeon_agent.py — Resume Bullet Surgeon Agent (Mac — Radically Direct)
─────────────────────────────────────────────────────────────────────────────
Responsibility:
  Rewrite a single resume bullet based on the user's instruction, the target
  JD for ATS alignment, and the full resume context to prevent duplicate phrasing
  or inconsistent tense/voice across bullets.

Persona contract (PRD §Mac):
  Mac is radically direct.  He rejects vague instructions without politeness,
  names specific weaknesses, and writes coachMessage in the user's native
  language (Bilingual Rule).  proposedText is ALWAYS professional English.

Reliability contract:
  ┌─────────────────────────────────────────────────────────────┐
  │  Layer 1 — System prompt: explicit JSON schema + examples   │
  │             Both fields shown as required in every case.    │
  │  Layer 2 — _strip_fences(): removes markdown wrapping that  │
  │             Gemini occasionally emits despite json mode.    │
  │  Layer 3 — Retry: one automatic retry on parse/validation   │
  │             failure before raising SurgeonParseError.       │
  │  Layer 4 — Router catches SurgeonParseError → HTTP 502 +    │
  │             clean JSON so the frontend can show a message.  │
  └─────────────────────────────────────────────────────────────┘

Root cause of ValidationError:
  With response_schema=RewriteResponse, Gemini 2.5 Flash sometimes reads the
  gatekeeper logic ("if rejecting, proposedText is ''") and infers that
  coachMessage is conditional — emitting {"proposedText": ""} with no
  coachMessage key.  The fix is threefold:
    a. The system prompt now shows the exact JSON contract at the TOP, before
       any persona rules, with two concrete examples that both include BOTH
       keys.
    b. The prompt explicitly states "coachMessage is NEVER omitted."
    c. Retry + parse-safe fallback catches any remaining edge cases.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json
import logging
import re
import time

from pydantic import ValidationError

import google.generativeai as genai

from ..schemas import RewriteRequest, RewriteResponse

logger = logging.getLogger("jobifai.surgeon")


# ── Custom exception ───────────────────────────────────────────────────────────

class SurgeonParseError(RuntimeError):
    """
    Raised when both the initial call AND the retry fail to produce a valid
    RewriteResponse.  The router converts this to HTTP 502 so the frontend
    can display a graceful error instead of a 500 crash.

    Attributes:
        last_raw: The last raw string returned by Gemini (for logging).
        cause:    The underlying exception (JSONDecodeError or ValidationError).
    """
    def __init__(self, message: str, last_raw: str = "", cause: Exception | None = None):
        super().__init__(message)
        self.last_raw = last_raw
        self.cause    = cause


# ── System instruction ─────────────────────────────────────────────────────────
#
# DESIGN:  The JSON contract block is placed FIRST — before any persona or
# gatekeeper rules — so it is the highest-priority instruction in the context
# window.  Gemini tends to follow the first structural constraint it reads.
#
# The two concrete examples are critical: they show that BOTH fields appear
# whether the response is a rejection OR an acceptance.  Without examples,
# the model occasionally infers coachMessage is optional on rejections.

_SYSTEM_INSTRUCTION = """\
════════════════════════════════════════════════════════
MANDATORY JSON CONTRACT — HIGHEST PRIORITY — READ FIRST
════════════════════════════════════════════════════════
You are a strict JSON API.  You MUST return ONLY a valid JSON object with
EXACTLY these two string keys.  BOTH keys are ALWAYS required.  There are
NO exceptions to this rule:

  {
    "proposedText": "<string>",
    "coachMessage": "<string>"
  }

ABSOLUTE RULES:
  ✗ NEVER return JSON with only one key.
  ✗ NEVER omit "coachMessage" — not even when rejecting.
  ✗ NEVER omit "proposedText" — not even when only giving coaching feedback.
  ✗ NEVER wrap the JSON in markdown code fences (no ```json … ```).
  ✗ NEVER add any text before or after the JSON object.

────────────────────────────────────────────────────────
EXAMPLE A — instruction is too vague (REJECT):
────────────────────────────────────────────────────────
{
  "proposedText": "",
  "coachMessage": "Надто розмито. Що конкретно ти досяг? Дай мені метрику, інструмент або реальний результат — без цього я не можу переписати цей пункт."
}

Note: proposedText is the empty string "". coachMessage is present and direct.
Note: coachMessage is in the user's native language (Ukrainian in this example).

────────────────────────────────────────────────────────
EXAMPLE B — instruction has real content (ACCEPT):
────────────────────────────────────────────────────────
{
  "proposedText": "Reduced API response time by 40% by migrating session cache from PostgreSQL to Redis, eliminating 120 ms average latency per request.",
  "coachMessage": "Оригінал не мав метрики і ховав технологію. Нова версія починається з результату, називає конкретний інструмент і додає точне число — ATS і рекрутери виграють обоє."
}

Note: proposedText is in professional English regardless of the user's language.
Note: coachMessage is in the user's native language (Ukrainian in this example).

════════════════════════════════════════════════════════
BILINGUAL RULE — NON-NEGOTIABLE
════════════════════════════════════════════════════════
`proposedText`:
  MUST ALWAYS be written in highly professional, ATS-optimised English.
  The resume document must be in English to pass English-language ATS systems.
  Even if the user writes in Ukrainian, French, Spanish, or any other language,
  proposedText is English. No exceptions.

`coachMessage`:
  MUST ALWAYS be written in the user's native language.
  Detect the language from the USER INSTRUCTION field at the end of the prompt.
  • User writes in Ukrainian → coachMessage in Ukrainian.
  • User writes in French    → coachMessage in French.
  • User writes in Spanish   → coachMessage in Spanish.
  • User writes in English   → coachMessage in English.
  The persona stays harsh and radically direct in ALL languages.

════════════════════════════════════════════════════════
PERSONA — NON-NEGOTIABLE
════════════════════════════════════════════════════════
You are Mac — a brutally honest, radically direct career mentor and resume
surgeon.  You are NOT polite.  You deliver surgical, precise analysis of
resume mistakes and rewrite them with zero sentimentality.

BANNED PHRASES (never use in coachMessage, in any language):
  "Great!"  "Well done!"  "That's a good start!"  "Happy to help!"
  "Don't worry…"  "Of course!"  "Sure!"  "Certainly!"

════════════════════════════════════════════════════════
GATEKEEPER RULES
════════════════════════════════════════════════════════
RULE 1 — REJECT vague or context-free instructions:
  Trigger: instruction is gibberish, too short, or lacks actionable context.
  Examples of triggering instructions: "make it better", "improve", "fix it",
  "good", "ok", single words, single emojis.

  Action:
    → proposedText = "" (exactly the empty string)
    → coachMessage = direct rejection in the user's language, naming EXACTLY
      what is missing (a metric, a specific tool, a concrete outcome).
      Be harsh. Do not soften.

RULE 2 — ACCEPT instructions with real professional content:
  Trigger: instruction contains a metric, a tool, a measurable outcome, or
  concrete professional context.
  Examples: "I reduced API latency by 40% using Redis",
            "I led a team of 8 engineers", "add Kubernetes", "we hit 99.9% SLA".

  Action:
    → proposedText = the rewritten bullet in professional English.
    → coachMessage = 1–2 sentences in the user's language naming what was
      wrong with the original AND what the rewrite specifically fixes.

════════════════════════════════════════════════════════
REWRITING RULES (when RULE 2 applies)
════════════════════════════════════════════════════════
  • Open with a strong PAST-TENSE action verb (Led, Built, Reduced, Engineered,
    Automated, Increased, Deployed, Designed, Delivered, Scaled…).
  • Use XYZ format: "Accomplished [X] by doing [Y], achieving [Z]."
  • Mirror keywords from the JOB DESCRIPTION — ATS is a string matcher.
  • Check OTHER bullets in the full resume for duplicate opening verbs.
  • Never invent metrics. Use [X%] / [N users] ONLY when context strongly
    implies a metric existed but was not stated.
  • Keep the rewritten bullet to ONE sentence (≤ 20 words) unless the user
    explicitly asks for more detail.\
"""


# ── Model singleton ────────────────────────────────────────────────────────────
# response_mime_type + response_schema together enforce structured JSON output
# at the API level.  The system prompt is the second enforcement layer.
_model = genai.GenerativeModel(
    model_name="models/gemini-2.5-flash",
    system_instruction=_SYSTEM_INSTRUCTION,
    generation_config={
        "response_mime_type": "application/json",
        "response_schema":    RewriteResponse,
        "temperature":        0.3,
    },
)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _strip_fences(raw: str) -> str:
    """
    Remove markdown code fences that Gemini occasionally emits despite
    response_mime_type='application/json'.

    Handles:
      ```json { ... } ```
      ``` { ... } ```
      { ... }   (already clean — returned as-is)
    """
    raw = raw.strip()
    # Remove leading ```json or ``` opener
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    # Remove trailing ``` closer
    raw = re.sub(r"\s*```$", "", raw)
    return raw.strip()


def _parse_and_validate(raw: str) -> RewriteResponse:
    """
    Parse a raw Gemini response string into a validated RewriteResponse.

    Steps:
      1. Strip markdown fences (defensive).
      2. json.loads() — raises JSONDecodeError on malformed JSON.
      3. RewriteResponse(**data) — raises ValidationError if fields are missing.

    Both exceptions propagate to the caller (rewrite_bullet retry loop).
    """
    cleaned = _strip_fences(raw)
    data    = json.loads(cleaned)           # JSONDecodeError if malformed
    return RewriteResponse(**data)          # ValidationError if fields missing


def _build_prompt(request: RewriteRequest) -> str:
    """
    Assemble the user-turn prompt from all available context fields.

    Section order (descending priority for the model):
      1. Job description — ATS keyword alignment
      2. Full resume     — cross-bullet coherence (truncated at 5 000 chars)
      3. Target bullet   — the specific bullet being rewritten
      4. User instruction — what Mac must act on
    """
    parts: list[str] = []

    # 1. Job description
    parts.append(
        f"JOB DESCRIPTION (mirror these exact keywords in proposedText):\n"
        f"{request.jobDescription or 'N/A'}"
    )

    # 2. Full resume context — prevents cross-bullet duplication
    if request.resumeContext:
        try:
            sections_data = json.loads(request.resumeContext)
            pretty = json.dumps(sections_data, indent=2, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            pretty = request.resumeContext
        parts.append(
            "CANDIDATE'S FULL RESUME "
            "(for cross-bullet coherence — read before rewriting):\n"
            + "─" * 60 + "\n"
            + pretty[:5_000] + "\n"
            + "─" * 60
        )

    # 3. The specific bullet being targeted
    parts.append(f"ORIGINAL BULLET TO REWRITE:\n{request.originalText}")

    # 4. User instruction — language detection happens here
    parts.append(
        f"USER INSTRUCTION (detect language for coachMessage):\n"
        f"{request.userMessage}"
    )

    return "\n\n".join(parts)


# ── Public API ─────────────────────────────────────────────────────────────────

def rewrite_bullet(request: RewriteRequest) -> RewriteResponse:
    """
    Rewrite a resume bullet according to the user's instruction.

    Implements a retry-on-parse-failure loop (max 2 attempts total).
    On both failures, raises SurgeonParseError — the router maps this
    to HTTP 502 so the frontend can display a graceful retry message.

    Args:
        request: RewriteRequest {
            originalText    — the bullet to rewrite
            jobDescription? — target JD for ATS keyword alignment
            userMessage     — user's free-text instruction
            resumeContext?  — JSON-stringified ResumeSection[] (full document)
        }

    Returns:
        RewriteResponse { proposedText, coachMessage }

    Raises:
        SurgeonParseError: If Gemini fails to return valid JSON on both attempts.
    """
    prompt   = _build_prompt(request)
    last_raw = ""
    last_exc: Exception | None = None

    for attempt in range(1, 3):   # attempts 1 and 2
        try:
            response = _model.generate_content(prompt)
            last_raw = (response.text or "").strip()

            if not last_raw:
                raise ValueError(
                    "Gemini returned an empty response body. "
                    "Possible safety filter or quota exhaustion."
                )

            result = _parse_and_validate(last_raw)

            if attempt > 1:
                logger.info(
                    "Surgeon retry %d succeeded  bullet_len=%d",
                    attempt, len(result.proposedText),
                )

            return result

        except (json.JSONDecodeError, ValidationError, ValueError) as exc:
            last_exc = exc
            logger.warning(
                "Surgeon attempt %d/%d failed — %s: %s  raw=%r",
                attempt, 2,
                type(exc).__name__,
                exc,
                last_raw[:300],
            )
            if attempt < 2:
                # Brief back-off before retry — gives rate-limited APIs a moment
                time.sleep(0.4)

    # Both attempts exhausted
    logger.error(
        "Surgeon both attempts failed — raising SurgeonParseError  "
        "last_raw=%r  cause=%s",
        last_raw[:300],
        last_exc,
    )
    raise SurgeonParseError(
        "Surgeon agent failed to return a valid JSON response after 2 attempts.",
        last_raw=last_raw,
        cause=last_exc,
    )
