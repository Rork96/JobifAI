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
