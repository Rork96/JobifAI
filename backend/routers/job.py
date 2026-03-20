"""
backend/routers/job.py — Job Description Parse Endpoint
─────────────────────────────────────────────────────────────────────────────
POST /api/parse-job

Accepts either:
  a) A `url` string — fetches and scrapes the job posting page
  b) A `text` string — returns it cleaned as-is (no network call)

This "either/or" design means the frontend can use the same endpoint
whether the user pasted a URL or raw text.  The endpoint normalises
both paths to the same clean text output.

WHY accept `text` at all?
  The frontend's job input field is a "smart textarea": it accepts both URLs
  and raw pasted job descriptions.  When the user pastes raw text, we still
  want to go through the backend for:
    • Whitespace normalisation (some users paste from Word with weird encoding)
    • Consistent truncation (the evaluate-edit scorer has a 400-char JD limit)
    • A uniform API response shape (title field, etc.)
  This keeps the frontend dumb — it always hits /api/parse-job and trusts the
  response, regardless of whether the input was a URL or raw text.

SCRAPING FAILURE HANDLING:
  When URL scraping fails, we return HTTP 200 with `success=False` and an
  `error_hint` field.  We do NOT return HTTP 4xx/5xx for scraping failures
  because:
    • The scraping failure is not the client's fault.
    • The frontend should still be able to render a helpful message.
    • Treating "site blocked us" as a 503 would be misleading.
  The frontend checks `response.success` and shows `response.error_hint`
  as a toast if false, then prompts the user to paste manually.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from ..services.scraper import ScraperResult, fetch_job_description

logger = logging.getLogger("jobifai.job")


# ─── Router ───────────────────────────────────────────────────────────────────
router = APIRouter(
    prefix="/api",
    tags=["job"],
)


# ─── Request / Response models ─────────────────────────────────────────────────

class JobParseRequest(BaseModel):
    """
    Request body for POST /api/parse-job.

    Exactly ONE of `url` or `text` must be provided.
    If both are provided, `text` takes priority (avoids a redundant network call).
    If neither is provided, we return a 422 via the validator below.
    """
    url:  str | None = Field(
        default=None,
        max_length=2048,
        description="URL of the job posting to scrape",
    )
    text: str | None = Field(
        default=None,
        max_length=20_000,
        description="Raw job description text (paste mode — no scraping needed)",
    )

    @field_validator("url", mode="before")
    @classmethod
    def strip_url(cls, v: str | None) -> str | None:
        """Strip whitespace from URLs (users sometimes paste with trailing spaces)."""
        return v.strip() if v else v

    @field_validator("text", mode="before")
    @classmethod
    def strip_text(cls, v: str | None) -> str | None:
        """Strip leading/trailing whitespace from pasted text."""
        return v.strip() if v else v

    @property
    def has_url(self) -> bool:
        return bool(self.url and self.url.strip())

    @property
    def has_text(self) -> bool:
        return bool(self.text and self.text.strip())


class JobParseResponse(BaseModel):
    """
    Response from POST /api/parse-job.

    We ALWAYS return HTTP 200 — even for scraping failures.
    The `success` flag tells the frontend whether we got usable text.

    success:    True if we have job description text to return.
    text:       The cleaned job description text.  Empty string if success=False.
    title:      Job title extracted from the page.  May be empty.
    source:     How we got the text: "url" (scraped), "text" (pasted), or "error".
    error_hint: User-facing explanation when success=False.
                Frontend renders this as a callout prompting manual paste.
    char_count: Length of the returned text.
    """
    success:    bool
    text:       str
    title:      str = ""
    source:     str  # "url" | "text" | "error"
    error_hint: str = ""
    char_count: int


# ─── Endpoint ──────────────────────────────────────────────────────────────────

@router.post(
    "/parse-job",
    response_model=JobParseResponse,
    summary="Extract job description from a URL or return cleaned pasted text",
    description="""
Parse a job description from either a URL (scraped) or raw pasted text (returned as-is).

**URL mode:** Fetches the page and extracts the main job description text.
Known blocked sites (LinkedIn, Glassdoor) return `success: false` with a helpful message.

**Text mode:** Returns the pasted text after whitespace normalisation.

Always returns HTTP 200. Check `success` field to determine if usable text was extracted.
    """,
)
async def parse_job(body: JobParseRequest) -> JobParseResponse:
    """
    POST /api/parse-job — Parse a job description from URL or text.

    Priority:
      1. If `text` is provided → normalise and return immediately (no network call).
      2. If `url` is provided → scrape with the job scraper service.
      3. If neither → return an error response (400 via Pydantic validation).
    """
    # ── Validate: at least one input is required ──────────────────────────────
    if not body.has_text and not body.has_url:
        return JobParseResponse(
            success=False,
            text="",
            source="error",
            error_hint=(
                "Please provide either a job description URL or paste the job text directly."
            ),
            char_count=0,
        )

    # ── Path A: Text was pasted directly ─────────────────────────────────────
    # Return immediately — no network call needed.
    # We still normalise whitespace for consistency (Word paste = lots of \r\n).
    if body.has_text:
        cleaned = _normalise_text(body.text or "")  # type: ignore[arg-type]
        logger.info("Job parse — text mode, %d chars", len(cleaned))
        return JobParseResponse(
            success=True,
            text=cleaned,
            source="text",
            char_count=len(cleaned),
        )

    # ── Path B: URL was provided — scrape it ──────────────────────────────────
    url = body.url or ""
    logger.info("Job parse — URL mode: %s", url)

    # fetch_job_description never raises — it returns a ScraperResult
    result: ScraperResult = await fetch_job_description(url)

    if result.success:
        cleaned = _normalise_text(result.text)
        logger.info(
            "Job scrape succeeded — url=%s  chars=%d  title=%r",
            url, len(cleaned), result.title,
        )
        return JobParseResponse(
            success=True,
            text=cleaned,
            title=result.title,
            source="url",
            char_count=len(cleaned),
        )
    else:
        # Scraping failed — return the user-facing hint
        logger.warning("Job scrape failed — url=%s  hint=%r", url, result.error_hint)
        return JobParseResponse(
            success=False,
            text="",
            source="error",
            error_hint=result.error_hint,
            char_count=0,
        )


# ─── Text normalisation ────────────────────────────────────────────────────────

def _normalise_text(text: str) -> str:
    """
    Normalise whitespace in pasted or scraped job description text.

    We apply the same rules as parser.py's _normalise_whitespace:
      • Collapse horizontal whitespace within lines.
      • Collapse 3+ blank lines to 2.
      • Strip leading/trailing whitespace.

    We do NOT truncate here — the evaluate-edit scorer truncates JD text
    to 400 chars on its own, and we want the full text available in the
    Zustand store for future tasks (keyword matching, cover letter gen, etc.).
    """
    # Normalise line endings (Windows \r\n → \n)
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Collapse horizontal whitespace within lines
    lines = [re.sub(r"[ \t]+", " ", line) for line in text.split("\n")]

    rejoined = "\n".join(lines)

    # Collapse excessive blank lines
    rejoined = re.sub(r"\n{3,}", "\n\n", rejoined)

    return rejoined.strip()
