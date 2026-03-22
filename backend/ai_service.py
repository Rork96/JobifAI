"""
backend/ai_service.py — Gemini AI Service Layer
─────────────────────────────────────────────────────────────────────────────
This module owns ALL AI-specific logic.  Nothing else in the codebase should
import google.generativeai directly — all Gemini interactions go through here.

ARCHITECTURE — How do we get BOTH streaming text AND structured data?
─────────────────────────────────────────────────────────────────────
The fundamental challenge: we need the AI to simultaneously produce:
  1. A streaming conversational response (for the real-time typewriter effect)
  2. A structured JSON payload (to update DocumentPreview live)

Option A — Two API calls (extract after stream): Simple but doubles cost + latency.
Option B — Gemini Function Calling: Clean separation but function execution
           doesn't stream, so we still need a separate content stream.
Option C — Sentinel-delimited single stream (our choice):
           The system prompt instructs Gemini to output its response in two
           clearly separated sections divided by a sentinel token [DATA_EXTRACT]:

           [Conversational text in USER_LANG, streams to chat UI]
           [DATA_EXTRACT]
           {"step": "...", "advance": true, "data": {...structured JSON...}}

           The backend parser:
             • Forwards every chunk BEFORE the sentinel to the SSE stream in real-time
             • Once the sentinel is detected, switches to JSON-accumulation mode
             • After stream ends, parses and emits a single `data_extract` SSE event

           RESULT: Single API call, true real-time streaming for conversation,
           reliable structured extraction, no extra latency.

SENTINEL DETECTION DURING STREAMING:
─────────────────────────────────────
The sentinel [DATA_EXTRACT] can be split across Gemini chunks (e.g., chunk N
ends with "[DATA" and chunk N+1 starts with "_EXTRACT]\n{...").  We handle
this with an overlap buffer — we always keep the last len(SENTINEL)-1 characters
buffered until we're sure they don't form the start of the sentinel.

BILINGUAL OPERATION:
─────────────────────
  USER_LANG   — The BCP-47 code Mac converses in (from user's browser language).
  RESUME_LANG — The language of the extracted data (almost always 'en-CA').

  Example: A French speaker (USER_LANG='fr') asks about their experience.
           Mac replies in French, but the extracted responsibilities in the
           JSON block are in Canadian English (RESUME_LANG='en-CA').
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json
import logging
from typing import AsyncGenerator, Literal

import google.generativeai as genai
from google.generativeai.types import HarmBlockThreshold, HarmCategory

logger = logging.getLogger("jobifai.ai")

# ─── Type Aliases ──────────────────────────────────────────────────────────────
InterviewStep = Literal[
    "idle", "target_title", "summary", "experience", "skills_education", "complete",
    "optimize",   # ← Optimization Mode: user has existing resume, Mac is a coach not interviewer
]

# Gemini role names differ from our convention: "model" not "assistant"
GeminiRole = Literal["user", "model"]

# ─── Constants ──────────────────────────────────────────────────────────────────

# The sentinel that separates conversational text from the structured JSON block.
# Chosen to be distinctive (unlikely to appear in normal prose) and unambiguous.
# The model is instructed to output this EXACTLY — no variations.
SENTINEL = "[DATA_EXTRACT]"

# Human-readable language names for injection into system prompts.
# BCP-47 tag → natural language name the model understands.
LANGUAGE_NAMES: dict[str, str] = {
    "en":    "English",
    "en-CA": "Canadian English",
    "fr":    "French",
    "fr-CA": "Canadian French (Québécois)",
    "es":    "Spanish",
    "zh-CN": "Simplified Chinese (Mandarin)",
    "zh-TW": "Traditional Chinese (Cantonese/Mandarin)",
    "ar":    "Arabic",
    "pt":    "Brazilian Portuguese",
    "hi":    "Hindi",
}

# Fields forbidden by the Canadian Human Rights Act and Quebec's Charter.
# Used BOTH in the system prompt (instruction) and in post-processing validation
# as a defence-in-depth sanity check before persisting data to Supabase.
FORBIDDEN_HR_FIELDS: frozenset[str] = frozenset({
    "date of birth", "date_of_birth", "dob", "born",
    "age", "years old", "year old",
    "gender", "sex", "pronouns", "he/him", "she/her", "they/them",
    "marital status", "married", "single", "divorced", "widowed",
    "family status", "children", "kids", "dependents",
    "nationality", "citizenship", "country of origin",
    "religion", "faith", "church", "mosque", "temple",
    "race", "ethnicity", "skin colour", "skin color",
    "sin", "social insurance", "social insurance number",
    "photo", "picture", "headshot",
    "disability", "disabled",
    "sexual orientation",
})

# Gemini model to use — Flash is the right call here:
#   • 3–5× lower latency than Pro (critical for real-time typewriter effect)
#   • Sufficiently capable for structured interview extraction
#   • ~10× cheaper (important at PLG scale)
DEFAULT_MODEL = "gemini-2.5-flash"


# ─── System Prompt ─────────────────────────────────────────────────────────────
# This is the most critical piece of the product.  It is a "mega-prompt" that
# defines Mac's entire personality, the interview state machine, the language
# rules, the HR compliance rules, and the output format.
#
# Design principles:
#   1. Role first — establish who Mac is before telling him what to do.
#   2. Non-negotiable rules clearly labelled — the model follows prominent
#      section headers better than buried inline text.
#   3. Concrete examples — LLMs respond well to few-shot examples of the
#      exact output format we expect.
#   4. Positive framing for HR rules — instead of "never ask X" we tell the
#      model HOW to redirect gracefully, with a sample response.
# ──────────────────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT_TEMPLATE = """\
You are **Mac**, a warm, empathetic, and highly professional AI Career Co-pilot. \
You are also a strict Senior Canadian HR Specialist and resume writer with 20 years \
of experience helping candidates land interviews at top Canadian and international companies.

Your goal is to conduct a friendly, conversational interview that collects all the \
information needed to build a world-class Canadian-standard resume. You are the user's \
champion — your tone is encouraging, clear, and never robotic.

════════════════════════════════════════════════════════
RULE 1 — LANGUAGE  (NON-NEGOTIABLE)
════════════════════════════════════════════════════════
• You MUST write your conversational response ENTIRELY in {user_lang_name}.
  Every word visible to the user must be in this language. No exceptions.
• If the user writes in a different language, gently acknowledge it but \
continue responding in {user_lang_name}.
• You MUST write ALL extracted professional data in the JSON block in \
{resume_lang_name}. This means:
    - Job titles, responsibilities, skills → {resume_lang_name}
    - Action verbs → use {resume_lang_name} verbs
    - If translating from user's input, ensure idiomatic {resume_lang_name} phrasing.

════════════════════════════════════════════════════════
RULE 2 — CANADIAN HR COMPLIANCE  (NON-NEGOTIABLE)
════════════════════════════════════════════════════════
Canadian law (Canadian Human Rights Act + provincial charters) strictly prohibits \
including ANY of the following in a resume:

  ✗  Date of birth / Age          ✗  Gender / Pronouns / Sex
  ✗  Marital status               ✗  Family status / Number of children
  ✗  Nationality / Citizenship    ✗  Race / Ethnicity / Country of origin
  ✗  Religion / Faith             ✗  SIN (Social Insurance Number)
  ✗  Photo / Physical description ✗  Disability status
  ✗  Sexual orientation

WHAT TO DO when the user volunteers forbidden information:
  1. Acknowledge their answer kindly (in {user_lang_name}).
  2. Explain briefly in {user_lang_name} that Canadian HR law protects them by \
keeping this information private.
  3. Redirect the conversation to the professional aspect of their answer.

EXAMPLE (user says "I'm a 47-year-old married woman with two kids"):
  Your response in {user_lang_name}: "Thank you for sharing that! \
For your Canadian resume, we focus exclusively on professional achievements — \
Canadian HR standards actually protect you by keeping personal details like age \
or family status off the page. This prevents any unconscious bias in the hiring \
process! Let me ask you instead: what are your proudest professional \
accomplishments in your most recent role?"

════════════════════════════════════════════════════════
RULE 3 — RESUME WRITING STANDARDS  (NON-NEGOTIABLE)
════════════════════════════════════════════════════════
All extracted professional content MUST follow these rules:

• FORMAT: Reverse chronological (most recent experience / education first).
• VERBS: Every responsibility bullet MUST start with a strong Action Verb.
  Examples: Led, Built, Engineered, Designed, Delivered, Reduced, Increased,
  Managed, Coached, Negotiated, Implemented, Automated, Scaled, Launched, etc.
  ✗  Bad: "Responsible for managing a team"
  ✓  Good: "Led a cross-functional team of 8 engineers to deliver..."
• METRICS (XYZ Format): Actively probe for quantified achievements.
  Format: "Accomplished [X] by doing [Y], resulting in measurable outcome [Z]"
  ✓  "Reduced API response time by 65% by migrating to Redis caching, \
resulting in a 40% improvement in user retention."
• If an answer is vague, ask EXACTLY ONE targeted follow-up question per turn:
  - "How many people were on your team?"
  - "What was the revenue or cost impact?"
  - "By what percentage did that improve the metric?"
  - "Over what time period did you achieve that?"

════════════════════════════════════════════════════════
RULE 4 — INTERVIEW STATE MACHINE
════════════════════════════════════════════════════════
You are currently in step: **{current_step}**

Follow the behaviour for your current step EXACTLY:

▸ idle
  Welcome the user warmly. Introduce yourself as Mac. Briefly explain the \
  process (you'll ask a few questions, they answer naturally, you build their \
  resume). Ask for their target job title to begin. Set advance: true once you \
  have sent your greeting and are ready to capture the title.

▸ target_title
  Your sole goal: capture a clear, specific job title. Once you have it, \
  confirm it back to the user and express enthusiasm. Set advance: true.
  Extract: {{"targetTitle": "<exact title in {resume_lang_name}>"}}

▸ summary
  Ask the user to describe their professional background in their own words. \
  Listen, probe for:
    • Total years of experience
    • Industry/domain specialisation
    • 1-2 signature strengths
  Craft a compelling 2-3 sentence summary in {resume_lang_name}. \
  Read it back to the user in {user_lang_name} for confirmation. \
  Set advance: true ONLY once the user has confirmed the summary.
  Extract: {{"summary": "<2-3 sentence professional summary in {resume_lang_name}>"}}

▸ experience
  Collect work history in reverse chronological order. For EACH role, gather:
    • Company name
    • Job title (in {resume_lang_name})
    • Start date (YYYY-MM) and End date (YYYY-MM, or null if current)
    • 2-4 responsibilities (action verb bullets in {resume_lang_name})
    • At least 1 quantified metric
  After each role, ask: "Is there another role you'd like to add, or shall we move on?"
  Set advance: true only when the user explicitly says they are done.
  Extract: {{
    "experiences": [{{
      "company": "...",
      "title": "... (in {resume_lang_name})",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM or null",
      "responsibilities": ["Action verb ... (in {resume_lang_name})", ...],
      "metrics": ["Quantified achievement ... (in {resume_lang_name})", ...]
    }}]
  }}

▸ skills_education
  First: Ask for technical skills (tools, languages, frameworks, certifications) \
  and soft skills. Present them as a bullet list for confirmation.
  Then: Ask about education — for each degree:
    • Institution name
    • Degree type (e.g. Bachelor of Engineering)
    • Field of study
    • Graduation year
  Set advance: true once both skills and education are confirmed.
  Extract: {{
    "skills": ["Skill 1", "Skill 2", ...],
    "education": [{{
      "institution": "...",
      "degree": "...",
      "field": "...",
      "graduationYear": "YYYY",
      "honours": "... or null"
    }}]
  }}

▸ complete
  Congratulate the user warmly. Tell them their resume data is complete and \
  they can now generate their polished PDF. Set advance: false (terminal state).

▸ optimize
  The user is in Optimization Mode — they already have a resume and are working \
  with you to boost their ATS score by integrating missing keywords. \
  You are their Career Coach, NOT an interviewer. Never ask for their job title \
  or restart the resume from scratch.

  ═══ GHOST KEYWORD COACHING (triggered when they ask to integrate a specific keyword) ═══

  STEP A — Acknowledge (exactly 1 warm, specific sentence naming the keyword and \
  confirming why it matters for their target role — draw from the JD context).

  STEP B — Ask EXACTLY ONE targeted, open-ended question to draw out a real \
  professional example or metric. Tailor the question to the JD context. Examples:
    • "Walk me through the toughest technical issue you resolved for a customer."
    • "Tell me about a specific situation where [keyword] helped you improve an outcome."
    • "What measurable result came from applying [keyword] in that role?"
    • "Was there a time a customer was really struggling and [keyword] was the fix?"
  NEVER ask multiple questions in one turn. NEVER use vague fillers. Sound human.

  STEP C — After the user answers: draft ONE strong ATS-optimised bullet that:
    • Opens with a power action verb (Resolved, Implemented, Led, Reduced…)
    • Weaves in the keyword naturally
    • Uses their metric — or suggests a placeholder like "[X%]", "[N customers]", "[Xh]"
  Present the bullet in a ```code block```, then ask: \
  "Would you like me to add this to your resume?"
  If yes → extract as a new responsibility for their most recent role. \
  If they want edits → iterate once, then finalize.

  ═══ BRIDGE MESSAGE ═══
  If the user seems confused, stuck, or says "I don't know" / "skip" / "I'm not sure":
  Respond: "We're focusing on [keyword] right now to boost your score. \
  Once that's in, we'll tackle the next gap. Does that sound good?" — \
  then rephrase the question from Step B in simpler terms.

  ═══ GENERAL OPTIMIZATION CHAT ═══
  For non-keyword questions ("What should I improve?", "Why is my score low?", \
  "What's missing?", etc.):
    • Reference the job description to identify the 1-2 highest-impact gaps
    • Give a concrete, actionable suggestion — no fluff, no sycophantic openers
    • Be direct: "Here's what will move your score the most right now…"

  ═══ EXTRACTION ═══
  Only extract data after the user explicitly confirms a bullet or field.
  Set advance: false always — optimization has no terminal state.
  If adding a bullet, extract:
  {{"experiences": [{{"id": "most_recent", "responsibilities": ["bullet text"]}}]}}

{jd_section}
════════════════════════════════════════════════════════
RULE 5 — OUTPUT FORMAT  (NON-NEGOTIABLE — FOLLOW EXACTLY)
════════════════════════════════════════════════════════
Your response MUST ALWAYS consist of exactly two parts:

PART 1 — Your conversational message in {user_lang_name}.
         This is what the user reads. Be warm, concise, and human.
         Do NOT include any JSON, code blocks, or technical markup here.

{sentinel}
PART 2 — A single valid JSON object on one line (no markdown, no code fences).
         Schema:
         {{"step": "{current_step}", "advance": <true|false>, "data": {{...}}}}

         Rules:
           • "advance" is true ONLY when you have ALL required data for this step.
           • "data" contains ONLY the fields defined in Rule 4 for the current step.
           • If you are still gathering info, set advance: false and data: {{}}.
           • The JSON MUST be valid — use double quotes, no trailing commas.

─────────────────────────────────────────────────────────────────────────────
EXAMPLE (target_title step, user said "I want to be a senior software engineer"):
─────────────────────────────────────────────────────────────────────────────
Senior Software Engineer — great choice! That's a highly competitive role, \
and together we'll make sure your resume stands out. I'll make a note of that \
as your target. Now, tell me a bit about your professional background — how \
many years of experience do you have, and what industries or tech stacks \
have you worked in?

[DATA_EXTRACT]
{{"step": "target_title", "advance": true, "data": {{"targetTitle": "Senior Software Engineer"}}}}
─────────────────────────────────────────────────────────────────────────────
EXAMPLE (experience step, user gave a vague achievement):
─────────────────────────────────────────────────────────────────────────────
That's impressive! I want to make sure this really stands out on your resume. \
You mentioned you improved the deployment process — can you tell me by roughly \
what percentage you reduced deployment time, or how many deployments per week \
it enabled? Specific numbers are what make recruiters stop and read!

[DATA_EXTRACT]
{{"step": "experience", "advance": false, "data": {{}}}}
─────────────────────────────────────────────────────────────────────────────
"""


def build_system_prompt(
    user_lang: str,
    resume_lang: str,
    current_step: InterviewStep,
    job_description: str | None = None,
) -> str:
    """
    Render the system prompt template for a specific conversation turn.

    We rebuild the system prompt per-turn (not per-session) because:
      • current_step changes as the interview progresses
      • We want the model to follow step-specific behaviour precisely
      • job_description can change between sessions

    Args:
        user_lang:       BCP-47 code of the language Mac should speak in.
        resume_lang:     BCP-47 code of the language for extracted data.
        current_step:    Current position in the interview state machine.
        job_description: Optional target job posting text.  When provided,
                         Mac tailors its questions to the JD's keywords and
                         requirements.

    Returns:
        Fully rendered system prompt string.
    """
    user_lang_name   = LANGUAGE_NAMES.get(user_lang,   user_lang)
    resume_lang_name = LANGUAGE_NAMES.get(resume_lang, resume_lang)

    # ── Build the optional JD context section ──────────────────────────────────
    # WHY: When a user provides a job posting, Mac should steer the interview
    # toward the skills and keywords the ATS will look for.  Without this
    # context, Mac asks generic questions that may miss the specific stack in
    # the JD (e.g., "Kubernetes" vs. "container orchestration").
    #
    # SAFETY: User-supplied JD text may contain literal `{` or `}` characters
    # (e.g., JSON examples, code snippets).  We must escape them before
    # passing to str.format() or the template engine will raise KeyError.
    if job_description and job_description.strip():
        # Truncate to 3,000 chars — the JD section is context, not the main actor.
        # The first 3k chars always contain the requirements and responsibilities.
        #
        # NOTE: NO curly-brace escaping needed here.  `jd_section` is passed as
        # a *value* to str.format(), not as part of the template.  Python's
        # str.format() processes the template string exactly once and never
        # re-parses substituted values, so `{foo}` inside the JD text is safe.
        safe_jd = job_description[:3_000]
        jd_section = (
            "════════════════════════════════════════════════════════\n"
            "RULE 4b — TARGET JOB DESCRIPTION  (USE THIS TO GUIDE YOUR INTERVIEW)\n"
            "════════════════════════════════════════════════════════\n"
            "The user is applying for a specific role. You MUST use the JD below to:\n\n"
            "  • Prioritise the skills, tools, and certifications mentioned in the JD.\n"
            "  • Ask targeted questions to uncover experience with JD-specific technologies.\n"
            "  • Mirror the JD's exact terminology in extracted data — if the JD says\n"
            "    'Kubernetes', write 'Kubernetes', NOT 'container orchestration'.\n"
            "  • Ensure every hard skill required by the JD is explored in the interview.\n"
            "  • When writing responsibility bullets, use language the JD's ATS will match.\n\n"
            f"TARGET JOB DESCRIPTION (first 3,000 chars):\n{safe_jd}\n"
            "────────────────────────────────────────────────────────────────────────────\n"
        )
    else:
        jd_section = ""

    return _SYSTEM_PROMPT_TEMPLATE.format(
        user_lang_name=user_lang_name,
        resume_lang_name=resume_lang_name,
        current_step=current_step,
        sentinel=SENTINEL,
        jd_section=jd_section,
    )


# ─── Gemini Client Helpers ─────────────────────────────────────────────────────

def _build_gemini_model(
    api_key: str,
    current_step: InterviewStep,
    user_lang: str,
    resume_lang: str,
    job_description: str | None = None,
) -> genai.GenerativeModel:
    """
    Build a configured GenerativeModel instance.

    We create a fresh model per request (not a shared singleton) because:
      1. The system_instruction varies per turn (different current_step)
      2. GenerativeModel construction is cheap (no network call)
      3. Avoids shared mutable state between concurrent requests

    Safety settings: we LOWER the harassment/dangerous-content thresholds
    to BLOCK_NONE for this use-case.  Why?  Strict safety filters can
    incorrectly block legitimate HR discussion (e.g., the user describing
    a stressful work environment, or mentioning weapons-related jobs for
    military veterans).  The system prompt already constrains behaviour.
    """
    genai.configure(api_key=api_key)

    return genai.GenerativeModel(
        model_name=DEFAULT_MODEL,
        system_instruction=build_system_prompt(user_lang, resume_lang, current_step, job_description),
        safety_settings={
            # BLOCK_ONLY_HIGH allows almost all professional content through
            # while still blocking genuinely harmful outputs.
            HarmCategory.HARM_CATEGORY_HARASSMENT:        HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_HATE_SPEECH:       HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
        generation_config=genai.types.GenerationConfig(
            # Temperature 0.7: creative enough for warm conversation,
            # disciplined enough for reliable JSON output.
            temperature=0.7,
            # top_p + top_k together control the sampling distribution.
            top_p=0.9,
            top_k=40,
            # No max_output_tokens cap — we never know how long a user's
            # work history might be.  Gemini Flash default (~8k) is fine.
        ),
    )


def _convert_history_to_gemini(
    messages: list[dict[str, str]],
) -> list[dict]:
    """
    Convert our frontend message format to Gemini's Content format.

    Frontend format: [{"role": "user"|"assistant", "content": "..."}]
    Gemini format:   [{"role": "user"|"model", "parts": [{"text": "..."}]}]

    We also STRIP the [DATA_EXTRACT] blocks from historical model turns.
    Why?  The conversation history we keep on the frontend is the clean
    conversational text only — the JSON blocks are internal plumbing that
    the model doesn't need to see repeated in history.  It already knows
    the format from its system instruction.

    Note: We skip the last message (current user turn) — the caller adds
    that separately as the prompt.
    """
    converted: list[dict] = []

    for msg in messages:
        role    = "model" if msg["role"] == "assistant" else "user"
        content = msg["content"]

        # Strip any [DATA_EXTRACT] block that snuck into history
        if SENTINEL in content:
            content = content[: content.index(SENTINEL)].rstrip()

        if content.strip():  # skip empty messages after stripping
            converted.append({
                "role":  role,
                "parts": [{"text": content}],
            })

    return converted


# ─── SSE Event Formatters ──────────────────────────────────────────────────────
# SSE (Server-Sent Events) is a W3C standard for one-way streaming from server
# to browser.  The format is simple text lines:
#
#   event: <event_type>\n
#   data: <json_payload>\n
#   \n          ← blank line signals end of event
#
# The browser's EventSource API automatically reconnects on network errors.
# We use SSE (not WebSockets) because we only need one-way server→client flow.

def _sse_event(event_type: str, payload: dict) -> str:
    """Format a single SSE event as a string ready to yield from a generator."""
    return f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_token(text: str) -> str:
    """A chunk of conversational text to stream to the chat UI."""
    return _sse_event("token", {"text": text})


def sse_data_extract(payload: dict) -> str:
    """The structured JSON extracted from the AI response."""
    return _sse_event("data_extract", payload)


def sse_done() -> str:
    """Terminal event — client should close the EventSource connection."""
    return _sse_event("done", {})


def sse_error(message: str) -> str:
    """Error event — client should display an error and stop listening."""
    return _sse_event("error", {"message": message})


# ─── Core Streaming Generator ──────────────────────────────────────────────────

async def stream_interview_turn(
    *,
    api_key: str,
    user_message: str,
    current_step: InterviewStep,
    user_lang: str,
    resume_lang: str,
    history: list[dict[str, str]],
    job_description: str | None = None,
) -> AsyncGenerator[str, None]:
    """
    The heart of the AI engine.  Streams a single interview turn.

    Yields SSE-formatted strings in this order:
      1. `event: token`        — zero or more, streamed in real-time as Gemini generates
      2. `event: data_extract` — exactly one, containing the structured JSON
      3. `event: done`         — exactly one, signals stream completion

    On any error:
      1. `event: error`        — with a human-readable message
      2. `event: done`         — always sent so the client can close cleanly

    SENTINEL DETECTION:
    ───────────────────
    The sentinel [DATA_EXTRACT] may be split across Gemini chunks.
    We use an overlap-buffer strategy:

      safe_end pointer: we only yield up to (len(full_text) - OVERLAP_LEN)
      because the last OVERLAP_LEN chars might be the start of a sentinel.
      Once a chunk arrives and we confirm no sentinel starts there, we advance
      the pointer and yield the confirmed-safe text.

    After the stream ends, we do a final check on the entire accumulated text.

    Args:
        api_key:      Gemini API key (server default or BYOK from request).
        user_message: The user's current input.
        current_step: Interview state machine position.
        user_lang:    BCP-47 code for conversation language.
        resume_lang:  BCP-47 code for extracted data language.
        history:      Prior conversation turns (frontend format, excl. current msg).
    """
    # ── 1. Build the model and convert history ─────────────────────────────────
    model   = _build_gemini_model(api_key, current_step, user_lang, resume_lang, job_description)
    contents = _convert_history_to_gemini(history) + [
        {"role": "user", "parts": [{"text": user_message}]},
    ]

    # ── 2. Buffer state ────────────────────────────────────────────────────────
    # full_text: everything Gemini has emitted so far
    # yielded_up_to: index of the last character we've yielded as a token event
    # sentinel_found: True once we've located [DATA_EXTRACT] in the stream
    full_text      = ""
    yielded_up_to  = 0
    sentinel_found = False

    # We keep a rolling overlap buffer of this many chars at the end to handle
    # sentinels split across chunk boundaries.
    OVERLAP = len(SENTINEL) - 1  # 13 chars — the max prefix that could be confused

    try:
        response = await model.generate_content_async(contents, stream=True)

        async for chunk in response:
            # Gemini can emit empty chunks (e.g., safety filter metadata)
            chunk_text = getattr(chunk, "text", "") or ""
            if not chunk_text:
                continue

            full_text += chunk_text

            # Skip yielding if we've already found the sentinel
            if sentinel_found:
                continue

            # Check if the sentinel has now appeared in the accumulated text
            sentinel_pos = full_text.find(SENTINEL)
            if sentinel_pos != -1:
                # Sentinel found!  Yield the conversational part up to it.
                sentinel_found = True
                if sentinel_pos > yielded_up_to:
                    yield sse_token(full_text[yielded_up_to:sentinel_pos])
                    yielded_up_to = sentinel_pos
            else:
                # Sentinel not found yet.  Yield only the "confirmed safe" region —
                # everything up to len(full_text) - OVERLAP, because the last
                # OVERLAP chars might form the prefix of a split sentinel.
                safe_end = max(yielded_up_to, len(full_text) - OVERLAP)
                if safe_end > yielded_up_to:
                    yield sse_token(full_text[yielded_up_to:safe_end])
                    yielded_up_to = safe_end

        # ── 3. Stream ended — process any remaining buffered text ─────────────
        if not sentinel_found:
            # No sentinel in the entire response.  This means the model didn't
            # follow the format instruction (rare but possible).
            # Yield any remaining text and log a warning.
            if yielded_up_to < len(full_text):
                yield sse_token(full_text[yielded_up_to:])
            logger.warning(
                "Gemini response missing sentinel — step=%s, response_len=%d",
                current_step, len(full_text),
            )
            # Emit a safe fallback data_extract so the frontend doesn't hang
            yield sse_data_extract({
                "step":    current_step,
                "advance": False,
                "data":    {},
                "_warn":   "sentinel_missing",
            })
        else:
            # Parse the JSON block that follows the sentinel
            json_part = full_text[full_text.index(SENTINEL) + len(SENTINEL):].strip()

            try:
                data_payload = json.loads(json_part)

                # ── Post-processing: Canadian HR compliance sanity check ────────
                # Even if the model slipped forbidden data into the JSON, catch it.
                data_payload = _scrub_forbidden_fields(data_payload)

                yield sse_data_extract(data_payload)

            except json.JSONDecodeError as exc:
                logger.error(
                    "JSON parse failed — step=%s, raw=%r, err=%s",
                    current_step, json_part[:200], exc,
                )
                # Yield a degraded payload so the frontend can continue
                yield sse_data_extract({
                    "step":    current_step,
                    "advance": False,
                    "data":    {},
                    "_error":  "json_parse_failed",
                })

    except Exception as exc:  # noqa: BLE001
        # Catch-all: Gemini API errors, network errors, etc.
        logger.exception("Gemini streaming error — step=%s", current_step)
        yield sse_error(f"AI service error: {type(exc).__name__}: {exc!s}")

    finally:
        # Always send the done event so the frontend can close cleanly,
        # even if an error occurred mid-stream.
        yield sse_done()


# ─── Post-processing Utilities ─────────────────────────────────────────────────

def _scrub_forbidden_fields(payload: dict) -> dict:
    """
    Defence-in-depth: scan the extracted JSON for any forbidden HR fields
    and remove them before the data reaches the frontend or database.

    This is a SECONDARY check — the system prompt is the PRIMARY enforcement.
    Having both means we have two independent safeguards against accidental
    inclusion of legally protected personal information.

    Args:
        payload: The raw parsed JSON dict from the Gemini response.

    Returns:
        Cleaned payload dict with forbidden field values redacted.
    """
    if not isinstance(payload, dict):
        return payload

    data = payload.get("data", {})
    if not isinstance(data, dict):
        return payload

    flagged: list[str] = []

    # Scan all string values in the data dict for forbidden terms
    def _scan_value(value: object) -> object:
        if isinstance(value, str):
            lower = value.lower()
            for forbidden in FORBIDDEN_HR_FIELDS:
                if forbidden in lower:
                    flagged.append(f"'{forbidden}' found in value")
                    # Don't return the value — log and return a placeholder
                    return "[REDACTED — forbidden HR field]"
            return value
        if isinstance(value, list):
            return [_scan_value(v) for v in value]
        if isinstance(value, dict):
            return {k: _scan_value(v) for k, v in value.items()}
        return value

    payload["data"] = _scan_value(data)

    if flagged:
        logger.warning(
            "HR scrubber removed forbidden fields: %s", flagged
        )
        payload["_scrubbed"] = flagged

    return payload


def sanitise_extracted_data(data: dict, step: InterviewStep) -> dict:
    """
    Public helper: validate that the extracted data matches the expected
    schema for the given step.  Called by the router before returning to client.

    Returns a safe subset of the data — unexpected keys are silently dropped.
    This prevents prompt injection attacks where the model tries to include
    extra fields (e.g., "admin": true) in the JSON payload.
    """
    # Allowlist of keys per step — anything not on the list is dropped
    ALLOWED_KEYS: dict[str, set[str]] = {
        "idle":             set(),
        "target_title":     {"targetTitle"},
        "summary":          {"summary"},
        "experience":       {"experiences"},
        "skills_education": {"skills", "education"},
        "complete":         set(),
        # Optimization mode can add bullets to existing experience entries
        "optimize":         {"experiences", "skills"},
    }

    allowed = ALLOWED_KEYS.get(step, set())
    return {k: v for k, v in data.items() if k in allowed}
