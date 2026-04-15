"""
schemas.py — Shared Pydantic V2 data contracts
─────────────────────────────────────────────────────────────────────────────
These models are the single source of truth for the parse pipeline:

  HTTP request  →  ParseRequest
  Gemini output →  ParserOutput   (enforced via response_schema)
  HTTP response →  ParseResponse  (wraps ParserOutput + ATS metadata)

The inner models (ResumeBullet, ResumeSection) mirror the TypeScript types
in frontend/src/lib/types.ts exactly.  When you change a field here,
update the TS types too.

IMPORTANT — Gemini SDK constraint:
  response_schema converts Pydantic models to protos.Schema.  That type has
  NO "default" property, so ALL fields used as response_schema must use
  Field(...) — required, no default value.  Fields with default= or
  default_factory= cause a ValueError at model-construction time.

  EvalResumeInput is the lean evaluate-endpoint counterpart to ParserOutput.
  It accepts only {sections: [...]} so the frontend never needs to send
  candidateName / contactInfo to /evaluate.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


# ── Document models ────────────────────────────────────────────────────────────

class ResumeBullet(BaseModel):
    id: str = Field(..., description="Unique ID, e.g., bul_123")
    text: str = Field(..., description="The content of the bullet point or meta line")
    isMeta: bool = Field(
        ...,
        description=(
            "True if it's just dates, locations, or short context "
            "without a bullet point marker"
        ),
    )


class ResumeSection(BaseModel):
    id: str = Field(..., description="Unique ID, e.g., sec_exp")
    title: str = Field(
        ...,
        description=(
            "Canonical Title: Summary, Experience, Skills, Projects, "
            "Education, or Certifications. NEVER 'Contact'."
        ),
    )
    isInteractive: bool = Field(
        ...,
        description="True ONLY for Summary, Experience, Projects, Skills",
    )
    bullets: List[ResumeBullet]


# ── API request / response models ─────────────────────────────────────────────

class ParseRequest(BaseModel):
    rawText: str
    jobDescription: Optional[str] = None


class ParseResponse(BaseModel):
    sections: List[ResumeSection]
    atsScore: int = Field(..., description="Score from 0 to 100")
    missingKeywords: List[str] = Field(..., description="List of missing keywords")


# ── Gemini structured-output contract ─────────────────────────────────────────
# ParserOutput is passed as `response_schema` to the Gemini API call.
# ALL fields MUST use Field(...) — no defaults allowed (see module docstring).

class ParserOutput(BaseModel):
    candidateName: str = Field(
        ...,
        description=(
            "The candidate's full name, extracted verbatim. "
            "Use the string 'Unknown' if no name is present in the text."
        ),
    )
    contactInfo: List[str] = Field(
        ...,
        description=(
            "Ordered list of individual contact details: email address, phone number, "
            "LinkedIn URL, GitHub URL, personal website, city/country. "
            "Each element is a single value. Do NOT include the candidate name here. "
            "Use an empty list [] if no contact details are present."
        ),
    )
    sections: List[ResumeSection] = Field(
        ...,
        description=(
            "The main resume content sections: Summary, Experience, Projects, Skills, "
            "Education, Certifications. "
            "NEVER create a 'Contact' section — name belongs in candidateName and "
            "contact details belong in contactInfo. "
            "Only include sections that are present in the source text."
        ),
    )


# ── Lean evaluate-endpoint resume input ───────────────────────────────────────
# The frontend sends the already-parsed resume to /evaluate.  It only needs
# sections for keyword matching — candidateName / contactInfo are not required.
# Using a separate model keeps ParserOutput's Gemini contract clean (no
# optional fields that could confuse response_schema).

class EvalResumeInput(BaseModel):
    sections: List[ResumeSection] = Field(
        ..., description="List of parsed resume sections for ATS keyword matching."
    )


# ── Weak bullet descriptor ────────────────────────────────────────────────────
# Returned inside EvaluationOutput — richer than a bare ID string.

class WeakBullet(BaseModel):
    id: str = Field(
        ...,
        description="The exact `id` field of the bullet from the resume JSON (e.g. 'bul_42').",
    )
    label: str = Field(
        ...,
        description=(
            "Short 2-3 word human label for the button, e.g. 'Acme Corp Role' or "
            "'Leadership Skills'. Derived from section title + employer/context."
        ),
    )
    suggestion: str = Field(
        ...,
        description=(
            "One concrete sentence telling the user exactly what to fix, "
            "e.g. 'Add deployment frequency and uptime metrics to show impact.'"
        ),
    )


# ── Evaluator HTTP request contract ──────────────────────────────────────────
# Accepts the already-parsed resume JSON from the frontend so the /evaluate
# endpoint never needs to re-run the parser (eliminates double-parsing).
# Uses EvalResumeInput (sections only) — the frontend never sends
# candidateName / contactInfo to this endpoint.

class EvaluateRequest(BaseModel):
    parsedResume: EvalResumeInput
    jobDescription: Optional[str] = None


# ── Evaluator structured-output contract ──────────────────────────────────────
# Returned by agents/evaluator_agent.py — passed as response_schema to Gemini
# so the model is constrained to emit only these two fields.

class WeakBulletsOutput(BaseModel):
    """
    Internal Gemini contract for the stripped-down evaluator.
    Only weak bullet identification — score and keywords come from the fast
    Python keyword engine, so we don't ask the model to do math.
    """
    weakBullets: List[WeakBullet] = Field(
        default_factory=list,
        description=(
            "1 to 3 weak bullets with id, label, suggestion. "
            "Return an empty list if all bullets are strong."
        ),
    )


class EvaluationOutput(BaseModel):
    atsScore: int = Field(
        ..., description="Calculated match score between 0 and 100"
    )
    missingKeywords: List[str] = Field(
        ..., description="Top 3 to 5 critical keywords present in the JD but missing in the resume"
    )
    weakBullets: List[WeakBullet] = Field(
        default_factory=list,
        description=(
            "1 to 3 weak bullets from the resume that need urgent rewriting. "
            "Each entry carries the bullet id, a short label, and a specific suggestion."
        ),
    )


# ── General Mentor chat contract ──────────────────────────────────────────────
# Used by POST /api/v1/chat — fires when the user messages Mac without a bullet
# selected.  The optional ATS fields let Mac give score-aware advice.

class ChatRequest(BaseModel):
    userMessage: str
    jobDescription: Optional[str] = None
    atsScore: Optional[int] = None
    missingKeywords: Optional[List[str]] = None
    # Full serialised resume sections — Mac reads THIS to critique the actual document.
    # Passed as a JSON-stringified array of ResumeSection objects from the frontend store.
    # Never None for Workspace sessions; may be None in legacy/test calls.
    resumeContext: Optional[str] = None


class ChatResponse(BaseModel):
    coachMessage: str = Field(
        ...,
        description=(
            "Short, encouraging, actionable reply from Mac (2-3 sentences). "
            "Reference the ATS score / missing keywords when available."
        ),
    )


# ── Surgeon agent contract ─────────────────────────────────────────────────────

class RewriteRequest(BaseModel):
    originalText: str
    jobDescription: Optional[str] = None
    userMessage: str
    # Full serialised resume sections — Mac sees the whole document, not just the bullet.
    # Enables cross-section coherence checks and prevents duplicate phrasing.
    resumeContext: Optional[str] = None


class RewriteResponse(BaseModel):
    proposedText: str = Field(
        ...,
        description=(
            "The rewritten bullet. Return an EMPTY STRING '' if the user "
            "instruction is invalid or lacks context."
        ),
    )
    coachMessage: str = Field(
        ...,
        description=(
            "Message from the AI. Explains changes OR asks for more context "
            "if proposedText is empty."
        ),
    )
