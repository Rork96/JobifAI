"""
backend/services/scraper.py — Job Description URL Scraper
─────────────────────────────────────────────────────────────────────────────
Fetches a job posting URL and extracts the main job description text.

STRATEGY — Jina Reader API (primary):
  Prepend https://r.jina.ai/ to any URL.  Jina renders the page in a
  headless browser, bypasses Cloudflare / bot-protection, and returns
  clean Markdown.  No API key required.  Handles Indeed, Workday,
  Greenhouse, Lever, and most other ATS portals reliably.

  LinkedIn / Glassdoor are still intercepted early with a paste prompt
  because they require a personal login session that Jina cannot provide.

  On ANY error (network, timeout, empty response) return a ScraperResult
  with `success=False` and a user-facing `error_hint`.  The router returns
  this to the frontend which shows it as a callout prompting manual paste.

WHY NOT raise exceptions?
  Scrapers are inherently flaky.  The caller (the /api/parse-job endpoint)
  should never crash.  A result object keeps the router clean.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import urlparse, ParseResult

import httpx

logger = logging.getLogger("jobifai.scraper")


# ─── Result type ──────────────────────────────────────────────────────────────

@dataclass
class ScraperResult:
    """
    Returned by `fetch_job_description` regardless of success or failure.

    Attributes:
        success:    True if we extracted usable text.
        text:       The cleaned job description text (empty if success=False).
        title:      The page <title> or job title if we could parse it.
        error_hint: User-facing explanation of what went wrong.
                    Frontend shows this as a callout prompting the user to
                    paste the job text manually.  Empty on success.
    """
    success:    bool
    text:       str = ""
    title:      str = ""
    error_hint: str = ""


# ─── Jina Reader API ──────────────────────────────────────────────────────────
# Jina Reader (https://r.jina.ai) is a free proxy that renders pages in a
# headless browser, strips boilerplate, and returns clean Markdown.
# Prepending "https://r.jina.ai/" to ANY URL makes it work — no API key needed.
# It handles Cloudflare, JS-rendered pages, and ATS portals (Indeed, Workday,
# Greenhouse, Lever, etc.) that block standard HTTP requests.
_JINA_BASE = "https://r.jina.ai/"
_JINA_TIMEOUT = 20.0   # Jina renders headlessly — longer timeout than direct fetch
_JINA_HEADERS = {
    "Accept": "text/plain, text/markdown, */*",
    "X-Return-Format": "markdown",   # Request clean Markdown output
    "X-No-Cache": "true",            # Always fetch fresh content
}

# ─── Login-walled domains — still blocked (Jina can't bypass authentication) ──
_LOGIN_BLOCKED: dict[str, str] = {
    "linkedin.com": (
        "LinkedIn requires you to be signed in to view job postings. "
        "Please copy the job description text and paste it below."
    ),
    "glassdoor.com": (
        "Glassdoor requires a login to view job postings. "
        "Please copy the job description text and paste it below."
    ),
    "glassdoor.ca": (
        "Glassdoor requires a login to view job postings. "
        "Please copy the job description text and paste it below."
    ),
}

# Minimum characters for extracted text to be considered a real job posting.
_MIN_TEXT_CHARS = 200


# ─── Public interface ──────────────────────────────────────────────────────────

async def fetch_job_description(url: str) -> ScraperResult:
    """
    Fetch a job posting URL via the Jina Reader API and return clean text.

    This function NEVER raises — all error paths return a ScraperResult
    with `success=False` and a human-readable `error_hint`.

    Jina Reader prepends its proxy URL so it can render JS pages and bypass
    Cloudflare bot protection — far more reliable than direct httpx fetching.

    Args:
        url: The raw URL string provided by the user.

    Returns:
        ScraperResult with `success=True` and cleaned `text` on success,
        or `success=False` and a friendly `error_hint` on any failure.
    """
    # ── Step 1: Validate URL format ───────────────────────────────────────────
    parsed = _validate_url(url)
    if parsed is None:
        return ScraperResult(
            success=False,
            error_hint=(
                "The URL doesn't look valid. "
                "It should start with https:// or http://. "
                "You can paste the job description text directly instead."
            ),
        )

    # ── Step 2: Block login-walled domains early ──────────────────────────────
    for blocked_domain, hint in _LOGIN_BLOCKED.items():
        if parsed.netloc.endswith(blocked_domain):
            logger.info("Login-walled domain detected: %s", parsed.netloc)
            return ScraperResult(success=False, error_hint=hint)

    # ── Step 3: Fetch via Jina Reader ────────────────────────────────────────
    jina_url = f"{_JINA_BASE}{url}"
    logger.info("Fetching via Jina Reader: %s", jina_url)

    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=_JINA_TIMEOUT,
            headers=_JINA_HEADERS,
        ) as client:
            response = await client.get(jina_url)

    except httpx.TimeoutException:
        logger.warning("Jina Reader timeout for URL: %s", url)
        return ScraperResult(
            success=False,
            error_hint=(
                "The job posting took too long to load. "
                "Please paste the job description text directly."
            ),
        )

    except httpx.RequestError as exc:
        logger.warning("Network error via Jina Reader for %s: %s", url, exc)
        return ScraperResult(
            success=False,
            error_hint=(
                "Could not connect to fetch the job posting. "
                "Please paste the job description text directly."
            ),
        )

    # ── Step 4: Handle HTTP errors ────────────────────────────────────────────
    if response.status_code >= 400:
        logger.warning("Jina Reader returned HTTP %d for %s", response.status_code, url)
        return ScraperResult(
            success=False,
            error_hint=(
                f"The page returned an error ({response.status_code}). "
                "Please check the URL or paste the job description text directly."
            ),
        )

    # ── Step 5: Read the clean Markdown returned by Jina ─────────────────────
    text = response.text.strip()

    if len(text) < _MIN_TEXT_CHARS:
        logger.warning("Jina returned too little text (%d chars) for %s", len(text), url)
        return ScraperResult(
            success=False,
            error_hint=(
                "We couldn't extract enough text from that page. "
                "The site may require a login or use heavy JavaScript. "
                "Please paste the job description text directly."
            ),
        )

    # ── Extract title from first Markdown H1 heading ──────────────────────────
    # Jina prefixes the response with the page <title> as a Markdown heading.
    title = ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            break

    logger.info(
        "Jina Reader success — url=%s  chars=%d  title=%r",
        url, len(text), title,
    )
    return ScraperResult(success=True, text=text, title=title)


def _validate_url(url: str) -> "ParseResult | None":
    """
    Validate that `url` is a well-formed http/https URL.

    Returns:
        The parsed urlparse result if valid, None otherwise.
    """
    try:
        parsed = urlparse(url.strip())
        if parsed.scheme not in ("http", "https"):
            return None
        if not parsed.netloc:
            return None
        return parsed
    except Exception:
        return None
