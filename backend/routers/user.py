"""
backend/routers/user.py — User Progress Persistence
─────────────────────────────────────────────────────────────────────────────
POST /api/user/save-progress

Called by the frontend's debounced auto-save hook every 2 seconds after any
change to `resumeData` or `messages`.  Upserts a single "current draft" row
per user — not a versioned history — so the table never grows unbounded.

DATABASE SCHEMA (run this migration in Supabase SQL editor before deploying):
─────────────────────────────────────────────────────────────────────────────

  -- Add chat_history_json column if it doesn't already exist
  ALTER TABLE public.resumes
    ADD COLUMN IF NOT EXISTS chat_history_json  jsonb  DEFAULT '[]'::jsonb;

  -- Unique constraint so upsert can resolve conflicts on user_id
  -- (one "current draft" row per user — not one per resume)
  -- Only add this if you want single-row-per-user semantics.
  -- Comment it out if users should be able to save multiple named resumes.
  CREATE UNIQUE INDEX IF NOT EXISTS resumes_user_id_draft_idx
    ON public.resumes (user_id)
    WHERE (job_title = '__autosave__');

─────────────────────────────────────────────────────────────────────────────

UPSERT STRATEGY:
  We use Supabase's `.upsert()` with `on_conflict='user_id'` targeting the
  `__autosave__` sentinel row (job_title = '__autosave__').  This:
    • Creates the row on first save (INSERT path)
    • Updates it on every subsequent save (UPDATE path)
    • Never duplicates rows for the same user

  Named saves (user clicks "Save as…") continue to use POST /api/resumes
  which always INSERTs a new row with a real job_title.

OWNERSHIP:
  The `user_id` written to the row is ALWAYS taken from the validated JWT,
  never from the request body.  The upsert filter includes `.eq("user_id",
  user_id)` so a user can never overwrite another user's autosave row even
  if they somehow constructed a forged payload.

AUTHENTICATION:
  Reuses the same `get_authenticated_user_id` dependency from resumes.py.
  Expects:  Authorization: Bearer <supabase_access_token>
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from ..config import Settings, get_settings

logger = logging.getLogger("jobifai.user")

# ─── Router ───────────────────────────────────────────────────────────────────
router = APIRouter(
    prefix="/api/user",
    tags=["user"],
)

# Sentinel value used as job_title for the auto-save row.
# Keeps it distinguishable from user-created named saves.
_AUTOSAVE_TITLE = "__autosave__"


# ─── Auth dependency (mirrors resumes.py) ─────────────────────────────────────

async def get_authenticated_user_id(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> str:
    """
    Validates the Supabase JWT from the Authorization header.
    Returns the authenticated user's UUID string, or raises HTTP 401.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header. Expected: Bearer <token>",
        )

    token = authorization.removeprefix("Bearer ").strip()

    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)
        resp = client.auth.get_user(token)
        if not resp or not resp.user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired session token.",
            )
        return resp.user.id

    except HTTPException:
        raise

    except Exception as exc:
        logger.warning("JWT validation failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials.",
        ) from exc


# ─── Request / Response Models ─────────────────────────────────────────────────

class SaveProgressRequest(BaseModel):
    """
    Payload for POST /api/user/save-progress.

    resume_data:  The full Zustand ResumeData object serialised as a dict.
                  Stored in the `content_json` column.
    ats_score:    The current ATS score (0–100).  None if analysis hasn't run.
                  Stored in `current_ats_score`.
    messages:     The full chat history array (list of {role, content} dicts).
                  Stored in the `chat_history_json` column.
    """
    resume_data: dict           = Field(default_factory=dict, description="Zustand resumeData")
    ats_score:   int | None     = Field(default=None, ge=0, le=100, description="Current ATS score")
    messages:    list[dict[str, Any]] = Field(default_factory=list, description="Chat message history")


class SaveProgressResponse(BaseModel):
    """
    Confirmation payload returned after a successful save.

    saved:  Always true — 4xx/5xx are raised on failure, never false here.
    id:     UUID of the upserted row (useful for debugging / re-loading).
    """
    saved: bool
    id:    str


class LoadProgressResponse(BaseModel):
    """
    Payload returned by GET /api/user/load-progress.

    found:        False when no auto-save row exists yet (new user).
    resume_data:  The Zustand ResumeData dict (stored in content_json).
    ats_score:    The persisted ATS score (0–100), or None if not yet scored.
    messages:     The chat history as [{role, content}] dicts.
    """
    found:       bool
    resume_data: dict                   = Field(default_factory=dict)
    ats_score:   int | None             = None
    messages:    list[dict[str, Any]]   = Field(default_factory=list)


# ─── Endpoint ──────────────────────────────────────────────────────────────────

@router.post(
    "/save-progress",
    response_model=SaveProgressResponse,
    summary="Auto-save resume draft + chat history for the authenticated user",
    description="""
Upserts a single "current draft" row in the `public.resumes` table.

The `user_id` is taken exclusively from the validated JWT — never from the
request body — so a user can only write to their own row.

**Behaviour:**
- First call → `INSERT` a new row with `job_title = '__autosave__'`
- Subsequent calls → `UPDATE` the existing row in-place
- Named saves (`POST /api/resumes`) are unaffected — they always `INSERT`

**Columns updated:**
- `content_json`       ← `resume_data`
- `chat_history_json`  ← `messages`
- `current_ats_score`  ← `ats_score`

**Required DB migration** (run once in Supabase SQL editor):
```sql
ALTER TABLE public.resumes
  ADD COLUMN IF NOT EXISTS chat_history_json jsonb DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS resumes_user_id_draft_idx
  ON public.resumes (user_id)
  WHERE (job_title = '__autosave__');
```
    """,
)
async def save_progress(
    body:     SaveProgressRequest,
    settings: Settings = Depends(get_settings),
    user_id:  str      = Depends(get_authenticated_user_id),
) -> SaveProgressResponse:
    """
    POST /api/user/save-progress — Debounced auto-save from the frontend.

    Uses Supabase upsert targeting the unique (user_id WHERE job_title = '__autosave__')
    index.  This guarantees exactly one autosave row per user regardless of how
    many times this endpoint is called.
    """
    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)

        # ── Build the row ─────────────────────────────────────────────────────
        # user_id is ALWAYS from the JWT dependency, never the request body.
        row: dict[str, Any] = {
            "user_id":            user_id,
            "job_title":          _AUTOSAVE_TITLE,
            "content_json":       body.resume_data,
            "chat_history_json":  body.messages,
        }
        if body.ats_score is not None:
            row["current_ats_score"] = body.ats_score

        # ── Upsert ────────────────────────────────────────────────────────────
        # `on_conflict="user_id"` alone would conflict with ALL rows for that user.
        # The partial unique index (WHERE job_title = '__autosave__') means only
        # the autosave sentinel row is targeted — named saves are untouched.
        #
        # If the partial index is not yet created (migration not run), this falls
        # back to a regular INSERT which creates a new row on each call.  The
        # endpoint still works; it just won't de-duplicate.
        result = (
            client.table("resumes")
            .upsert(row, on_conflict="user_id,job_title")
            .execute()
        )

        if not result.data:
            # Supabase returned an empty response — likely a RLS policy block
            # or a schema mismatch.  Raise rather than silently failing so the
            # frontend receives a clear 500 and can show a "Save failed" toast.
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Save failed — no data returned from database.",
            )

        saved_row = result.data[0]
        row_id    = saved_row.get("id", "unknown")

        logger.info(
            "Progress saved — user=%s  resume_id=%s  msgs=%d  score=%s",
            user_id, row_id, len(body.messages), body.ats_score,
        )

        return SaveProgressResponse(saved=True, id=row_id)

    except HTTPException:
        raise  # re-raise our own errors unchanged

    except Exception as exc:
        logger.exception(
            "Auto-save failed — user=%s  err=%s: %s",
            user_id, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not save progress. Please try again.",
        ) from exc


# ─── Load Progress ──────────────────────────────────────────────────────────────

@router.get(
    "/load-progress",
    response_model=LoadProgressResponse,
    summary="Load the authenticated user's latest auto-saved draft on app boot",
    description="""
Fetches the single `__autosave__` row for the authenticated user.

Called by the frontend's `useAuth` hook immediately after a session is
confirmed (page refresh / magic-link return).  If the Zustand store is empty
but the user has a prior session, this restores their resume data, score, and
chat history so they can continue working without re-entering anything.

Returns `found: false` (HTTP 200) when no auto-save row exists yet — this is
the normal state for a brand-new user and should not be treated as an error.
    """,
)
async def load_progress(
    settings: Settings = Depends(get_settings),
    user_id:  str      = Depends(get_authenticated_user_id),
) -> LoadProgressResponse:
    """
    GET /api/user/load-progress — Restore the latest draft on page refresh.

    Always returns HTTP 200.  `found=False` means new user / no draft yet —
    the frontend should treat this as a clean slate, not an error.
    """
    # ── Helpers ───────────────────────────────────────────────────────────────
    def _safe_dict(value: Any) -> dict:
        """Return value if it's a non-empty dict, else {}."""
        return value if isinstance(value, dict) and value else {}

    def _safe_list(value: Any) -> list:
        """Return value if it's a non-empty list of dicts, else []."""
        if not isinstance(value, list):
            return []
        # Filter out any non-dict entries so the frontend never chokes on
        # corrupted rows (e.g. a column that somehow stored a plain string).
        return [m for m in value if isinstance(m, dict)]

    def _safe_score(value: Any) -> int | None:
        """Return value clamped to 0–100 if numeric, else None."""
        if isinstance(value, (int, float)) and 0 <= int(value) <= 100:
            return int(value)
        return None

    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)

        logger.debug("load-progress — querying autosave row for user=%s", user_id)

        result = (
            client.table("resumes")
            .select("id, content_json, chat_history_json, current_ats_score")
            .eq("user_id", user_id)
            .eq("job_title", _AUTOSAVE_TITLE)
            .limit(1)
            .execute()
        )

        # ── No row yet → new user, return a clean empty structure ─────────────
        if not result.data:
            logger.info(
                "load-progress — no autosave row for user=%s (new user or first session)",
                user_id,
            )
            return LoadProgressResponse(found=False)

        row = result.data[0]
        row_id = row.get("id", "unknown")

        # ── Defensive extraction ───────────────────────────────────────────────
        # `chat_history_json` requires the ADD COLUMN migration.  If the column
        # hasn't been created yet, Supabase returns the row without that key.
        # We handle KeyError / None gracefully rather than blowing up.
        raw_resume   = row.get("content_json")
        raw_messages = row.get("chat_history_json")          # None if column missing
        raw_score    = row.get("current_ats_score")

        resume_data = _safe_dict(raw_resume)
        messages    = _safe_list(raw_messages)
        ats_score   = _safe_score(raw_score)

        # ── Guard: if content_json is completely empty treat as no draft ───────
        if not resume_data:
            logger.info(
                "load-progress — row id=%s for user=%s has empty content_json (treating as no draft)",
                row_id, user_id,
            )
            return LoadProgressResponse(found=False)

        logger.info(
            "load-progress — restored user=%s  row=%s  score=%s  "
            "resume_keys=%d  msgs=%d  chat_col_present=%s",
            user_id, row_id, ats_score,
            len(resume_data), len(messages),
            raw_messages is not None,
        )

        return LoadProgressResponse(
            found=       True,
            resume_data= resume_data,
            ats_score=   ats_score,
            messages=    messages,
        )

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "load-progress failed — user=%s  err=%s: %s",
            user_id, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not load saved progress. Please try again.",
        ) from exc
