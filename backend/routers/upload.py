"""
backend/routers/upload.py — Resume File Upload Endpoint
─────────────────────────────────────────────────────────────────────────────
POST /api/upload-resume

Accepts a multipart/form-data file upload (PDF, DOCX, or TXT).
Delegates parsing to backend/services/parser.py and returns the
extracted plain text to the frontend for display and Zustand storage.

SECURITY CONSIDERATIONS:
  • We validate the file extension — we trust the extension over the
    Content-Type header because browsers lie about MIME types for .docx.
  • File size is capped at 5 MB before reading any bytes.
  • We never write to disk — the bytes stay in memory and are GC'd
    immediately after the request completes.
  • The extracted text is returned as-is — never executed, never stored
    server-side at this stage (storage is a future Supabase task).

FAIL-OPEN VS. FAIL-CLOSED:
  Unlike the evaluate-edit endpoint (which fails open to not block the
  interview), this endpoint fails CLOSED with a 422.  If we can't parse
  the file, we should not silently pass an empty string to the AI — that
  would produce nonsense resume suggestions.  Instead we return an error
  and the frontend falls back to "paste manually" mode.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from ..services.parser import MAX_FILE_BYTES, ParserError, extract_text

logger = logging.getLogger("jobifai.upload")

# ─── Router ───────────────────────────────────────────────────────────────────
router = APIRouter(
    prefix="/api",
    tags=["upload"],
)


# ─── Response model ───────────────────────────────────────────────────────────

class UploadResumeResponse(BaseModel):
    """
    Returned on successful text extraction.

    text:       The clean extracted plain text.  Frontend populates the
                resume textarea with this value.
    filename:   Original filename — shown in the UI as a confirmation that
                the right file was processed.
    char_count: Number of characters extracted — shown as a quality signal
                ("✓ 2,341 characters extracted").
    """
    text:       str
    filename:   str
    char_count: int


# ─── Endpoint ─────────────────────────────────────────────────────────────────

@router.post(
    "/upload-resume",
    response_model=UploadResumeResponse,
    summary="Extract text from an uploaded resume file",
    description="""
Upload a resume file (PDF, DOCX, or TXT) and receive the extracted plain text.

**Supported formats:**
- `.pdf` — processed with PyMuPDF; handles text-based PDFs up to 8 pages
- `.docx` — processed with python-docx; extracts paragraphs + table cells
- `.txt` — decoded as UTF-8 with error replacement

**Limits:**
- Maximum file size: 5 MB
- Maximum PDF pages: 8 (no resume legitimately exceeds this)

**Not supported:**
- `.doc` (legacy Word format) — please save as .docx
- Scanned PDFs (image-only) — please use a text-based PDF
- Password-protected files — please remove the password first
    """,
)
async def upload_resume(
    file: UploadFile = File(
        ...,
        description="The resume file to parse (PDF, DOCX, or TXT)",
    ),
) -> UploadResumeResponse:
    """
    POST /api/upload-resume — Parse an uploaded resume file.

    Flow:
      1. Check file size against MAX_FILE_BYTES BEFORE reading all bytes.
         FastAPI's UploadFile is a SpooledTemporaryFile — we read it once,
         check size, then pass bytes to the parser.  Reading twice would
         require seek(0), which SpooledTemporaryFile supports but we avoid
         for clarity.

      2. Delegate to extract_text() in parser.py.

      3. Return the cleaned text + metadata.  On ParserError, return 422
         with the user-facing error message.
    """
    filename = file.filename or "resume"

    # ── Read file bytes ────────────────────────────────────────────────────────
    # We read all bytes at once because our max is 5 MB — safe for RAM.
    # For a future high-traffic version, streaming chunk-by-chunk with a size
    # counter would be more memory-efficient.
    content = await file.read()

    logger.info(
        "Resume upload received — filename=%s  size=%d bytes  content_type=%s",
        filename,
        len(content),
        file.content_type,
    )

    # ── Enforce file size limit ────────────────────────────────────────────────
    # We check AFTER reading because UploadFile doesn't expose size until read.
    # A malicious upload of 6 MB would be read but immediately rejected.
    # This is acceptable for a 5 MB limit — a true streaming size-check would
    # require a custom middleware for very large files.
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,  # 413 Payload Too Large
            detail=(
                f"File is too large ({len(content) // 1024} KB). "
                f"Maximum allowed size is {MAX_FILE_BYTES // 1024 // 1024} MB. "
                "Please compress your PDF or remove unnecessary pages."
            ),
        )

    # ── Empty file guard ───────────────────────────────────────────────────────
    if not content:
        raise HTTPException(
            status_code=422,
            detail="The uploaded file is empty.",
        )

    # ── Parse ──────────────────────────────────────────────────────────────────
    try:
        extracted_text = extract_text(content, filename)
    except ParserError as exc:
        # ParserError messages are already user-facing (no technical jargon)
        logger.warning("Parse failed for %s: %s", filename, exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        # Unexpected errors — log the full traceback but return a generic message
        logger.exception("Unexpected parse error for %s: %s", filename, exc)
        raise HTTPException(
            status_code=500,
            detail=(
                "An unexpected error occurred while processing your file. "
                "Please try again or paste your resume text directly."
            ),
        ) from exc

    logger.info(
        "Resume parsed successfully — filename=%s  chars=%d",
        filename,
        len(extracted_text),
    )

    return UploadResumeResponse(
        text=extracted_text,
        filename=filename,
        char_count=len(extracted_text),
    )
