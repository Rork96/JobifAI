"""
backend/services/embeddings.py — Semantic ATS Scoring Engine
─────────────────────────────────────────────────────────────────────────────
Converts resume + job description text into Google embedding vectors, then
measures their semantic similarity using cosine distance.

WHY EMBEDDINGS FOR ATS SCORING?
  Traditional ATS uses keyword counting: "Does the word 'Python' appear?".
  That misses synonyms ("Django developer" ≠ "Python developer" to a keyword
  scanner) and over-counts irrelevant repetition.

  text-embedding-004 maps text into a 768-dimensional vector space where
  semantically similar passages cluster together regardless of exact wording.
  Cosine similarity between the resume vector and JD vector gives us a true
  "semantic match" percentage — how well the resume's meaning aligns with
  what the employer actually wants.

MATH IN ONE LINE:
  cos(θ) = (A · B) / (‖A‖ × ‖B‖)
  → 1.0 = identical meaning, 0.0 = orthogonal, -1.0 = opposite meaning.
  In practice, two real documents score between ~0.3 (unrelated) and ~0.95
  (near-identical).  We rescale [0.30, 0.90] → [0%, 100%] to make the
  displayed percentage feel natural to users.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from typing import TypeAlias

import google.generativeai as genai

logger = logging.getLogger("jobifai.embeddings")

# ── Type alias ────────────────────────────────────────────────────────────────
# A "Vector" is just a list of floats — 768 values for text-embedding-004.
Vector: TypeAlias = list[float]

# ── Chunking constants ────────────────────────────────────────────────────────
# text-embedding-004 accepts up to 2,048 tokens (~8,000 chars).
# We cap our input at 3,500 chars so we stay well within the limit and
# avoid paying for low-signal "boilerplate" text (addresses, references, etc.)
_CHUNK_MAX_CHARS = 3_500

# ── Score rescaling bounds ─────────────────────────────────────────────────────
# Calibrated empirically using gemini-embedding-001 with ASYMMETRIC RETRIEVAL
# task types (resume=RETRIEVAL_DOCUMENT, jd=RETRIEVAL_QUERY):
#
#   Very poor match (marketing CV vs backend JD): raw cosine ≈ 0.54
#   Strong match   (backend CV  vs backend JD):   raw cosine ≈ 0.83
#
# Rescale [0.45, 0.85] → [0%, 100%]:
#   0.45  →   0%  (completely unrelated domain)
#   0.65  →  50%  (same industry, wrong skills — "ATS danger zone")
#   0.85  → 100%  (near-perfect semantic match)
_SIM_LOW  = 0.45
_SIM_HIGH = 0.85


# ─── Cosine similarity ────────────────────────────────────────────────────────

def _cosine_similarity(a: Vector, b: Vector) -> float:
    """
    Compute cosine similarity between two embedding vectors.

    FORMULA:
      cos(θ) = (A · B) / (‖A‖ × ‖B‖)

    STEP-BY-STEP:
      1. Dot product  A · B = Σ(a_i × b_i)
         Measures how much the two vectors "pull in the same direction"
         across all 768 dimensions.  Each dimension encodes a latent
         semantic feature (topic, sentiment, domain concept).

      2. Magnitude of A:  ‖A‖ = √(Σ a_i²)
         The Euclidean length of the vector in 768D space.

      3. Divide  →  normalises for vector length so a 2-sentence bio and
         a 3-page resume can be fairly compared.

    WHY NOT Euclidean distance?
      Euclidean distance is affected by text length — a long resume is
      "further" from any JD simply because it has more words.  Cosine
      similarity ignores length (it only measures angle) so a concise
      skills list and a verbose cover letter score the same if they
      describe the same role.

    PRACTICAL RANGE:
      For language embeddings: -0.1 (opposite domains) → 0.99 (duplicate text).
      A great resume-JD match lands at 0.75–0.88.
    """
    dot    = sum(ai * bi for ai, bi in zip(a, b))
    mag_a  = math.sqrt(sum(ai * ai for ai in a))
    mag_b  = math.sqrt(sum(bi * bi for bi in b))
    if mag_a == 0.0 or mag_b == 0.0:
        return 0.0
    return dot / (mag_a * mag_b)


# ─── Resume section extractor ─────────────────────────────────────────────────

def _extract_key_sections(resume_text: str) -> str:
    """
    Extract the highest-signal sections of a resume for embedding.

    WHY: ATS systems (and hiring managers) weight Skills + Experience far
    more heavily than sections like References or Interests.  If we embed
    the full resume, padding text dilutes the semantic signal.  Instead we
    locate common section headers and keep only the relevant blocks.

    FALLBACK: If no recognisable headers are found (plain-text or unusual
    formatting), we return the first _CHUNK_MAX_CHARS characters — the
    summary + first experience entry is usually the most relevant.
    """
    text = re.sub(r"\r\n|\r", "\n", resume_text).strip()

    # Patterns for section headers that carry ATS signal
    PRIORITY_PATTERNS = [
        r"technical\s+skills?",
        r"core\s+competencies",
        r"skills?",
        r"work\s+(?:experience|history)",
        r"professional\s+experience",
        r"employment\s+history",
        r"experience",
        r"professional\s+summary",
        r"summary",
        r"profile",
        r"qualifications",
        r"certifications?",
    ]

    header_re = re.compile(
        r"(?:^|\n)(" + "|".join(PRIORITY_PATTERNS) + r")\s*[:\n]",
        re.IGNORECASE,
    )

    matches = list(header_re.finditer(text))
    if not matches:
        return text[:_CHUNK_MAX_CHARS]

    # Collect text beneath each priority header
    blocks: list[str] = []
    for i, match in enumerate(matches):
        start = match.start()
        end   = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        blocks.append(text[start:end])

    combined = "\n".join(blocks)
    return combined[:_CHUNK_MAX_CHARS]


# ─── Embedding API call ───────────────────────────────────────────────────────

async def get_embedding(text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> Vector:
    """
    Get a 768-dimensional embedding vector from Google gemini-embedding-001.

    WHY ASYMMETRIC TASK TYPES?
      Google's embedding model supports specialised projection modes:

        RETRIEVAL_DOCUMENT — "this text is a document to be matched against"
          Used for the resume: the full document that a query will be matched to.

        RETRIEVAL_QUERY — "this text is a query looking for relevant documents"
          Used for the job description: essentially asking "find me a resume
          that fits this job".

      Empirically measured on our test pairs:
        RETRIEVAL asymmetric:   good-fit=0.83, bad-fit=0.54  (spread=0.29)
        SEMANTIC_SIMILARITY:    good-fit=0.96, bad-fit=0.77  (spread=0.19)

      The asymmetric RETRIEVAL modes produce ~50% more discrimination between
      a well-matched resume and an irrelevant one, so the displayed score has
      more meaningful range across real user data.

    NOTE: genai.embed_content() is synchronous.  asyncio.to_thread() offloads
    it to the thread pool so it doesn't block the async event loop.
    """
    result = await asyncio.to_thread(
        genai.embed_content,
        model="models/gemini-embedding-001",
        content=text,
        task_type=task_type,
    )
    return result["embedding"]  # type: ignore[index]


# ─── Main scoring function ────────────────────────────────────────────────────

async def calculate_ats_score(
    resume_text: str,
    job_description: str,
) -> dict:
    """
    Calculate the semantic ATS match score between a resume and a job description.

    PIPELINE:
      1. Extract high-signal resume sections (Skills + Experience + Summary).
      2. Embed resume sections AND job description concurrently (2 API calls).
      3. Cosine similarity → rescaled to 0–100.
      4. Separate Gemini call → extract missing keywords as "skill gaps".

    Returns:
        {
          "score":      int,        # 0–100 percentage
          "skill_gaps": list[str],  # keywords in JD absent from resume
        }
    """
    # Step 1 — Focus on the most ATS-relevant resume sections
    focused_resume = _extract_key_sections(resume_text)

    # Keep only the first 2,000 chars of the JD — requirements are front-loaded
    focused_jd = job_description[:2_000].strip() if job_description else ""

    # If no JD provided, we can't score — return neutral
    if not focused_jd:
        logger.info("ATS score skipped — no job description provided")
        return {"score": 0, "skill_gaps": []}

    # Step 2 — Embed both documents concurrently (two independent API calls)
    #          asyncio.gather() runs them in parallel, halving latency.
    #
    # ASYMMETRIC task types (measured empirically):
    #   resume  → RETRIEVAL_DOCUMENT  ("I am a document to be matched")
    #   JD      → RETRIEVAL_QUERY     ("find me a matching document")
    #
    # Spread with asymmetric RETRIEVAL: good-fit≈0.83, bad-fit≈0.54 (Δ=0.29)
    # Spread with SEMANTIC_SIMILARITY:  good-fit≈0.96, bad-fit≈0.77 (Δ=0.19)
    # Asymmetric gives ~50% more range → scores feel meaningful to users.
    resume_vec, jd_vec = await asyncio.gather(
        get_embedding(focused_resume, task_type="RETRIEVAL_DOCUMENT"),
        get_embedding(focused_jd,     task_type="RETRIEVAL_QUERY"),
    )

    # Step 3 — Cosine similarity → percentage
    #
    # Measured bounds for gemini-embedding-001 asymmetric retrieval:
    #   Very poor match (marketing CV vs backend JD):  raw ≈ 0.54
    #   Strong match   (backend CV vs backend JD):     raw ≈ 0.83
    #
    # Linear rescale:  score = (raw - LOW) / (HIGH - LOW) × 100
    #   raw = 0.45  →  0%    (completely unrelated domains)
    #   raw = 0.65  →  50%   (same industry, wrong skills)
    #   raw = 0.85  →  100%  (near-perfect match)
    #
    # Clamped to [0, 100] to handle edge cases.
    raw_sim  = _cosine_similarity(resume_vec, jd_vec)
    raw_sim  = max(0.0, min(1.0, raw_sim))              # clamp to unit interval
    score    = (raw_sim - _SIM_LOW) / (_SIM_HIGH - _SIM_LOW) * 100
    score_int = max(0, min(100, round(score)))

    logger.info(
        "ATS score — raw_cosine=%.4f  rescaled=%d%%",
        raw_sim,
        score_int,
    )

    # Step 4 — Skill gap extraction via Gemini (keyword-level, not semantic)
    skill_gaps = await _extract_skill_gaps(resume_text, job_description)

    return {
        "score":      score_int,
        "skill_gaps": skill_gaps,
    }


# ─── Skill gap analysis ───────────────────────────────────────────────────────

async def _extract_skill_gaps(resume_text: str, job_description: str) -> list[str]:
    """
    Use Gemini to find JD keywords that are missing or weak in the resume.

    WHY LLM INSTEAD OF EMBEDDING DISTANCE FOR GAPS?
      Embedding similarity tells us HOW WELL the resume matches overall.
      But to tell a user WHAT TO ADD, we need exact keyword identification.

      ATS scanners do literal substring matching — a resume that says
      "container orchestration" does NOT pass an ATS looking for "Kubernetes",
      even though semantically they're related.  Gemini reads both documents
      like a recruiter would and surfaces the specific strings the user needs
      to insert.

    Returns up to 8 concrete, specific gaps (tools, certs, action phrases).
    Soft skills and already-present items are excluded.
    """
    if not job_description.strip():
        return []

    model = genai.GenerativeModel(
        model_name="gemini-2.5-flash",
        generation_config=genai.types.GenerationConfig(
            temperature=0.1,
            # 1024 tokens — necessary for gemini-2.5-flash which uses thinking
            # tokens internally.  With max_output_tokens=256 the model exhausts
            # its budget mid-array and returns truncated JSON.
            max_output_tokens=1024,
        ),
    )

    prompt = (
        "You are an ATS keyword analyst.\n\n"
        f"JOB DESCRIPTION:\n{job_description[:1_500]}\n\n"
        f"RESUME:\n{resume_text[:2_000]}\n\n"
        "Task: List the 6 most important skills, tools, or keywords that appear "
        "in the Job Description but are MISSING or WEAK in the Resume.\n\n"
        "Rules:\n"
        "- Only concrete, specific items: tools, certifications, hard skills "
        "  (e.g. 'Kubernetes', 'Python', 'SQL')\n"
        "- Do NOT list soft skills (communication, teamwork, leadership)\n"
        "- Do NOT list items already clearly present in the resume\n"
        "- Return ONLY a JSON array of strings — no markdown, no explanation\n"
        '- Example: ["Kubernetes", "CI/CD", "React", "AWS"]'
    )

    try:
        response = await model.generate_content_async(prompt)
        raw = (response.text or "").strip()

        # gemini-2.5-flash wraps output in ```json ... ``` fences — strip them
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```\s*$", "", raw).strip()

        # Primary parse: valid JSON array
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(g).strip() for g in parsed[:8] if g]
        except json.JSONDecodeError:
            pass

        # Fallback: extract quoted strings from partial/truncated JSON
        # Handles the case where the model's output was cut mid-array.
        items = re.findall(r'"([^"]{2,50})"', raw)
        if items:
            logger.info("Skill gaps recovered via regex fallback: %d items", len(items))
            return items[:8]

        return []

    except Exception as exc:  # noqa: BLE001
        logger.warning("Skill gap extraction failed (%s): %s", type(exc).__name__, exc)
        return []
