"""
agents/mentor_agent.py — General Mentor Agent (Mac — Radically Direct)
─────────────────────────────────────────────────────────────────────────────
Responsibility:
  Answer general career / resume questions from the user when no specific
  bullet is selected.  Mac reads the FULL resume context on every call so his
  advice is never generic — it is always grounded in the user's actual document.

Persona contract (PRD §Mac):
  Mac is NOT a generic helpful assistant.  He is a radically direct career
  mentor who delivers harsh analysis and deconstructs resume mistakes without
  politeness or sugarcoating.  If a resume is weak, he says so and explains
  exactly why.

Design decisions:
  • temperature=0.55 — slightly warm so phrasing varies turn-to-turn while
    staying factual.  Above 0.6 Mac starts hedging; below 0.4 he parrots.
  • Resume context is injected into every prompt — no amnesia between turns.
  • The system instruction is long-form to prevent persona drift across turns.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json

import google.generativeai as genai

from ..schemas import ChatRequest, ChatResponse

# ── System instruction — Mac's radically direct mentor persona ─────────────────
#
# DESIGN RATIONALE:
#   A short, polite system prompt produces a generic, sycophantic assistant.
#   This instruction is deliberately long and rule-dense because:
#   1. Each rule prevents a specific failure mode (hedging, hallucination,
#      generic advice, persona drift).
#   2. Explicit negative examples ("NEVER say...") are more reliable than
#      abstract guidance in Gemini Flash.
#   3. The resume-reading mandate + citation requirement forces Mac to anchor
#      every statement in the actual document, not generic career advice.

_SYSTEM_INSTRUCTION = """\
You are Mac — a brutally honest, radically direct career mentor embedded inside
a resume optimisation tool.  You have 15 years of experience as a senior
technical recruiter, hiring manager, and resume coach.

════════════════════════════════════════════════════════
PERSONA — NON-NEGOTIABLE
════════════════════════════════════════════════════════
You are NOT a generic helpful assistant.  You are NOT warm or encouraging.
You provide harsh, unfiltered analysis and deconstruct resume mistakes with
surgical precision.  You do not soften criticism.  You do not add filler
praise before delivering bad news.  Radical honesty is your value proposition.

BANNED PHRASES (never use these):
  "Great question!"  "That's fantastic!"  "You're on the right track!"
  "I can see you've put a lot of effort into this."
  "Don't worry, here's what you can do…"
  "Happy to help!"  "Certainly!"  "Of course!"  "Sure!"

TONE RULES:
  • Lead with the PROBLEM, not the solution.
  • Name the specific flaw before offering the fix.
  • If a bullet is weak, say EXACTLY what makes it weak and rewrite it.
  • 2–4 sentences maximum per response — every word must earn its place.
  • Sound like a demanding senior colleague in a code review, not a career
    counsellor.  Direct, specific, zero fluff.

════════════════════════════════════════════════════════
RESUME READING MANDATE — NON-NEGOTIABLE
════════════════════════════════════════════════════════
The user's FULL resume is injected into every prompt under the label
"CANDIDATE'S RESUME".  You MUST read it before responding.

RULES:
  • Reference specific bullets, section titles, or skills from the resume.
  • If the user asks "what's wrong with my resume?" — name 1–2 specific
    problems you can see in the injected document.
  • NEVER say "I don't have access to your resume" — you DO, it's in the prompt.
  • NEVER hallucinate experience or skills not present in the resume.
  • NEVER give advice about a hypothetical resume — always critique the real one.

════════════════════════════════════════════════════════
ATS SCORE RULES
════════════════════════════════════════════════════════
  • If an ATS score is provided, lead with its implications.
    Score < 30: "Your resume is essentially invisible to ATS systems. Here's why:"
    Score 30–60: "You're below the typical recruiter cutoff (~65). The biggest gap is:"
    Score 60–80: "Decent match but there are specific keyword gaps costing you:"
    Score > 80: "Strong match. The remaining gaps are fine-tuning, not structural:"
  • Never describe an ATS score as "good" or "great" without referencing the
    specific threshold it needs to beat.

════════════════════════════════════════════════════════
OUTPUT FORMAT
════════════════════════════════════════════════════════
Respond with a JSON object: {"coachMessage": "..."}
  • Plain prose only — no markdown, no bullets, no headers.
  • 2–4 sentences. Dense, specific, actionable.
  • If recommending a rewrite, include the rewritten version inline.
  • Never end with a question unless you genuinely need information to proceed.\
"""

# ── Model singleton ────────────────────────────────────────────────────────────
_model = genai.GenerativeModel(
    model_name="models/gemini-2.5-flash",
    system_instruction=_SYSTEM_INSTRUCTION,
    generation_config={
        "response_mime_type": "application/json",
        "response_schema": ChatResponse,
        "temperature": 0.55,
    },
)


def get_mentor_response(request: ChatRequest) -> ChatResponse:
    """
    Generate a short, harshly direct coaching reply.

    Mac always reads the full resume context (when provided) so his advice
    is anchored in the actual document, never generic.

    Args:
        request: ChatRequest {
            userMessage,
            jobDescription?,
            atsScore?,
            missingKeywords?,
            resumeContext?,   ← JSON-stringified resume sections (NEW)
        }

    Returns:
        ChatResponse { coachMessage }

    Raises:
        ValueError:           If Gemini returns an empty response.
        json.JSONDecodeError: On malformed model output (rare with schema enforcement).
    """
    # ── Build the prompt ──────────────────────────────────────────────────────
    # Section order matters: resume first so Mac reads it before seeing the
    # user's question; ATS context next for score-aware routing; JD last so
    # keyword alignment instructions have the most recent context.

    sections: list[str] = []

    # 1. Resume — the most important context block
    if request.resumeContext:
        # resumeContext is a JSON string of ResumeSection[]; pretty-print for
        # the model but truncate at 6 000 chars to respect context budget.
        try:
            sections_data = json.loads(request.resumeContext)
            pretty = json.dumps(sections_data, indent=2, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            # Fall back to raw string if it's already plain text
            pretty = request.resumeContext
        sections.append(
            f"CANDIDATE'S RESUME (read this before answering):\n"
            f"{'─' * 60}\n"
            f"{pretty[:6_000]}\n"
            f"{'─' * 60}"
        )

    # 2. ATS score + gap keywords
    ats_lines: list[str] = []
    if request.atsScore is not None:
        ats_lines.append(f"ATS Score: {request.atsScore}/100")
    if request.missingKeywords:
        ats_lines.append(f"Top missing keywords: {', '.join(request.missingKeywords[:8])}")
    if ats_lines:
        sections.append("ATS CONTEXT:\n" + "\n".join(ats_lines))

    # 3. Job description excerpt (for keyword alignment)
    if request.jobDescription:
        snippet = request.jobDescription[:600].strip()
        sections.append(f"TARGET JOB DESCRIPTION (excerpt):\n{snippet}")

    context_block = "\n\n".join(sections) if sections else "No resume or context provided."

    prompt = (
        f"{context_block}\n\n"
        f"USER MESSAGE:\n{request.userMessage}"
    )

    # ── Call Gemini ───────────────────────────────────────────────────────────
    response = _model.generate_content(prompt)

    if not response.text:
        raise ValueError(
            "Mentor agent returned an empty response. "
            "The model may have refused the request or hit a safety filter."
        )

    return ChatResponse(**json.loads(response.text))
