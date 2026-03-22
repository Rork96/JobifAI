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
            response_mime_type="application/json",  # force clean JSON, no fences, no preamble
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
        raw = _extract_response_text(response)
        raw = _strip_fences(raw)

        print(f"DEBUG /api/evaluate-edit: field={body.field_type!r}  raw={raw[:200]!r}")

        m = re.search(r'\{.*\}', raw, re.DOTALL)
        result = json.loads(m.group(0) if m else raw)

        logger.info(
            "Evaluate ✅ — field=%s approved=%s delta=%s",
            body.field_type,
            result.get("approved"),
            result.get("score_delta"),
        )

        return EvaluateResponse(
            approved=bool(result.get("approved", False)),
            reason=str(result.get("reason", "No reason provided.")),
            score_delta=max(-5, min(5, int(result.get("score_delta", 0)))),
        )

    except Exception as exc:  # noqa: BLE001
        # FAIL OPEN — the interview must never be blocked by a scoring error.
        logger.exception(
            "Evaluate endpoint FAILED (fail-open) — field=%s  %s: %s",
            body.field_type, type(exc).__name__, exc,
        )
        print(f"ERROR /api/evaluate-edit: {type(exc).__name__}: {exc}")
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

    _rewrite_gen_config = genai.types.GenerationConfig(
        temperature=0.4,
        top_p=0.95,
        max_output_tokens=512,
        response_mime_type="application/json",  # force clean JSON, no fences, no preamble
    )
    _rewrite_safety = {
        HarmCategory.HARM_CATEGORY_HARASSMENT:        HarmBlockThreshold.BLOCK_ONLY_HIGH,
        HarmCategory.HARM_CATEGORY_HATE_SPEECH:       HarmBlockThreshold.BLOCK_ONLY_HIGH,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
    }

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
        _model_used, response = await _generate_with_model_fallback(
            model_priority=_ANALYZE_MODEL_PRIORITY,
            system_instruction=_REWRITE_SYSTEM,
            generation_config=_rewrite_gen_config,
            safety_settings=_rewrite_safety,
            prompt=prompt,
        )
        logger.info("Rewrite using model=%s", _model_used)
        raw = _extract_response_text(response)
        raw = _strip_fences(raw)

        print(f"DEBUG /api/rewrite-section: section={body.section!r}  raw={raw[:200]!r}")

        # Try full JSON parse
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

        logger.info("Rewrite ✅ — section=%s delta=%s extracted=%r", body.section, delta, new_text[:60])

        return RewriteResponse(
            section=body.section,
            old_text=body.old_text,
            new_text=new_text,
            predicted_score_increase=delta,
        )

    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Rewrite endpoint FAILED (fail-safe) — section=%s  %s: %s",
            body.section, type(exc).__name__, exc,
        )
        print(f"ERROR /api/rewrite-section: {type(exc).__name__}: {exc}")
        return RewriteResponse(
            section=body.section,
            old_text=body.old_text,
            new_text=body.old_text,
            predicted_score_increase=3,
        )


# ─── ATS Analysis Endpoint ─────────────────────────────────────────────────────
#
# POST /api/analyze
#
# This is the SINGLE authoritative analysis call that drives the onboarding
# → workspace handoff.  It replaces the old /api/ats-score + client-side
# greeting assembly with ONE atomic response:
#
#   score             — 0-100 ATS keyword-coverage percentage
#   foundKeywords     — exact hard-skill matches in both documents
#   missingKeywords   — up to 12 important JD keywords absent from the resume
#   contextualMatches — synonym pairs (e.g. resumeTerm: "Node" ↔ vacancyTerm: "Node.js")
#   macMessage        — the exact first Mac chat message (personalised, gap-aware)
#
# WHY generate macMessage on the backend?
#   If we build it client-side from foundKeywords + score, Mac always says the
#   same templated sentence.  Gemini generates a genuinely personalised opener
#   that references the candidate's specific role / strongest gaps.
#
# TEMPERATURE 0.0 — deterministic output so the JSON contract is reliable.
# ──────────────────────────────────────────────────────────────────────────────

# Concise system prompt — shorter = fewer input tokens = more output budget for JSON.
# The original ~900-token prompt was consuming budget needed for the JSON response,
# causing the macMessage string to truncate the output at ~97 chars.
_ANALYZE_SYSTEM = """\
You are an ATS analysis engine. Compare the resume against the job description.
Return ONLY a JSON object — no markdown, no code fences, no extra text.

JSON schema (all fields required):
{
  "score": <integer 0-100>,
  "foundKeywords": [<strings>],
  "missingKeywords": [<strings, max 12>],
  "contextualMatches": [{"resumeTerm": <string>, "vacancyTerm": <string>}],
  "macMessage": <string>
}

Field rules:
- score: percentage of important JD hard-skills covered by the resume. Integer 0-100.
- foundKeywords: technical skills/tools/frameworks present verbatim in BOTH documents. Exclude generic soft skills.
- missingKeywords: up to 12 JD keywords absent from the resume. Most impactful first. Empty list [] if none.
- contextualMatches: synonym pairs only (e.g. "Postgres" vs "PostgreSQL"). Empty list [] if none.
- macMessage: 2-3 sentences maximum.
  * score < 40 → blunt, urgent: "Your resume is currently invisible to ATS (X/100). We are missing critical keywords: [top 3]. Click the ghost words in the preview to start fixing this." Use exactly this structure.
  * score 40-69 → direct and action-oriented: cite exact score, name top 2-3 missing keywords, say we will fix them.
  * score 70-89 → encouraging but specific: cite exact score, name remaining 1-2 gaps, frame as "almost there".
  * score >= 90 OR missingKeywords is empty → congratulate, cite exact score as "X/100", pivot to polishing (stronger verbs, metrics, PDF). Do NOT mention gaps.
  * Never invent facts not in the documents. Never use generic openers like "Great news" or "Let me help".
"""


class ContextualMatch(BaseModel):
    """A synonym pair: the resume used `resumeTerm` where the JD said `vacancyTerm`."""
    resumeTerm:  str = Field(..., description="Term as it appeared in the resume")
    vacancyTerm: str = Field(..., description="Equivalent term as it appeared in the JD")


class AnalyzeRequest(BaseModel):
    """
    Payload for POST /api/analyze.

    Both fields must be plain text (already extracted by /api/upload-resume
    and /api/parse-job before this endpoint is called).
    """
    resume_text:     str = Field(..., min_length=10,  description="Plain text of the resume")
    job_description: str = Field(..., min_length=10,  description="Plain text of the job description")


class AnalyzeResponse(BaseModel):
    """
    The atomic ATS analysis contract — mirrors ATSAnalysisResponse in frontend/src/types/index.ts.

    This is the SINGLE source of truth for:
      • The ATS score ring (score)
      • The SkillGapChecklist chips (foundKeywords / missingKeywords)
      • Mac's first chat message (macMessage)
    """
    score:             int                  = Field(..., ge=0, le=100,      description="ATS keyword-coverage score 0–100")
    foundKeywords:     list[str]            = Field(default_factory=list,   description="Keywords present in both resume and JD")
    missingKeywords:   list[str]            = Field(default_factory=list,   description="Important JD keywords absent from resume (max 12)")
    contextualMatches: list[ContextualMatch] = Field(default_factory=list,  description="Synonym pairs found across both documents")
    macMessage:        str                  = Field(default="",             description="Personalised first message for the Mac chat agent")


def _extract_response_text(response: Any) -> str:
    """
    Safely extract the text content from a Gemini GenerateContentResponse.

    WHY this helper exists:
      `response.text` is a convenience accessor that raises `ValueError` when
      the response has more than one Part.  With gemini-2.5-flash in thinking
      mode, Gemini emits TWO parts: a 'thought' part followed by the actual
      text part.  Calling `response.text` on a two-part response raises:

        ValueError: The `response.text` quick accessor only works when the
        response contains a valid `Part`, but none were returned.

      This silently triggers the `except Exception` fallback and returns
      score=0 / empty arrays — the "brain-dead" response.

    FIX: iterate all parts, collect text parts, ignore thought parts.
    """
    try:
        # Fast path: single-part response (no thinking mode)
        return (response.text or "").strip()
    except ValueError:
        pass

    # Slow path: multi-part response (thinking mode active)
    # The actual answer is always in the last non-empty text part.
    try:
        parts = response.candidates[0].content.parts
        text_parts = [
            p.text for p in parts
            if hasattr(p, "text") and p.text and not getattr(p, "thought", False)
        ]
        if text_parts:
            return text_parts[-1].strip()
        # All parts were thought parts — fall back to the very last part
        return (parts[-1].text or "").strip()
    except (IndexError, AttributeError) as exc:
        raise RuntimeError(
            f"Could not extract text from Gemini response. "
            f"prompt_feedback={getattr(response, 'prompt_feedback', 'N/A')}"
        ) from exc


def _strip_fences(raw: str) -> str:
    """
    Remove markdown code fences that Gemini sometimes wraps around JSON.

    Handles both:
      ```json\\n{...}\\n```
      ```\\n{...}\\n```

    When response_mime_type='application/json' is set this should never be
    needed, but we keep it as a defensive second pass.
    """
    if "```" not in raw:
        return raw
    # Find the first opening fence and the last closing fence
    m = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', raw, re.DOTALL)
    if m:
        return m.group(1).strip()
    # Simpler split approach as a last resort
    parts = raw.split("```")
    for part in parts:
        part = part.strip()
        if part.startswith("json"):
            part = part[4:].strip()
        if part.startswith("{"):
            return part
    return raw


class _TruncatedResponseError(ValueError):
    """Raised when the LLM response is cut short and all JSON recovery attempts fail."""


def _recover_json(raw: str) -> dict:
    """
    Multi-strategy JSON extractor for potentially truncated LLM output.

    The response is truncated when Gemini hits max_output_tokens mid-JSON.
    Typical symptom: response ends inside the macMessage string value, e.g.:
      '{"score": 72, "foundKeywords": [...], "macMessage": "Your ATS score is 72'

    Strategies tried in order (first success wins):

      1. Direct parse          — ideal path, response_mime_type was honoured
      2. Regex first-{ last-}  — handles any preamble or postamble text
      3. Truncation repair     — append common JSON-closing sequences and retry
      4. Partial field harvest — regex-extract whatever fields ARE present;
                                 returns partial dict if score was at least found
      5. Raise _TruncatedResponseError — caller converts to HTTP 500
    """
    # ── Strategy 1: direct parse ──────────────────────────────────────────────
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # ── Strategy 2: regex brute force — first { to last } ────────────────────
    # Handles any prose before/after the JSON object.
    start = raw.find("{")
    end   = raw.rfind("}")
    candidate = raw[start : end + 1] if (start != -1 and end > start) else raw[start:] if start != -1 else raw

    if start != -1 and end > start:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # ── Strategy 3: truncation repair ─────────────────────────────────────────
    # The most common truncation point is mid-string inside macMessage.
    # We try appending progressively more closing structure.
    repair_suffixes = [
        '"}',                                    # close open string + object
        '"]}',                                   # close string + array + object
        '"}]}',                                  # close string + obj + arr + obj
        '", "macMessage": "Analysis complete."}',# replace truncated macMessage
    ]
    for suffix in repair_suffixes:
        try:
            return json.loads(candidate + suffix)
        except json.JSONDecodeError:
            continue

    # ── Strategy 4: partial field harvest ────────────────────────────────────
    # We couldn't reconstruct valid JSON — but we may still have enough data
    # to return a useful response.  Extract each field with targeted regex.
    partial: dict = {}

    score_m = re.search(r'"score"\s*:\s*(\d+)', raw)
    if score_m:
        partial["score"] = int(score_m.group(1))

    for field in ("foundKeywords", "missingKeywords"):
        arr_m = re.search(rf'"{field}"\s*:\s*(\[.*?\])', raw, re.DOTALL)
        if arr_m:
            try:
                partial[field] = json.loads(arr_m.group(1))
            except json.JSONDecodeError:
                # Array was itself truncated — extract the complete string items
                items = re.findall(r'"([^"\\]+)"', arr_m.group(1))
                if items:
                    partial[field] = items

    ctx_m = re.search(r'"contextualMatches"\s*:\s*(\[.*?\])', raw, re.DOTALL)
    if ctx_m:
        try:
            partial["contextualMatches"] = json.loads(ctx_m.group(1))
        except json.JSONDecodeError:
            partial["contextualMatches"] = []

    mac_m = re.search(r'"macMessage"\s*:\s*"((?:[^"\\]|\\.)*)', raw)
    if mac_m:
        # macMessage was truncated — use whatever we captured and close the sentence
        partial["macMessage"] = mac_m.group(1).rstrip(" ,") + "."

    if "score" in partial:
        # Enough to return a real response — fill missing fields with safe defaults
        partial.setdefault("foundKeywords", [])
        partial.setdefault("missingKeywords", [])
        partial.setdefault("contextualMatches", [])
        partial.setdefault("macMessage", "")
        print(f"DEBUG /api/analyze: _recover_json — partial harvest succeeded, fields={list(partial.keys())}")
        return partial

    # ── Strategy 5: total failure ─────────────────────────────────────────────
    raise _TruncatedResponseError(
        f"LLM Response Truncated — all JSON recovery strategies failed.  "
        f"raw_len={len(raw)}  raw={raw[:200]!r}"
    )


# ─── Model priority list for /api/analyze ─────────────────────────────────────
#
# WHY a priority list instead of a single model string?
#
#   google-generativeai==0.8.x uses the v1beta API endpoint by default.
#   In v1beta the bare alias "gemini-1.5-flash" has NO registered route → 404.
#   The valid identifiers are the versioned / -latest aliases only:
#
#     ✓  gemini-1.5-flash-latest   — GA stable, always available, no thinking mode
#     ✓  gemini-1.5-flash-001      — pinned GA version
#     ✓  gemini-1.5-flash-002      — pinned GA version
#     ✗  gemini-1.5-flash          — NOT a valid v1beta alias → 404
#
#   "gemini-2.5-flash" works in v1beta only because it's registered as an
#   experimental name there.  But it fights its thinking budget against
#   max_output_tokens, causing the 97-char truncation we observed.
#
# PRIORITY ORDER:
#   1. gemini-1.5-flash-latest   — fast, stable, JSON-reliable, no thinking mode
#   2. gemini-1.5-pro-latest     — slower but always available as a fallback
#   3. gemini-2.5-flash          — last resort: works but has token-budget issues
#
_ANALYZE_MODEL_PRIORITY: list[str] = [
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro-latest",
    "gemini-2.5-flash",
]


async def _generate_with_model_fallback(
    model_priority: list[str],
    system_instruction: str,
    generation_config: "genai.types.GenerationConfig",
    safety_settings: dict,
    prompt: str,
) -> tuple[str, Any]:
    """
    Try each model in `model_priority` until one succeeds.

    Returns (model_name_used, response).

    Only catches 404 / model-not-found errors and advances to the next
    model in the list.  Any other error (auth failure, rate limit, network
    error) is re-raised immediately so it surfaces as a real failure.

    This lets us survive API surface changes (model aliases appearing /
    disappearing in v1beta) without a code deployment.
    """
    last_exc: Exception | None = None

    for model_name in model_priority:
        print(f"DEBUG /api/analyze: trying model={model_name!r}")
        try:
            model = genai.GenerativeModel(
                model_name=model_name,
                system_instruction=system_instruction,
                generation_config=generation_config,
                safety_settings=safety_settings,
            )
            response = await model.generate_content_async(prompt)
            print(f"DEBUG /api/analyze: model={model_name!r} succeeded ✓")
            return model_name, response

        except Exception as exc:  # noqa: BLE001
            err_str = str(exc).lower()
            # Detect 404 / model-not-found errors from the Gemini API.
            # The SDK surfaces these as google.api_core.exceptions.NotFound
            # whose str() contains "404" and/or "not found".
            is_not_found = (
                "404" in err_str
                or "not found" in err_str
                or "not_found" in err_str
                or type(exc).__name__ in ("NotFound", "HttpError")
            )
            if is_not_found:
                print(
                    f"DEBUG /api/analyze: model={model_name!r} → 404/not-found, "
                    f"trying next model in priority list"
                )
                last_exc = exc
                continue
            # Non-404 — propagate immediately (auth errors, rate limits, etc.)
            raise

    # Every model in the list returned 404
    raise _TruncatedResponseError(
        f"All models returned 404/not-found: {model_priority}.  "
        f"last_error={last_exc}"
    )


@router.post(
    "/analyze",
    response_model=AnalyzeResponse,
    summary="Full ATS analysis — score + keyword gaps + Mac's first message",
    description="""
Runs a single atomic Gemini analysis that produces everything the workspace
needs to initialise:

- **score** (0–100): keyword-coverage ATS match percentage
- **foundKeywords**: hard-skill matches present in both documents
- **missingKeywords**: up to 12 impactful JD keywords absent from the resume
- **contextualMatches**: synonym pairs (e.g. "Node" ↔ "Node.js")
- **macMessage**: the exact first message the Mac chat agent should say

**Fail-safe**: on any Gemini error returns score=0, empty lists, and a
generic `macMessage` so the workspace can still open without crashing.
    """,
)
async def analyze(
    body:     AnalyzeRequest,
    settings: Settings = Depends(get_settings),
) -> AnalyzeResponse:
    """
    POST /api/analyze — Atomic onboarding → workspace handoff.

    Model strategy: _ANALYZE_MODEL_PRIORITY list with automatic fallback.
      Primary:   gemini-1.5-flash-latest  (GA alias, valid in v1beta, no thinking mode)
      Fallback1: gemini-1.5-pro-latest    (always available, slightly slower)
      Fallback2: gemini-2.5-flash         (last resort — works but token-budget issues)

    Previous bug: "gemini-1.5-flash" (bare alias) → 404 in v1beta API.
    """
    genai.configure(api_key=settings.gemini_api_key)

    # ── DEBUG: log inputs immediately ────────────────────────────────────────
    print(f"DEBUG /api/analyze: resume_text length={len(body.resume_text)}")
    print(f"DEBUG /api/analyze: job_description length={len(body.job_description)}")
    print(f"DEBUG /api/analyze: resume_text[:120]={body.resume_text[:120]!r}")

    resume_snip = body.resume_text[:4_000]
    jd_snip     = body.job_description[:3_000]

    generation_config = genai.types.GenerationConfig(
        temperature=0.0,
        top_p=1.0,
        max_output_tokens=2_048,          # 2048 > previous 1024 that caused 97-char cutoff
        response_mime_type="application/json",
    )
    safety_settings = {
        HarmCategory.HARM_CATEGORY_HARASSMENT:        HarmBlockThreshold.BLOCK_ONLY_HIGH,
        HarmCategory.HARM_CATEGORY_HATE_SPEECH:       HarmBlockThreshold.BLOCK_ONLY_HIGH,
        HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
    }

    # Concise prompt — all semantic signal, minimum token overhead.
    prompt = (
        f"RESUME:\n{resume_snip}\n\n"
        f"JOB DESCRIPTION:\n{jd_snip}\n\n"
        "Return ONLY JSON. Fields: score (int), foundKeywords (list), "
        "missingKeywords (list), contextualMatches (list), macMessage (str)."
    )

    try:
        model_used, response = await _generate_with_model_fallback(
            model_priority=_ANALYZE_MODEL_PRIORITY,
            system_instruction=_ANALYZE_SYSTEM,
            generation_config=generation_config,
            safety_settings=safety_settings,
            prompt=prompt,
        )
        raw = _extract_response_text(response)

        print(f"DEBUG /api/analyze: raw LLM response ({len(raw)} chars) = {raw[:500]!r}")

        if not raw:
            finish = "UNKNOWN"
            if response.candidates:
                finish = str(getattr(response.candidates[0], "finish_reason", "UNKNOWN"))
            raise _TruncatedResponseError(
                f"LLM Response Truncated — Gemini returned empty text.  "
                f"finish_reason={finish}  "
                f"prompt_feedback={getattr(response, 'prompt_feedback', 'N/A')}"
            )

        # ── Strip fences (defensive — should not fire with response_mime_type) ──
        raw = _strip_fences(raw)

        # ── Parse with multi-strategy recovery ───────────────────────────────
        # _recover_json raises _TruncatedResponseError only after all four
        # recovery strategies fail — that surfaces as HTTP 500 below.
        result = _recover_json(raw)

        print(f"DEBUG /api/analyze: parsed result keys={list(result.keys())}  score={result.get('score')!r}")

        # ── Safety cap ────────────────────────────────────────────────────────
        raw_score = result.get("score")
        if not isinstance(raw_score, (int, float)):
            print(f"DEBUG /api/analyze: score field is not numeric — got {raw_score!r}")
            raise _TruncatedResponseError(
                f"LLM Response Truncated — 'score' field missing or non-numeric: {raw_score!r}.  "
                f"raw={raw[:200]!r}"
            )

        score = max(0, min(100, int(raw_score)))

        found_kw   = [str(k) for k in result.get("foundKeywords",   []) if k][:30]
        missing_kw = [str(k) for k in result.get("missingKeywords", []) if k][:12]

        raw_matches = result.get("contextualMatches", [])
        ctx_matches: list[ContextualMatch] = []
        for item in raw_matches:
            if isinstance(item, dict) and item.get("resumeTerm") and item.get("vacancyTerm"):
                ctx_matches.append(ContextualMatch(
                    resumeTerm=str(item["resumeTerm"]),
                    vacancyTerm=str(item["vacancyTerm"]),
                ))

        mac_msg = str(result.get("macMessage", "")).strip()
        if not mac_msg:
            top_gaps = ", ".join(missing_kw[:3]) if missing_kw else "a few key skills"
            is_polishing = score >= 90 or len(missing_kw) == 0
            if is_polishing:
                # 90–100 or perfect match
                mac_msg = (
                    f"Your resume is already a strong match at {score}/100 — "
                    "you have the core keywords covered.  "
                    "Now let's sharpen the achievement metrics and action verbs to make it outstanding."
                )
            elif score < 40:
                # Danger zone — blunt, urgent
                mac_msg = (
                    f"Your resume is currently invisible to ATS ({score}/100).  "
                    f"We are missing critical keywords: {top_gaps}.  "
                    "Click the ghost words in the preview to start fixing this."
                )
            elif score < 70:
                # Improvement zone — direct and action-oriented
                mac_msg = (
                    f"Your ATS score is {score}/100 — {top_gaps} "
                    "are the main gaps between you and the shortlist.  "
                    "Let's work those in and I'll show you exactly where each one fits."
                )
            else:
                # Strong zone (70–89) — encouraging but specific
                mac_msg = (
                    f"Strong resume at {score}/100 — almost there.  "
                    f"Adding {top_gaps} would push you past the shortlist threshold.  "
                    "Click any ghost keyword to get a tailored bullet suggestion."
                )

        strategy = (
            "polishing"     if (score >= 90 or len(missing_kw) == 0) else
            "danger"        if score < 40 else
            "improvement"   if score < 70 else
            "strong"
        )
        logger.info(
            "Analyze ✅ — model=%s  score=%d  found=%d  missing=%d  ctx=%d  strategy=%s",
            model_used, score, len(found_kw), len(missing_kw), len(ctx_matches), strategy,
        )

        return AnalyzeResponse(
            score=score,
            foundKeywords=found_kw,
            missingKeywords=missing_kw,
            contextualMatches=ctx_matches,
            macMessage=mac_msg,
        )

    except _TruncatedResponseError as exc:
        # ── Surface truncation as HTTP 500 — visible in the UI ───────────────
        # Per spec: do NOT silently return score=0.  The user must see the error
        # so we can diagnose it, not mistake it for a genuine "no match".
        logger.error(
            "Analyze TRUNCATED — %s  (resume_len=%d  jd_len=%d)",
            exc, len(body.resume_text), len(body.job_description),
        )
        print(f"ERROR /api/analyze TRUNCATED: {exc}")
        from fastapi import HTTPException
        raise HTTPException(
            status_code=500,
            detail=f"LLM Response Truncated — the analysis model returned incomplete JSON. "
                   f"Please retry. (debug: {str(exc)[:200]})",
        )

    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Analyze endpoint FAILED — %s: %s  (resume_len=%d  jd_len=%d)",
            type(exc).__name__, exc,
            len(body.resume_text), len(body.job_description),
        )
        print(f"ERROR /api/analyze: {type(exc).__name__}: {exc}")
        from fastapi import HTTPException
        raise HTTPException(
            status_code=500,
            detail=f"Analysis failed: {type(exc).__name__}: {exc!s}",
        )
