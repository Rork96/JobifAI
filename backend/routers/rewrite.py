"""
routers/rewrite.py — POST /api/v1/rewrite
─────────────────────────────────────────────────────────────────────────────
Entry point for the bullet-rewrite pipeline.

Flow:
  1. Client sends RewriteRequest { originalText, jobDescription?, userMessage,
                                   resumeContext? }
  2. rewrite_bullet(request) → RewriteResponse via Gemini Surgeon agent
  3. Returns { proposedText, coachMessage }

Error handling:
  • SurgeonParseError (agent exhausted both retry attempts)
    → HTTP 502 Bad Gateway + structured JSON body.
    The frontend should display "AI failed to generate — please try again."

  • Any other unexpected exception
    → HTTP 500 Internal Server Error (logged with full traceback).

No auth required — same policy as /parse and /evaluate.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..agents.surgeon_agent import SurgeonParseError, rewrite_bullet
from ..schemas import RewriteRequest, RewriteResponse

logger = logging.getLogger("jobifai.rewrite")

router = APIRouter()


@router.post(
    "/api/v1/rewrite",
    response_model=RewriteResponse,
    summary="Rewrite a resume bullet point",
    description=(
        "Accepts the original bullet, an optional job description, the "
        "user's chat instruction, and an optional full-resume context string. "
        "Returns a rewritten bullet (proposedText) and a coaching message "
        "(coachMessage) from the Mac mentor agent.\n\n"
        "**proposedText** is always professional English (ATS-optimised).\n"
        "**coachMessage** is always in the user's native language (Bilingual Rule).\n\n"
        "Returns HTTP 502 if the AI fails to produce a valid response after retry."
    ),
)
async def rewrite_endpoint(request: RewriteRequest) -> RewriteResponse:
    logger.info(
        "Rewrite request — bullet=%d chars, jd=%s, resume_ctx=%s, instruction=%r",
        len(request.originalText),
        "yes" if request.jobDescription else "no",
        f"{len(request.resumeContext)} chars" if request.resumeContext else "no",
        request.userMessage[:60],
    )

    try:
        result = rewrite_bullet(request)

    except SurgeonParseError as exc:
        # Agent exhausted both retry attempts — Gemini returned malformed JSON.
        # Return 502 (upstream failure) with a structured body the frontend
        # can parse to show a user-facing error message.
        logger.error(
            "Surgeon parse failure after retries — last_raw=%r  cause=%s",
            exc.last_raw[:200],
            exc.cause,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "error":   "surgeon_parse_failure",
                "message": "The AI returned an unexpected response. Please try again.",
            },
        ) from exc

    except Exception as exc:  # noqa: BLE001
        # Unexpected error (network, config, etc.) — log the full traceback
        logger.exception("Surgeon agent unexpected error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred in the rewrite agent. Please try again.",
        ) from exc

    logger.info(
        "Rewrite success — proposed_len=%d coach_len=%d",
        len(result.proposedText),
        len(result.coachMessage),
    )
    return result
