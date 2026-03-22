"""
backend/routers/polish.py — Final Polish Endpoint
─────────────────────────────────────────────────────────────────────────────
POST /api/resume/final-polish

A single-pass Gemini rewrite agent that acts as a strict Canadian HR Director.
It receives the full structured resume as JSON, polishes every text field in
place (preserving all keys and IDs), and returns the improved version.

WHAT "POLISH" MEANS HERE:
  • Weak verbs replaced with strong Canadian HR action verbs
  • Bullet points restructured for maximum ATS signal and recruiter impact
  • Missing metrics surfaced as explicit placeholders ("[X]%", "[N] people")
  • Summary generated or strengthened, tailored to the optional job_context
  • Repetitive filler removed; tone: corporate, humble-confident

WHY TEMPERATURE 0.3?
  The agent must be creative enough to genuinely improve language — temperature
  0.0 produces bland paraphrasing.  But above ~0.4 Gemini starts hallucinating
  facts (inventing company names, made-up metrics).  0.3 is the empirically
  reliable sweet spot for professional rewriting tasks.

FAIL-SAFE CONTRACT:
  If Gemini returns invalid JSON, or the parsed result is missing required keys,
  the endpoint raises HTTP 422 with a structured error payload rather than
  returning a silently broken response.  The frontend must never receive partial
  data that overwrites valid resume state.

STRUCTURE INTEGRITY:
  All experience `id` and education `id` fields are echoed back unchanged.
  The frontend relies on these for React list reconciliation — mutating them
  would cause duplicate-key bugs in the diff overlay.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import google.generativeai as genai
from fastapi import APIRouter, Depends, HTTPException, status
from google.generativeai.types import HarmBlockThreshold, HarmCategory
from pydantic import BaseModel, Field

from ..config import Settings, get_settings

logger = logging.getLogger("jobifai.polish")

# ─── Router ───────────────────────────────────────────────────────────────────
router = APIRouter(
    prefix="/api/resume",
    tags=["polish"],
)


# ─── Pydantic Mirror of frontend ResumeData ───────────────────────────────────
# These models MUST stay in sync with frontend/src/types/index.ts.
# Only text fields that the agent should touch are required; `id` fields are
# pass-through (preserved unchanged so frontend list keys stay stable).

class ExperienceEntry(BaseModel):
    """
    Mirrors frontend ExperienceEntry.
    The agent rewrites `responsibilities` and `metrics` strings.
    `id`, `company`, `startDate`, `endDate` are echoed back unchanged.
    """
    id:               str              = Field(..., description="Stable UUID — never mutated by the agent")
    company:          str              = Field(..., description="Employer name — never mutated")
    title:            str              = Field(..., description="Job title — never mutated")
    startDate:        str              = Field(..., description="ISO month e.g. '2021-03'")
    endDate:          str | None       = Field(None, description="ISO month or null for 'Present'")
    responsibilities: list[str]        = Field(default_factory=list, description="Action-verb bullet points")
    metrics:          list[str]        = Field(default_factory=list, description="Quantified wins")


class EducationEntry(BaseModel):
    """
    Mirrors frontend EducationEntry.
    The agent may lightly strengthen `degree` / `field` phrasing but must not
    alter `institution`, `graduationYear`, or `id`.
    """
    id:             str        = Field(..., description="Stable UUID — never mutated")
    institution:    str        = Field(..., description="School name — never mutated")
    degree:         str        = Field(..., description="e.g. 'Bachelor of Applied Science'")
    field:          str        = Field(..., description="e.g. 'Software Engineering'")
    graduationYear: str        = Field(..., description="e.g. '2019'")
    honours:        str | None = Field(None, description="e.g. 'Dean's List'")


class ResumeData(BaseModel):
    """
    Mirrors frontend ResumeData — the complete structured resume payload.
    All fields except `id` strings are candidates for agent rewriting.
    """
    targetTitle:  str                  = Field(...,                   description="Desired job title")
    summary:      str                  = Field(default="",            description="Professional summary / profile")
    experiences:  list[ExperienceEntry] = Field(default_factory=list, description="Work history entries")
    skills:       list[str]            = Field(default_factory=list,  description="Technical and soft skills list")
    education:    list[EducationEntry] = Field(default_factory=list,  description="Education history entries")


class PolishRequest(BaseModel):
    """
    Input contract for POST /api/resume/final-polish.

    resume_data:  The full current resume state (mirrors Zustand's resumeData).
    job_context:  Optional job description text.  When supplied, the agent
                  tailors the generated summary and keyword choices to this
                  specific role.  Pass the full JD text for best results.
    """
    resume_data:  ResumeData = Field(...,      description="Current resume state to polish")
    job_context:  str        = Field(default="", max_length=4000,
                                     description="Optional target JD for summary tailoring")


class PolishResponse(BaseModel):
    """
    Output contract — the same ResumeData shape, fully polished.
    The frontend applies this as a diff proposal before committing to the store.
    """
    polished: ResumeData = Field(..., description="The polished resume data")


# ─── System Prompt ────────────────────────────────────────────────────────────
# Density matters here: Gemini at temperature 0.3 tends to hedge if the prompt
# is vague.  Every rule has a concrete example so the model has zero ambiguity.
_POLISH_SYSTEM = """\
You are a strict Canadian HR Director with 20 years of experience reviewing
thousands of resumes for Fortune 500 companies and Big-4 consulting firms.
Your mandate: transform a draft resume into a market-ready document that
passes ATS filters AND impresses a senior recruiter in under 7 seconds.

You will receive a JSON object representing a resume.  Your ONLY job is to
rewrite the text VALUES inside that object and return the result as valid JSON
with the EXACT same structure and keys.  Never add, rename, or remove keys.
Never change `id`, `company`, `institution`, `graduationYear`, `startDate`, or
`endDate` fields — those are system identifiers and immutable data.

══ RULE 1 — ACTION VERBS ════════════════════════════════════════════════════
Every bullet in `responsibilities` and `metrics` MUST begin with a strong past-
tense action verb.

BANNED VERBS (replace immediately):
  helped, worked on, assisted with, was responsible for, did, made, got,
  used, utilized, tried to, was part of, participated in, supported

APPROVED CANADIAN HR ACTION VERBS (use these — context-dependent):
  Spearheaded   Orchestrated   Engineered    Architected   Championed
  Optimised     Streamlined    Accelerated   Transformed   Pioneered
  Delivered     Executed       Facilitated   Negotiated    Consolidated
  Launched      Automated      Established   Revitalised   Exceeded
  Reduced       Increased      Generated     Managed       Mentored
  Led           Trained        Designed      Deployed      Integrated

If none of the above fit, use any strong transitive verb that is specific,
measurable, and free of corporate filler.

══ RULE 2 — QUANTIFICATION ══════════════════════════════════════════════════
Every bullet that describes scope, volume, outcome, or improvement MUST contain
a number.  If the original has no number and the context strongly implies one,
INSERT a placeholder in square brackets: [X]%, [N] people, [C] customers/day,
[$X] revenue impact.

EXAMPLES:
  BEFORE: "Helped onboard new employees"
  AFTER:  "Onboarded and mentored [N] new employees, reducing time-to-productivity by [X]%"

  BEFORE: "Worked on improving customer satisfaction"
  AFTER:  "Increased customer satisfaction scores by [X]% through proactive resolution of escalated complaints"

Only insert ONE placeholder per bullet — avoid stacking "[X]%, [N] people,
[$X] revenue" in a single line (it becomes unreadable).

══ RULE 3 — PROFESSIONAL SUMMARY ════════════════════════════════════════════
The `summary` field MUST be a polished 3-sentence professional profile.

Structure (follow this order — do not deviate):
  Sentence 1 — Identity + years of experience + area of expertise:
    "Results-driven [Title] with [X]+ years of experience in [domain],
     specialising in [key skill or tool relevant to job_context]."
  Sentence 2 — Strongest career proof point (one quantified achievement):
    "Demonstrated track record of [strong past-tense verb] [outcome],
     including [specific achievement from the resume]."
  Sentence 3 — Value proposition for the target role:
    "Seeking to leverage expertise in [2–3 skills] to [impact statement
     aligned with job_context if provided, otherwise keep generic]."

If the existing summary is already strong (3 sentences, has a number, action
verbs present), improve it minimally — do NOT rewrite for the sake of rewriting.

If no summary exists (empty string ""), generate one from the resume content.

══ RULE 4 — NO FLUFF ════════════════════════════════════════════════════════
DELETE or replace these phrases wherever they appear:
  "responsible for"     → rewrite as an action-verb sentence
  "various tasks"       → name the specific tasks
  "team player"         → delete entirely (implied)
  "fast learner"        → delete entirely (implied)
  "go-getter"           → delete entirely
  "results-oriented"    → only acceptable in the summary, once
  "dynamic"             → delete entirely
  "passionate about"    → delete entirely
  "excellent communication skills" → delete or rephrase as a concrete example

══ RULE 5 — SKILLS LIST ═════════════════════════════════════════════════════
Normalise the `skills` array:
  • Each entry = one concise term (max 3 words).
  • No duplicate entries (case-insensitive).
  • Expand common abbreviations that ATS scanners need: "JS" → "JavaScript",
    "TS" → "TypeScript", "ML" → "Machine Learning", "DB" → "Database".
  • Remove duplicates caused by expansion (e.g. if both "JS" and "JavaScript"
    exist, keep only "JavaScript").
  • Do NOT add skills that are not present anywhere in the resume data.

══ RULE 6 — STRUCTURE INTEGRITY ═════════════════════════════════════════════
  ✓ Return valid JSON — no markdown, no code fences, no extra text.
  ✓ The top-level key is "polished" and its value is the full ResumeData object.
  ✓ Every `id` field must be echoed back VERBATIM — character-for-character.
  ✓ Every `company`, `institution`, `startDate`, `endDate`, `graduationYear`
    must be echoed back VERBATIM.
  ✓ `targetTitle` should be capitalised correctly (Title Case) but otherwise
    unchanged (do NOT creatively rename the role).
  ✗ Do NOT add new experience or education entries.
  ✗ Do NOT invent certifications, awards, or facts not present in the input.

══ OUTPUT FORMAT ═════════════════════════════════════════════════════════════
Respond with ONLY this JSON — no preamble, no explanation, no code fences:
{
  "polished": {
    "targetTitle": "...",
    "summary":     "...",
    "experiences": [ { ...same keys, polished values... } ],
    "skills":      [ "..." ],
    "education":   [ { ...same keys, polished values... } ]
  }
}
"""


# ─── Endpoint ──────────────────────────────────────────────────────────────────

@router.post(
    "/final-polish",
    response_model=PolishResponse,
    summary="Final Polish — one-pass HR-Director rewrite of the full resume",
    description="""
Passes the entire structured resume through a strict Canadian HR Director agent
that enforces:

- **Strong action verbs** — every bullet starts with Spearheaded/Optimised/etc.
- **Quantification** — missing metrics become `[X]%` / `[N] people` placeholders
- **Professional summary** — generated or strengthened to a tight 3-sentence profile
- **No-fluff sweep** — filler phrases deleted, duplicates removed from skills list
- **Structure integrity** — all `id`, `company`, `startDate`, `endDate` keys
  echoed back unchanged so React list keys stay stable

The optional `job_context` field (JD text) allows the agent to tailor the
summary and keyword emphasis to the specific target role.

**Error handling**: if Gemini returns malformed JSON or is missing required
fields, the endpoint returns HTTP 422 with `{"detail": "Polish failed — ..."}`.
The frontend should display this error rather than overwriting the live resume.
    """,
)
async def final_polish(
    body:     PolishRequest,
    settings: Settings = Depends(get_settings),
) -> PolishResponse:
    """
    POST /api/resume/final-polish

    Single-pass rewrite of the full resume.  Called when the user clicks
    "✨ Final Polish" in the workspace.  Returns the polished resume in the
    same shape as the input — the frontend diff overlay presents the changes
    before the user commits them to the Zustand store.
    """
    genai.configure(api_key=settings.gemini_api_key)

    model = genai.GenerativeModel(
        model_name="gemini-2.5-flash",
        system_instruction=_POLISH_SYSTEM,
        generation_config=genai.types.GenerationConfig(
            temperature=0.3,        # creative enough to improve language; low enough to stay factual
            top_p=0.95,
            max_output_tokens=4096, # full resume JSON may be ~2000 tokens; headroom for complex entries
        ),
        safety_settings={
            HarmCategory.HARM_CATEGORY_HARASSMENT:        HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_HATE_SPEECH:       HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
    )

    # ── Build the prompt ──────────────────────────────────────────────────────
    # Serialise the resume as compact JSON so the model sees the exact structure.
    # We intentionally exclude defaults (empty lists / null) to keep the prompt
    # short and focused on what actually needs polishing.
    resume_json = body.resume_data.model_dump_json(exclude_none=True, indent=2)

    jd_block = ""
    if body.job_context.strip():
        # Trim the JD to 2000 chars to avoid exceeding reasonable context limits
        jd_block = (
            f"\n\nTARGET JOB DESCRIPTION (use to tailor the summary and skills):\n"
            f"{body.job_context.strip()[:2000]}"
        )

    prompt = (
        f"RESUME TO POLISH:\n{resume_json}"
        f"{jd_block}\n\n"
        "Apply all six rules from your instructions and return ONLY the JSON."
    )

    # ── Call Gemini ───────────────────────────────────────────────────────────
    try:
        response = await model.generate_content_async(prompt)
        raw = (response.text or "").strip()
    except Exception as exc:
        logger.error("Polish — Gemini call failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Polish failed — AI service unavailable: {type(exc).__name__}",
        ) from exc

    # ── Parse the JSON response ───────────────────────────────────────────────
    # Gemini occasionally wraps output in markdown fences despite instructions.
    # We strip them defensively rather than treating it as an error.
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    # Regex fallback: if there's any surrounding prose, extract the JSON object.
    match = re.search(r'\{.*\}', raw, re.DOTALL)
    if not match:
        logger.error("Polish — no JSON object found in Gemini response. raw=%r", raw[:200])
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Polish failed — AI returned an unexpected format. Please try again.",
        )

    raw_json = match.group(0)

    # ── Validate the parsed payload ───────────────────────────────────────────
    # We validate in two layers:
    #   1. json.loads() — syntactic validity (well-formed JSON)
    #   2. Pydantic model_validate() — structural contract (required keys present,
    #      types correct)
    # Both layers raise different exceptions, caught separately for precise errors.
    try:
        parsed: dict[str, Any] = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        logger.error(
            "Polish — JSON decode error at char %d: %s  raw=%r",
            exc.pos, exc.msg, raw_json[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Polish failed — AI returned malformed JSON (offset {exc.pos}). Please try again.",
        ) from exc

    # The agent must return `{ "polished": { ...ResumeData... } }`
    if "polished" not in parsed:
        logger.error("Polish — response missing 'polished' key. keys=%s", list(parsed.keys()))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Polish failed — AI response is missing the 'polished' key. Please try again.",
        )

    try:
        polished_data = ResumeData.model_validate(parsed["polished"])
    except Exception as exc:
        logger.error("Polish — Pydantic validation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Polish failed — AI returned an invalid resume structure: {exc}",
        ) from exc

    # ── Structure integrity check ─────────────────────────────────────────────
    # Verify that the agent didn't mutate any immutable ID fields.
    # If it did, we reject the entire response to prevent data corruption.
    original_exp_ids = {e.id for e in body.resume_data.experiences}
    returned_exp_ids = {e.id for e in polished_data.experiences}
    if original_exp_ids != returned_exp_ids:
        logger.error(
            "Polish — experience id mismatch! original=%s returned=%s",
            original_exp_ids, returned_exp_ids,
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Polish failed — AI mutated experience record IDs. Please try again.",
        )

    original_edu_ids = {e.id for e in body.resume_data.education}
    returned_edu_ids = {e.id for e in polished_data.education}
    if original_edu_ids != returned_edu_ids:
        logger.error(
            "Polish — education id mismatch! original=%s returned=%s",
            original_edu_ids, returned_edu_ids,
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Polish failed — AI mutated education record IDs. Please try again.",
        )

    logger.info(
        "Polish — success  title=%r  exp=%d  skills=%d→%d  summary_len=%d",
        polished_data.targetTitle,
        len(polished_data.experiences),
        len(body.resume_data.skills),
        len(polished_data.skills),
        len(polished_data.summary),
    )

    return PolishResponse(polished=polished_data)
