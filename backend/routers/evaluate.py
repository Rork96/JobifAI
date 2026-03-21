"""
backend/routers/evaluate.py — The ATS Edit Scorer Endpoint
─────────────────────────────────────────────────────────────────────────────
POST /api/evaluate-edit

Runs every proposed resume edit through a Gemini-powered quality gate before
it is committed to the user's resume state.  This is the "Two-Step Validation":

  Step 1 — Mac's interview turn produces a data_extract payload (interview.py)
  Step 2 — BEFORE committing, ChatPanel calls this endpoint to score the edit
            → approved:   data flows to the store → DocumentPreview flashes
            → rejected:   Mac appends an explanation asking for better info

WHY TEMPERATURE 0.0?
  The scorer must be deterministic and strict.  We do NOT want creative
  variation in approval decisions — the same bullet should always get the
  same verdict.  Temperature 0.0 forces Gemini to pick the single most
  likely token at each step.

FAIL-OPEN DESIGN:
  If this endpoint errors (network timeout, Gemini rate-limit, etc.),
  we return `approved: true` with a generic reason.  The interview MUST
  NOT be blocked by a secondary scoring service — the primary SSE stream
  is always the source of truth.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import google.generativeai as genai
from fastapi import APIRouter, Depends
from google.generativeai.types import HarmBlockThreshold, HarmCategory
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..services.embeddings import calculate_ats_score

logger = logging.getLogger("jobifai.evaluate")

# ─── Router ───────────────────────────────────────────────────────────────────
router = APIRouter(
    prefix="/api",
    tags=["evaluate"],
)


# ─── Scorer System Prompt ──────────────────────────────────────────────────────
# Temperature 0.0 is used for this prompt, so it must be extremely directive.
# We want a strict, consistent verdict — not a creative interpretation.
_SCORER_SYSTEM = """\
You are a strict Canadian resume quality evaluator with 15 years of ATS and HR hiring experience.

Your ONLY job: evaluate a proposed resume addition and return a JSON verdict.

══ APPROVAL CRITERIA — approve if ALL of these apply ══════════════════════════
✓  Adds concrete, specific information not already present in the resume
✓  Uses strong action verbs (Led, Built, Engineered, Reduced, Launched, etc.)
✓  Contains at least some specificity — a metric (%, $, count, time) is ideal
✓  Is professionally worded and free of grammatical errors
✓  Does not contain forbidden HR information (age, gender, nationality, religion, etc.)

══ REJECTION CRITERIA — reject if ANY of these apply ══════════════════════════
✗  Vague generic statement with zero specifics ("worked on various projects")
✗  Exact duplicate of information already present in the resume
✗  Contains discriminatory or personal information (protected by Canadian Human Rights Act)
✗  Grammatically incorrect or unprofessional language
✗  Empty, trivial, or adds no measurable value

══ score_delta SCALE ══════════════════════════════════════════════════════════
+5:        Outstanding — quantified metric with strong action verb and unique value
+3 to +4:  Good — specific and professional, minor metric gap
+1 to +2:  Acceptable — adds value, could be stronger
 0:        Neutral — no clear improvement
-1 to -3:  Weakens the resume or duplicates existing content
-4 to -5:  Harmful — discriminatory, plagiarised, or fraudulent

══ OUTPUT FORMAT (respond with ONLY this JSON — no markdown, no code fences) ══
{"approved": true_or_false, "reason": "One clear concise sentence.", "score_delta": integer}
"""


# ─── Request / Response Models ─────────────────────────────────────────────────

class EvaluateRequest(BaseModel):
    """
    The payload sent by ChatPanel when a non-empty data_extract event arrives.

    field_type:           Resume section being updated.  Used as context for
                          the scorer (e.g. "experiences", "skills", "summary").

    proposed_edit:        The actual content to evaluate as a string.
                          ChatPanel serialises the first meaningful value from
                          the data_extract payload into this field:
                            targetTitle → the title string
                            summary     → the summary text
                            experiences → JSON of the first experience entry
                            skills      → comma-separated skill names

    current_resume_state: What is already in the user's resume.  The scorer
                          uses this to detect duplicates and assess relevance.

    job_description:      Optional target job posting text.  When provided,
                          the scorer also checks keyword/ATS alignment.
    """
    field_type:           str            = Field(..., description="Resume section type (e.g. 'experiences', 'skills')")
    proposed_edit:        str            = Field(..., min_length=1, max_length=2000, description="Proposed addition as a string")
    current_resume_state: dict[str, Any] = Field(default_factory=dict,           description="Existing resume data for duplicate detection")
    job_description:      str            = Field(default="",                     description="Optional target job description for ATS scoring")


class EvaluateResponse(BaseModel):
    approved:    bool = Field(..., description="True if the edit improves the resume")
    reason:      str  = Field(..., description="One sentence explanation of the verdict")
    score_delta: int  = Field(..., ge=-5, le=5, description="Estimated ATS score impact")


# ─── ATS Score Models ──────────────────────────────────────────────────────────

class AtsScoreRequest(BaseModel):
    """
    Resume text + job description to compare semantically.
    Both fields accept plain text (already extracted by the upload / parse-job endpoints).
    """
    resume_text:     str = Field(..., min_length=10, description="Plain text of the resume")
    job_description: str = Field(default="",         description="Plain text of the job posting")


class MissingSkill(BaseModel):
    """A single skill the resume lacks, with its estimated ATS impact."""
    skill:             str = Field(..., description="Skill or keyword missing from the resume")
    impact_percentage: int = Field(..., ge=1, le=30, description="Estimated ATS score gain if added")


class AtsScoreResponse(BaseModel):
    """
    Result of the semantic ATS match calculation.

    score:           0–100 integer.  Reflects cosine similarity rescaled to a
                     user-readable percentage.  Below 50 = poor match.
    skill_gaps:      Specific keywords/tools present in the JD but absent from
                     the resume (legacy flat list — kept for backwards compat).
    matched_skills:  Keywords/tools that are present in BOTH the resume and JD.
    missing_skills:  Structured list of gaps with per-skill impact estimates.
                     impact_percentage values sum to bridge score → 100%.
    """
    score:          int               = Field(..., ge=0, le=100)
    skill_gaps:     list[str]         = Field(default_factory=list)
    matched_skills: list[str]         = Field(default_factory=list)
    missing_skills: list[MissingSkill] = Field(default_factory=list)


# ─── Endpoint ──────────────────────────────────────────────────────────────────

@router.post(
    "/evaluate-edit",
    response_model=EvaluateResponse,
    summary="Score a proposed resume edit before committing it",
    description="""
Evaluates a proposed resume addition **before** it is committed to the user's state.

Returns `approved: true` when the edit improves the resume's quality and ATS score.
Returns `approved: false` with a `reason` that Mac uses to ask the user for better info.

**Fail-open:** If Gemini is unavailable, the endpoint returns `approved: true`
so the interview is never blocked by a secondary service.
    """,
)
async def evaluate_edit(
    body: EvaluateRequest,
    settings: Settings = Depends(get_settings),
) -> EvaluateResponse:
    """
    POST /api/evaluate-edit — Two-step ATS quality gate.

    Called from ChatPanel after every non-empty data_extract event.
    Gemini scores the proposed edit with temperature=0.0 for determinism.
    The scorer adds ~300-500ms latency; we fire it CONCURRENTLY with the
    SSE `done` processing so the user barely notices.
    """
    # ── Build the model (temperature=0.0 for strict, deterministic scoring) ──
    # We call genai.configure() here defensively — it was already called at
    # startup in main.py lifespan, but this ensures the key is always set.
    genai.configure(api_key=settings.gemini_api_key)

    model = genai.GenerativeModel(
        model_name="gemini-2.5-flash",
        system_instruction=_SCORER_SYSTEM,
        generation_config=genai.types.GenerationConfig(
            temperature=0.0,       # deterministic — same input → same verdict
            top_p=1.0,
            max_output_tokens=128, # short JSON response only — no prose needed
        ),
        safety_settings={
            HarmCategory.HARM_CATEGORY_HARASSMENT:        HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_HATE_SPEECH:       HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
    )

    # ── Build the evaluation prompt ──────────────────────────────────────────
    # We truncate the existing resume state to avoid blowing the context window
    # for users who already have a lot of experience entries.
    existing_json = json.dumps(body.current_resume_state, ensure_ascii=False)
    if len(existing_json) > 1500:
        existing_json = existing_json[:1500] + "... [truncated for length]"

    jd_section = ""
    if body.job_description.strip():
        jd_section = f"\n\nTarget job description (ATS keyword alignment):\n{body.job_description[:400]}"

    prompt = (
        f"Resume section: {body.field_type}\n"
        f"Proposed addition to evaluate: {body.proposed_edit}\n"
        f"\nExisting resume content (check for duplicates):\n{existing_json}"
        f"{jd_section}\n\n"
        "Return ONLY the JSON verdict — no other text."
    )

    try:
        response = await model.generate_content_async(prompt)
        raw = (response.text or "").strip()

        # Strip markdown code fences if the model wraps the JSON anyway
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1] if len(parts) > 1 else raw
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        result = json.loads(raw)

        logger.info(
            "Evaluate — field=%s approved=%s delta=%s",
            body.field_type,
            result.get("approved"),
            result.get("score_delta"),
        )

        return EvaluateResponse(
            approved=bool(result.get("approved", False)),
            reason=str(result.get("reason", "No reason provided.")),
            # Clamp score_delta to [-5, 5] even if the model goes out of range
            score_delta=max(-5, min(5, int(result.get("score_delta", 0)))),
        )

    except Exception as exc:  # noqa: BLE001
        # FAIL OPEN — the interview must never be blocked by a scoring error.
        # Log a warning (not an exception) to avoid noise in production.
        logger.warning(
            "Evaluate endpoint error (fail-open) — %s: %s",
            type(exc).__name__,
            exc,
        )
        return EvaluateResponse(
            approved=True,
            reason="Evaluation service unavailable — edit approved by default.",
            score_delta=0,
        )


# ─── ATS Score Endpoint ────────────────────────────────────────────────────────

@router.post(
    "/ats-score",
    response_model=AtsScoreResponse,
    summary="Calculate semantic ATS match score between resume and job description",
    description="""
Embeds the resume and job description using Google **text-embedding-004**, then
measures their cosine similarity to produce a 0–100 ATS match percentage.

Also returns a `skill_gaps` list: keywords required by the JD that are absent
from the resume — each item is a specific string the user should add.

**Math overview:**
- Cosine similarity = (A · B) / (‖A‖ × ‖B‖)
- Raw range ~[0.30, 0.90] is rescaled linearly to [0%, 100%]
- < 50: poor match · 50–80: moderate · > 80: strong match
    """,
)
async def ats_score(
    body: AtsScoreRequest,
    settings: Settings = Depends(get_settings),
) -> AtsScoreResponse:
    """
    POST /api/ats-score — Semantic ATS match scoring.

    Delegates to embeddings.calculate_ats_score() which runs two concurrent
    embedding calls then a Gemini skill-gap analysis.

    Fail-safe: on any error, returns score=0 with an empty skill_gaps list
    so the frontend can still proceed without crashing.
    """
    genai.configure(api_key=settings.gemini_api_key)

    try:
        result = await calculate_ats_score(
            resume_text=body.resume_text,
            job_description=body.job_description,
        )
        logger.info(
            "ATS score endpoint — score=%d  gaps=%d  matched=%d",
            result["score"],
            len(result["skill_gaps"]),
            len(result.get("matched_skills", [])),
        )
        missing = [
            MissingSkill(skill=m["skill"], impact_percentage=m["impact_percentage"])
            for m in result.get("missing_skills", [])
        ]
        return AtsScoreResponse(
            score=result["score"],
            skill_gaps=result["skill_gaps"],
            matched_skills=result.get("matched_skills", []),
            missing_skills=missing,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "ATS score endpoint error (fail-safe) — %s: %s",
            type(exc).__name__,
            exc,
        )
        return AtsScoreResponse(score=0, skill_gaps=[], matched_skills=[], missing_skills=[])


# ─── Magic Rewrite Endpoint ────────────────────────────────────────────────────

_REWRITE_SYSTEM = """\
You are an elite Canadian resume writer with expertise in ATS optimisation.
Your job: rewrite a single resume text snippet to be stronger, more specific,
and more likely to pass ATS scanners — WITHOUT inventing facts.

Rules:
1. PRESERVE all factual claims (company, role, metrics, technologies).
2. START with a strong action verb (Led, Built, Engineered, Reduced, etc.).
3. ADD specificity where the original is vague — suggest a placeholder like
   "[X%]" if no metric is present, so the user knows where to add one.
4. Keep the rewrite concise: 1–2 lines maximum.
5. Match the target job description keywords if provided.
6. NEVER invent facts, dates, or numbers that weren't in the original.

Return ONLY this JSON — no markdown, no code fences:
{"new_text": "the rewritten text", "predicted_score_increase": integer_3_to_8}

predicted_score_increase must be an integer between 3 and 8 representing the
estimated ATS score improvement in percentage points.
"""


class RewriteRequest(BaseModel):
    """
    A single resume text snippet the user wants the AI to improve.

    section:          Human-readable label for context ("Experience bullet", "Summary", etc.)
    old_text:         The exact text to rewrite — must be preserved factually.
    job_description:  Optional JD text for keyword alignment (up to 600 chars used).
    resume_context:   Optional condensed existing resume for duplicate / continuity detection.
    """
    section:          str = Field(..., min_length=1, max_length=100)
    old_text:         str = Field(..., min_length=1, max_length=1000)
    job_description:  str = Field(default="", max_length=2000)
    resume_context:   str = Field(default="", max_length=1500)


class RewriteResponse(BaseModel):
    """
    Structured diff payload consumed by the frontend DiffOverlay component.

    section:                 Echoed back from the request (for display in the diff header).
    old_text:                The original text (shown with red strikethrough in the diff UI).
    new_text:                The AI rewrite (shown with green background).
    predicted_score_increase: Estimated ATS score improvement in percentage points (3–8).
    """
    section:                 str = Field(..., description="Section label (echoed from request)")
    old_text:                str = Field(..., description="Original text")
    new_text:                str = Field(..., description="AI-rewritten text")
    predicted_score_increase: int = Field(..., ge=3, le=8, description="Estimated ATS improvement %")


@router.post(
    "/rewrite-section",
    response_model=RewriteResponse,
    summary="AI Magic Rewrite — improve a specific resume text snippet",
    description="""
Rewrites a single resume bullet, summary, or title using an expert resume-writing
agent and returns a structured diff:

```json
{
  "section": "Experience bullet",
  "old_text": "worked on the backend",
  "new_text": "Engineered RESTful microservices in Python, reducing API latency by [X%]",
  "predicted_score_increase": 6
}
```

The frontend renders a GitHub PR-style diff and lets the user Accept or Reject.
Only an Accepted diff updates the live resume state.

**Fail-safe**: On any Gemini error, the endpoint echoes `old_text` as `new_text`
with `predicted_score_increase: 0` so the frontend handles the error gracefully.
    """,
)
async def rewrite_section(
    body: RewriteRequest,
    settings: Settings = Depends(get_settings),
) -> RewriteResponse:
    """
    POST /api/rewrite-section — The "✨ Magic" button backend.

    Uses Gemini at temperature=0.4 (slightly creative, but not hallucination-prone)
    to produce a better version of the provided text snippet.
    """
    genai.configure(api_key=settings.gemini_api_key)

    model = genai.GenerativeModel(
        model_name="gemini-2.5-flash",
        system_instruction=_REWRITE_SYSTEM,
        generation_config=genai.types.GenerationConfig(
            temperature=0.4,
            top_p=0.95,
            max_output_tokens=512,
        ),
        safety_settings={
            HarmCategory.HARM_CATEGORY_HARASSMENT:        HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_HATE_SPEECH:       HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
    )

    jd_section = ""
    if body.job_description.strip():
        jd_section = f"\n\nTarget job description (for keyword alignment):\n{body.job_description[:600]}"

    ctx_section = ""
    if body.resume_context.strip():
        ctx_section = f"\n\nExisting resume context (avoid duplicating):\n{body.resume_context[:600]}"

    prompt = (
        f"Section: {body.section}\n"
        f"Text to rewrite: {body.old_text}"
        f"{jd_section}"
        f"{ctx_section}\n\n"
        "Return ONLY the JSON — no other text."
    )

    try:
        response = await model.generate_content_async(prompt)
        raw = (response.text or "").strip()

        # Try full JSON parse first (ideal path)
        new_text: str = body.old_text
        delta: int = 5
        try:
            m = re.search(r'\{.*\}', raw, re.DOTALL)
            result = json.loads(m.group(0) if m else raw)
            new_text = str(result.get("new_text", body.old_text))
            delta = max(3, min(8, int(result.get("predicted_score_increase", 5))))
        except (json.JSONDecodeError, ValueError, AttributeError):
            # Fallback: extract new_text value directly from partial JSON
            tm = re.search(r'"new_text"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
            if tm:
                new_text = tm.group(1)
            dm = re.search(r'"predicted_score_increase"\s*:\s*(\d+)', raw)
            if dm:
                delta = max(3, min(8, int(dm.group(1))))

        logger.info("Rewrite — section=%s delta=%s extracted=%r", body.section, delta, new_text[:60])

        return RewriteResponse(
            section=body.section,
            old_text=body.old_text,
            new_text=new_text,
            predicted_score_increase=delta,
        )

    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Rewrite endpoint error (fail-safe) — %s: %s",
            type(exc).__name__,
            exc,
        )
        # Fail-safe: echo the original text so the diff overlay can still render
        return RewriteResponse(
            section=body.section,
            old_text=body.old_text,
            new_text=body.old_text,
            predicted_score_increase=3,
        )
