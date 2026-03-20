"""
backend/services/scraper.py — Job Description URL Scraper
─────────────────────────────────────────────────────────────────────────────
Fetches a job posting URL and extracts the main job description text,
stripping away navigation, headers, footers, cookie banners, etc.

STRATEGY:
  1. Detect known "anti-scrape" domains (LinkedIn, Glassdoor) early and
     return a clean error asking the user to paste the text manually.
     Attempting to scrape these wastes time and always fails.

  2. For other sites, send an httpx GET with a realistic browser User-Agent
     and follow redirects.  A 5-second timeout prevents hangs.

  3. Parse the HTML with BeautifulSoup (lxml backend).  Remove "noise" tags
     (script, style, nav, header, footer, aside, form, iframe).

  4. Try a prioritised list of CSS selectors to locate the job description
     container — from most specific to most generic.

  5. If no selector matches, fall back to extracting all <p> tags and
     returning the longest coherent block.

  6. On ANY error (network, parse, timeout) return a ScraperResult with
     `success=False` and a user-facing `error_hint` message.  The router
     then returns this hint to the frontend, which shows it as a toast and
     asks the user to paste the text manually.

WHY NOT raise exceptions?
  Scrapers are inherently flaky.  The caller (the /api/parse-job endpoint)
  should never crash — it should always return something useful to the
  frontend.  We use a result object instead of raising so the router can
  handle partial results gracefully.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

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


# ─── Blocked domains ──────────────────────────────────────────────────────────
# These sites actively block all automated access.  Attempting to scrape them
# returns a login wall, a CAPTCHA page, or a 429 — never the job posting.
# We fail fast with a descriptive message rather than wasting 5 seconds.
_BLOCKED_DOMAINS: dict[str, str] = {
    "linkedin.com": (
        "LinkedIn requires you to be signed in to view job postings "
        "and blocks automated access. "
        "Please copy the job description text and paste it below."
    ),
    "glassdoor.com": (
        "Glassdoor blocks automated access to job postings. "
        "Please copy the job description text and paste it below."
    ),
    "glassdoor.ca": (
        "Glassdoor blocks automated access to job postings. "
        "Please copy the job description text and paste it below."
    ),
    # ZipRecruiter occasionally blocks but usually works — don't add here unless
    # we observe consistent failures in production.
}

# ─── Content selectors — tried in order (most specific first) ─────────────────
# Each selector targets the main job description region.
# We stop at the first one that produces ≥ 100 characters of text.
_CONTENT_SELECTORS: list[str] = [
    # Standard semantic HTML
    "article",
    # Common naming patterns across major job boards
    "#jobDescriptionText",          # Indeed
    ".jobDescriptionContent",       # Glassdoor (if ever unblocked)
    "[class*='job-description']",
    "[class*='jobDescription']",
    "[id*='job-description']",
    "[id*='jobDescription']",
    "[class*='description__text']", # Some boards
    "[class*='job_description']",
    "[class*='posting-description']",
    # Resume/cover letter focused tools
    "[data-automation='jobAdDetails']", # Seek (Australia)
    ".jobs-description",
    # Generic fallbacks
    "main section",
    "main",
    # Last resort: largest div by text content length (handled separately)
]

# ─── Noise tags — removed before extracting text ──────────────────────────────
_NOISE_TAGS: list[str] = [
    "script", "style", "noscript", "meta",
    "nav", "header", "footer", "aside",
    "form", "button", "iframe", "figure",
    "img", "svg", "canvas",
    # Cookie banners and modals
    "[class*='cookie']", "[id*='cookie']",
    "[class*='modal']",  "[id*='modal']",
    "[class*='banner']",
    "[class*='popup']",
]

# ─── HTTP settings ─────────────────────────────────────────────────────────────
_REQUEST_TIMEOUT = 8.0  # seconds — generous but bounded

# A realistic Chrome/Linux user-agent.  Many sites return simpler HTML for
# actual browsers vs. a blank/bot UA, and some block requests with no UA.
# Updated to Chrome 125 — matching the latest stable at time of writing.
_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# Full set of headers sent by a real Chrome browser during a Google-referred
# navigation.  Many modern job boards (Indeed, Workday, Greenhouse) now
# inspect ALL of these headers and return 403 or a CAPTCHA page if any are
# missing or obviously non-browser.
#
# Sec-Fetch-* headers were introduced in Chrome 76+ and are the most reliable
# signal a site can use to distinguish a real browser from an httpx/curl client.
# Adding them raises our acceptance rate on authenticated CDNs significantly.
_REQUEST_HEADERS = {
    "User-Agent":                _USER_AGENT,
    "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language":           "en-CA,en;q=0.9,fr-CA;q=0.8",
    "Accept-Encoding":           "gzip, deflate, br",
    # Simulate arriving via a Google search result — the most natural Referer
    # for someone who just found a job posting.
    "Referer":                   "https://www.google.com/",
    # Sec-Fetch-* are the critical anti-bot headers.  A missing Sec-Fetch-Dest
    # is a strong signal to Cloudflare/Akamai that the request is automated.
    "Sec-Fetch-Dest":            "document",
    "Sec-Fetch-Mode":            "navigate",
    "Sec-Fetch-Site":            "cross-site",  # navigating from google.com → target
    "Sec-Fetch-User":            "?1",          # user-initiated navigation
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control":             "max-age=0",
    "Connection":                "keep-alive",
    # DNT is optional but common in default Chrome installs
    "DNT":                       "1",
}

# Minimum characters for extracted text to be considered a real job posting.
_MIN_TEXT_CHARS = 100


# ─── Public interface ──────────────────────────────────────────────────────────

async def fetch_job_description(url: str) -> ScraperResult:
    """
    Fetch a job posting URL and return the extracted description text.

    This function NEVER raises — all error paths return a ScraperResult
    with `success=False` and a human-readable `error_hint`.

    Args:
        url: The raw URL string provided by the user.
             We validate it is an http/https URL before fetching.

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

    # ── Step 2: Block known anti-scrape domains early ─────────────────────────
    # Check each blocked domain against the netloc (handles www.linkedin.com
    # and linkedin.com / ca.linkedin.com etc. uniformly).
    for blocked_domain, hint in _BLOCKED_DOMAINS.items():
        if parsed.netloc.endswith(blocked_domain):
            logger.info("Blocked domain detected: %s", parsed.netloc)
            return ScraperResult(success=False, error_hint=hint)

    # ── Step 3: Fetch the page ────────────────────────────────────────────────
    logger.info("Fetching job URL: %s", url)
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,   # Follow 301/302 redirects (some boards redirect to canonical URLs)
            timeout=_REQUEST_TIMEOUT,
            headers=_REQUEST_HEADERS,
            # httpx follows HTTP/2 when available; some CDNs rate-limit HTTP/1.1
            # clients more aggressively.  http2=True requires the h2 package
            # which is in requirements.txt.
            http2=True,
        ) as client:
            response = await client.get(url)

    except httpx.TimeoutException:
        logger.warning("Timeout fetching job URL: %s", url)
        return ScraperResult(
            success=False,
            error_hint=(
                "The job posting took too long to load. "
                "Please paste the job description text directly."
            ),
        )

    except httpx.TooManyRedirects:
        return ScraperResult(
            success=False,
            error_hint=(
                "The URL redirected too many times. "
                "Please paste the job description text directly."
            ),
        )

    except httpx.RequestError as exc:
        logger.warning("Network error fetching job URL %s: %s", url, exc)
        return ScraperResult(
            success=False,
            error_hint=(
                "Could not connect to the job posting URL. "
                "Please check the link or paste the text directly."
            ),
        )

    # ── Step 4: Handle HTTP errors ────────────────────────────────────────────
    if response.status_code == 429:
        # 429 = Too Many Requests — the site is rate-limiting us.
        return ScraperResult(
            success=False,
            error_hint=(
                "The job board is temporarily blocking automated requests. "
                "Please paste the job description text directly."
            ),
        )

    if response.status_code == 403:
        # 403 = Forbidden — the site explicitly blocks non-browser access.
        return ScraperResult(
            success=False,
            error_hint=(
                "This job board doesn't allow automated access. "
                "Please paste the job description text directly."
            ),
        )

    if response.status_code >= 400:
        return ScraperResult(
            success=False,
            error_hint=(
                f"The page returned an error ({response.status_code}). "
                "Please check the URL or paste the job description text directly."
            ),
        )

    # ── Step 5: Parse HTML and extract text ───────────────────────────────────
    return _extract_from_html(response.text, url)


# ─── HTML extraction ──────────────────────────────────────────────────────────

def _extract_from_html(html: str, url: str) -> ScraperResult:
    """
    Parse the HTML response and extract the job description text.

    Strategy:
      1. Parse with lxml (fastest, handles malformed HTML well).
      2. Remove noise tags (scripts, navbars, footers, etc.).
      3. Try CSS selectors from most specific to least specific.
      4. If no selector works, fall back to the largest <p> block strategy.
      5. Clean and normalise the extracted text.

    Args:
        html: Raw HTML string from the HTTP response.
        url:  Original URL (used for logging only).

    Returns:
        ScraperResult with the extracted text, or an error result.
    """
    try:
        # lxml is 2–3× faster than html.parser and handles broken HTML better.
        # Falls back to html.parser if lxml is not installed (shouldn't happen
        # since we pin it in requirements.txt).
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        soup = BeautifulSoup(html, "html.parser")

    # ── Extract page title (nice-to-have metadata) ────────────────────────────
    title = ""
    title_tag = soup.find("title")
    if title_tag:
        # Job pages often have titles like "Senior Engineer at Acme | LinkedIn"
        # Strip the site suffix for a cleaner display name.
        raw_title = title_tag.get_text(strip=True)
        title = re.split(r"\s+[|–-]\s+", raw_title)[0].strip()

    # ── Remove noise elements in-place ───────────────────────────────────────
    # We modify the soup tree directly so subsequent selectors don't see noise.
    _strip_noise(soup)

    # ── Try each content selector ─────────────────────────────────────────────
    for selector in _CONTENT_SELECTORS:
        try:
            element = soup.select_one(selector)
        except Exception:
            # Some attribute selectors can cause BS4 to raise on malformed HTML
            continue

        if element is None:
            continue

        text = _element_to_text(element)
        if len(text) >= _MIN_TEXT_CHARS:
            logger.info(
                "Extracted %d chars via selector '%s' from %s",
                len(text), selector, url,
            )
            return ScraperResult(success=True, text=text, title=title)

    # ── Fallback: largest-paragraph strategy ─────────────────────────────────
    # If no specific selector matched, collect ALL paragraphs and return
    # the block with the most text.  This catches sites that use deeply
    # nested custom HTML without semantic landmarks.
    paragraphs = [
        p.get_text(separator=" ", strip=True)
        for p in soup.find_all("p")
        if len(p.get_text(strip=True)) > 30  # skip short nav/caption <p> tags
    ]

    if paragraphs:
        combined = "\n\n".join(paragraphs)
        if len(combined) >= _MIN_TEXT_CHARS:
            logger.info(
                "Extracted %d chars via paragraph fallback from %s",
                len(combined), url,
            )
            return ScraperResult(success=True, text=combined, title=title)

    # ── Nothing usable found ──────────────────────────────────────────────────
    logger.warning("Could not extract useful text from %s", url)
    return ScraperResult(
        success=False,
        error_hint=(
            "We couldn't find the job description on that page. "
            "The site may require you to be signed in, or the content is "
            "loaded with JavaScript after the page renders. "
            "Please paste the job description text directly."
        ),
    )


def _strip_noise(soup: BeautifulSoup) -> None:
    """
    Remove elements that never contain useful job description text.
    Modifies the soup tree in-place.

    This dramatically improves signal-to-noise for subsequent selectors
    and for the paragraph-fallback strategy.
    """
    for tag_name in ["script", "style", "noscript", "meta", "link",
                     "nav", "header", "footer", "aside",
                     "form", "button", "iframe", "svg", "img", "figure"]:
        for element in soup.find_all(tag_name):
            element.decompose()  # remove from tree entirely

    # Remove elements whose class or id contains noise keywords.
    # We check for substrings rather than exact matches because class names
    # like "modal-overlay" or "cookie-consent-banner" vary by site.
    _NOISE_KEYWORDS = [
        "cookie", "consent", "banner", "modal", "popup",
        "subscribe", "newsletter", "sidebar", "breadcrumb",
        "related-jobs", "similar-jobs", "recommendation",
    ]
    for element in soup.find_all(True):  # all tags
        # element.get() returns None if attribute missing — safe to iterate
        classes = " ".join(element.get("class", []))
        elem_id = element.get("id", "")

        combined = f"{classes} {elem_id}".lower()
        if any(kw in combined for kw in _NOISE_KEYWORDS):
            element.decompose()


def _element_to_text(element) -> str:
    """
    Convert a BeautifulSoup element to clean plain text.

    Uses get_text(separator="\n") so that block-level elements produce line
    breaks rather than running all text together.  Then we normalise
    excessive whitespace.
    """
    raw = element.get_text(separator="\n", strip=False)
    # Collapse horizontal whitespace within lines
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in raw.split("\n")]
    # Drop empty lines, then rejoin with single newlines
    non_empty = [line for line in lines if line]
    # Re-collapse 3+ consecutive lines into a paragraph break
    result = "\n".join(non_empty)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def _validate_url(url: str) -> Optional[object]:
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
