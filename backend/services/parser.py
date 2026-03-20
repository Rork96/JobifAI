"""
backend/services/parser.py — Resume File Text Extractor
─────────────────────────────────────────────────────────────────────────────
Extracts clean plain text from uploaded resume files.

Supported formats:
    PDF   → PyMuPDF (fitz)     — fastest option; ARM64 wheels on PyPI
    DOCX  → python-docx        — handles paragraphs + table-based layouts
    TXT   → stdlib decode      — trivial; included for completeness

WHY PyMuPDF over pdfminer.six?
    PyMuPDF uses the MuPDF rendering engine which reconstructs reading order
    using the visual coordinate system (sort=True flag).  This handles the
    two-column resume layouts that pdfminer misorders.  On a Raspberry Pi 5,
    it's also 3–5× faster.

WHY handle table cells in DOCX?
    Many resume templates use invisible 2-column Word tables to align the
    "dates on the right, company on the left" layout.  python-docx's default
    `doc.paragraphs` iterator skips table content — we must walk `doc.tables`
    separately to capture those cells.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from io import BytesIO
from pathlib import Path

# PyMuPDF — installed as the `PyMuPDF` package, imported as `fitz`
try:
    import fitz  # type: ignore[import]
    _HAS_PYMUPDF = True
except ImportError:  # pragma: no cover
    _HAS_PYMUPDF = False

# python-docx — installed as `python-docx`, imported as `docx`
try:
    import docx  # type: ignore[import]
    _HAS_DOCX = True
except ImportError:  # pragma: no cover
    _HAS_DOCX = False

logger = logging.getLogger("jobifai.parser")

# ─── Constants ─────────────────────────────────────────────────────────────────
# Maximum file size we accept (5 MB).  Real resumes are almost always < 500 KB.
# We enforce this BEFORE reading the bytes to avoid OOM on malicious uploads.
MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB

# Minimum extracted text length to be considered a real resume.
# A 10-character "file" is clearly empty or corrupt.
MIN_TEXT_CHARS = 50


# ─── Public interface ──────────────────────────────────────────────────────────

class ParserError(Exception):
    """
    Raised when we cannot extract text from the file.
    The message is user-facing — keep it friendly and actionable.
    """


def extract_text(content: bytes, filename: str) -> str:
    """
    Extract plain text from a resume file.

    Args:
        content:  Raw file bytes (already read from the UploadFile).
        filename: Original filename — used ONLY to determine the file type
                  from its extension.  Never trusted as a path.

    Returns:
        Clean UTF-8 string with normalised whitespace.

    Raises:
        ParserError: If the file type is unsupported, the file is corrupt,
                     or the extracted text is suspiciously short.
    """
    # Determine type from extension only — never trust content-type header
    # because browsers are inconsistent (e.g. Chrome sends "application/octet-stream"
    # for .docx on some platforms).
    ext = Path(filename).suffix.lower()

    logger.info("Parsing resume — filename=%s  ext=%s  size=%d bytes", filename, ext, len(content))

    if ext == ".pdf":
        raw = _parse_pdf(content, filename)
    elif ext == ".docx":
        raw = _parse_docx(content, filename)
    elif ext == ".txt":
        raw = _parse_txt(content, filename)
    else:
        raise ParserError(
            f"Unsupported file type '{ext}'. "
            "Please upload a PDF, Word (.docx), or plain text (.txt) file."
        )

    # Normalise whitespace: collapse runs of spaces/tabs, but preserve paragraph
    # breaks (double newlines) so the AI can see section structure.
    cleaned = _normalise_whitespace(raw)

    # Sanity check — a legitimate resume should have at least a few words
    if len(cleaned) < MIN_TEXT_CHARS:
        raise ParserError(
            "The file appears to be empty or could not be read. "
            "Try saving it as a different format, or paste the text directly."
        )

    logger.info("Parse succeeded — extracted %d characters", len(cleaned))
    return cleaned


# ─── Format-specific parsers ───────────────────────────────────────────────────

def _parse_pdf(content: bytes, filename: str) -> str:
    """
    Extract text from a PDF using PyMuPDF.

    WHY `sort=True` on get_text()?
        PyMuPDF normally returns text in the order the PDF stores its content
        objects, which is often the order they were drawn — not reading order.
        With `sort=True` the library sorts text blocks by (y, x) coordinate,
        which matches how a human reads left-to-right, top-to-bottom.
        This correctly handles two-column resumes where dates live on the right
        and job titles on the left of the same line.

    WHY open with `stream=content` instead of a file path?
        We receive bytes from FastAPI's UploadFile — there's no file on disk.
        PyMuPDF can open directly from an in-memory bytes buffer using
        `fitz.open(stream=..., filetype="pdf")`.  This avoids a temp-file dance.

    Raises:
        ParserError: If PyMuPDF is not installed or the PDF is corrupt/encrypted.
    """
    if not _HAS_PYMUPDF:
        raise ParserError(
            "PDF parsing is not available on this server. "
            "Please paste your resume text directly."
        )

    try:
        # `with` block ensures the PDF is closed even if an exception occurs.
        # This matters for large PDFs that map memory pages.
        with fitz.open(stream=content, filetype="pdf") as doc:
            # Check for password-protected PDFs — encrypted ones return no text.
            if doc.is_encrypted:
                raise ParserError(
                    f"'{filename}' is password-protected. "
                    "Please remove the password and try again, "
                    "or paste your resume text directly."
                )

            pages: list[str] = []
            for page_num, page in enumerate(doc, start=1):
                # sort=True: re-order text spans by visual position
                page_text = page.get_text("text", sort=True)

                if page_text.strip():
                    pages.append(page_text.strip())

                # Early exit after page 8 — no resume is legitimately longer.
                # This prevents processing a 200-page accidentally-uploaded document.
                if page_num >= 8:
                    logger.warning("PDF exceeds 8 pages — truncating at page 8: %s", filename)
                    break

            if not pages:
                raise ParserError(
                    f"No text could be extracted from '{filename}'. "
                    "The PDF may contain only images (a scanned resume). "
                    "Please use a text-based PDF or paste your resume text."
                )

            return "\n\n".join(pages)

    except fitz.FileDataError as exc:
        raise ParserError(
            f"'{filename}' appears to be a corrupt or invalid PDF. "
            "Please try re-saving it or paste the text directly."
        ) from exc


def _parse_docx(content: bytes, filename: str) -> str:
    """
    Extract text from a Word .docx file using python-docx.

    WHY do we walk both `doc.paragraphs` AND `doc.tables`?
        Many resume templates — especially the ones downloaded from Microsoft
        Word's gallery — use invisible 2-column tables to create the
        "Dates on the right, Role on the left" visual layout.  These cells
        are completely absent from `doc.paragraphs`.  We must walk `doc.tables`
        and visit every cell to capture that content.

    Deduplication:
        When a user adds text both inside and outside a table, it can appear in
        both `doc.paragraphs` and the table cells.  We deduplicate by keeping a
        `seen` set of stripped paragraph strings.

    Raises:
        ParserError: If python-docx is not installed or the file is corrupt.
    """
    if not _HAS_DOCX:
        raise ParserError(
            "DOCX parsing is not available on this server. "
            "Please paste your resume text directly."
        )

    try:
        document = docx.Document(BytesIO(content))
    except Exception as exc:
        raise ParserError(
            f"'{filename}' could not be opened as a Word document. "
            "It may be corrupt or an unsupported format. "
            "Try saving as .docx (not .doc) or paste the text directly."
        ) from exc

    lines: list[str] = []
    seen: set[str] = set()  # deduplication of repeated text (tables vs paragraphs)

    def _add(text: str) -> None:
        """Add a line if it's non-empty and not already seen."""
        stripped = text.strip()
        if stripped and stripped not in seen:
            seen.add(stripped)
            lines.append(stripped)

    # ── Pass 1: top-level paragraphs ──────────────────────────────────────────
    for para in document.paragraphs:
        _add(para.text)

    # ── Pass 2: table cells ───────────────────────────────────────────────────
    # We iterate tables → rows → cells → cell paragraphs.  This covers the
    # common two-column resume layout where dates are in the right column.
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for cell_para in cell.paragraphs:
                    _add(cell_para.text)

    if not lines:
        raise ParserError(
            f"No text could be extracted from '{filename}'. "
            "The document may be empty or use an unsupported layout. "
            "Please paste your resume text directly."
        )

    return "\n".join(lines)


def _parse_txt(content: bytes, filename: str) -> str:
    """
    Decode a plain-text file to a string.

    WHY `errors='replace'`?
        Some users copy-paste from Word into a .txt file saved with Windows-1252
        encoding (not UTF-8).  Instead of crashing on the first smart-quote,
        we replace undecodable bytes with the Unicode replacement character (U+FFFD).
        The AI downstream is robust to the occasional strange character.
    """
    try:
        return content.decode("utf-8", errors="replace")
    except Exception as exc:
        raise ParserError(
            f"Could not read '{filename}' as text. "
            "Please ensure it is a plain text file."
        ) from exc


# ─── Text cleanup ──────────────────────────────────────────────────────────────

def _normalise_whitespace(text: str) -> str:
    """
    Normalise whitespace in extracted text:
      • Collapse runs of spaces/tabs to a single space on each line.
      • Preserve single newlines (line breaks within a section).
      • Collapse 3+ consecutive blank lines to exactly 2 (paragraph separator).
      • Strip leading/trailing whitespace from the whole document.

    We deliberately do NOT strip ALL newlines, because the AI uses paragraph
    structure to identify section boundaries (Experience vs Education, etc.).
    """
    import re

    # Remove carriage returns (Windows line endings → Unix)
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Collapse horizontal whitespace within each line
    # (but leave newlines alone — handled next)
    lines = [re.sub(r"[ \t]+", " ", line) for line in text.split("\n")]

    # Rejoin and collapse excessive blank lines
    rejoined = "\n".join(lines)
    rejoined = re.sub(r"\n{3,}", "\n\n", rejoined)

    return rejoined.strip()
