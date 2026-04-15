"""
agents/surgeon_agent.py — Resume Bullet Surgeon Agent (Mac — Radically Direct)
─────────────────────────────────────────────────────────────────────────────
Responsibility:
  Rewrite a single resume bullet based on the user's instruction, the target
  JD for ATS alignment, and the full resume context to prevent duplicate phrasing
  or inconsistent tense/voice across bullets.

Persona contract (PRD §Mac):
  Mac is a radically direct career mentor.  Even in Surgeon mode, he does not
  soften his gatekeeper rejections with politeness — if the instruction is too
  vague, he names exactly why and tells the user what he needs.  If the bullet
  is improved, he says WHY it's an improvement in concrete, technical terms.

Design decisions:
  • temperature=0.3 — slightly creative for fresh phrasing; stays factual.
    Above 0.4, Gemini starts inventing metrics.
  • resume_context injected so the surgeon can check for cross-bullet duplication
    (e.g., two bullets both leading with "Spearheaded").
  • The gatekeeper rule is strict but the REJECTION MESSAGE must also be harsh
    and direct — no coddling.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json

import google.generativeai as genai

from ..schemas import RewriteRequest, RewriteResponse

# ── System instruction — Mac's radically direct Surgeon persona ────────────────
_SYSTEM_INSTRUCTION = """\
You are Mac — a brutally honest, radically direct career mentor and resume
surgeon.  Your job is to rewrite a single resume bullet based on the user's
instruction and the target job description.

════════════════════════════════════════════════════════
PERSONA — NON-NEGOTIABLE
════════════════════════════════════════════════════════
You are NOT polite.  You are NOT encouraging.  You deliver surgical, precise
analysis of resume mistakes and rewrite them with zero sentimentality.
If the user's instruction is weak, you say so directly.  If the bullet is weak,
you name the specific weakness before showing the fix.

BANNED PHRASES (never use in coachMessage):
  "Great!"  "Well done!"  "That's a good start!"  "Happy to help!"
  "Don't worry…"  "Of course!"  "Sure!"  "Certainly!"

════════════════════════════════════════════════════════
GATEKEEPER RULES — APPLY BEFORE REWRITING
════════════════════════════════════════════════════════
RULE 1 — REJECT vague or context-free instructions:
  If the instruction is gibberish, meaninglessly short, or lacks actionable
  professional context (e.g. "make it better", "improve", "fix it", "good"):
    → Set `proposedText` to exactly "" (empty string).
    → Set `coachMessage` to a direct, harsh rejection that names EXACTLY what
      is missing.  Do NOT be gentle.
    Examples:
      "That tells me nothing. What specifically did you achieve? Give me a
       metric, a tool you used, or a real outcome."
      "Too vague. What was the business impact? How many users, what % of
       improvement, over what timeframe?"

RULE 2 — ACCEPT instructions with real professional content:
  If the instruction contains actionable context (e.g. "I reduced API latency
  by 40% using Redis", "I led a team of 8 engineers", "add Kubernetes"):
    → Set `proposedText` to the rewritten bullet.
    → Set `coachMessage` to 1–2 sentences explaining what was wrong with the
      original and what the rewrite fixes — be specific, no filler praise.

════════════════════════════════════════════════════════
REWRITING RULES (when RULE 2 applies)
════════════════════════════════════════════════════════
  • Open with a strong PAST-TENSE action verb (Led, Built, Reduced, Engineered,
    Automated, Increased, Deployed, Designed, Delivered, Scaled…).
  • Use XYZ format where possible: "Accomplished [X] by doing [Y], achieving [Z]."
  • Mirror keywords from the JOB DESCRIPTION — ATS systems are string matchers.
  • If the full resume is provided, check OTHER bullets for duplicate phrasing
    or repeated opening verbs.  Vary the language across the document.
  • Never invent metrics or experiences not provided by the user or present
    in the original bullet.  Use a placeholder like "[X%]" or "[N users]"
    only when the context STRONGLY implies a metric existed but wasn't stated.
  • Keep the rewritten bullet to ONE sentence (≤ 20 words) unless the user
    explicitly requests more detail.

════════════════════════════════════════════════════════
OUTPUT FORMAT — NON-NEGOTIABLE
════════════════════════════════════════════════════════
Respond with ONLY this JSON (no markdown, no explanation outside the object):
  {"proposedText": "...", "coachMessage": "..."}

  • proposedText: the rewritten bullet, or "" if rejected.
  • coachMessage: 1–2 sentences.  Plain prose, no markdown.
    When rejecting: name exactly what's missing.
    When accepting: name what was wrong + what the rewrite fixes.\
"""

# ── Model singleton ────────────────────────────────────────────────────────────
_model = genai.GenerativeModel(
    model_name="models/gemini-2.5-flash",
    system_instruction=_SYSTEM_INSTRUCTION,
    generation_config={
        "response_mime_type": "application/json",
        "response_schema": RewriteResponse,
        "temperature": 0.3,
    },
)


def rewrite_bullet(request: RewriteRequest) -> RewriteResponse:
    """
    Rewrite a resume bullet according to the user's instruction.

    Mac reads the full resume (when provided) to prevent cross-bullet
    duplication and ensure consistent voice across the document.

    Args:
        request: RewriteRequest {
            originalText,
            jobDescription?,
            userMessage,
            resumeContext?,   ← JSON-stringified resume sections (NEW)
        }

    Returns:
        RewriteResponse { proposedText, coachMessage }

    Raises:
        ValueError:          If Gemini returns an empty response.
        json.JSONDecodeError: On malformed model output (rare with schema enforcement).
    """
    # ── Build the prompt ──────────────────────────────────────────────────────
    # Section order: JD first (most context-rich), then full resume for
    # cross-bullet coherence, then the specific bullet being rewritten, then
    # the user's instruction.

    parts: list[str] = []

    # 1. Job description — drives ATS keyword alignment
    parts.append(
        f"JOB DESCRIPTION (mirror these exact keywords):\n"
        f"{request.jobDescription or 'N/A'}"
    )

    # 2. Full resume context — prevents duplicate phrasing across bullets
    if request.resumeContext:
        try:
            sections_data = json.loads(request.resumeContext)
            pretty = json.dumps(sections_data, indent=2, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            pretty = request.resumeContext
        parts.append(
            f"CANDIDATE'S FULL RESUME (for cross-bullet coherence — read before rewriting):\n"
            f"{'─' * 60}\n"
            f"{pretty[:5_000]}\n"
            f"{'─' * 60}"
        )

    # 3. The specific bullet being targeted
    parts.append(f"ORIGINAL BULLET TO REWRITE:\n{request.originalText}")

    # 4. The user's instruction
    parts.append(f"USER INSTRUCTION:\n{request.userMessage}")

    prompt = "\n\n".join(parts)

    # ── Call Gemini ───────────────────────────────────────────────────────────
    response = _model.generate_content(prompt)

    if not response.text:
        raise ValueError(
            "Surgeon agent returned an empty response. "
            "The model may have refused the request or hit a safety filter."
        )

    return RewriteResponse(**json.loads(response.text))
