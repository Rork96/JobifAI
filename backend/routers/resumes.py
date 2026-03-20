"""
backend/routers/resumes.py — Resume Persistence Endpoints
─────────────────────────────────────────────────────────────────────────────
Two endpoints:

  POST /api/resumes        — save the current resume snapshot to Supabase
  GET  /api/resumes/{id}   — load a saved resume by its UUID

WHY BACKEND PERSISTENCE INSTEAD OF LOCALSTORAGE?
  Local storage works for a session but is:
    • Wiped when the browser is cleared
    • Not accessible across devices
    • Lost when the user clears their data

  Persisting to Supabase gives users their resume back on any device after
  sign-in.  It also lets us build a "resume history" feature later (multiple
  saved drafts per job posting).

AUTHENTICATION:
  Both endpoints require a valid Supabase JWT in the Authorization header.
  We validate the token by calling `supabase.auth.get_user(token)`, which
  verifies the JWT signature against Supabase's JWKS without a network round-
  trip (the service-role client can validate user JWTs directly).

  On JWT validation failure we return HTTP 401, not a Supabase error.

ROW LEVEL SECURITY:
  The `resumes` table has RLS enabled — only the row's `user_id` matches
  `auth.uid()`.  However, since the FastAPI backend uses the SERVICE ROLE key,
  it BYPASSES RLS entirely.  We therefore enforce ownership in Python:
    • On save:  we set `user_id = authenticated_user.id` (not from the body)
    • On load:  we add `.eq("user_id", user_id)` to the query
  This double-enforcement (app logic + RLS for the anon client) is defence-in-depth.

FAIL-SAFE:
  If the Supabase client is not configured (e.g. SUPABASE_KEY missing), the
  endpoints return HTTP 503 rather than crashing.  The interview can always
  proceed without persistence — it just won't save.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from ..config import Settings, get_settings

logger = logging.getLogger("jobifai.resumes")

# ─── Router ───────────────────────────────────────────────────────────────────
router = APIRouter(
    prefix="/api",
    tags=["resumes"],
)


# ─── Request / Response Models ─────────────────────────────────────────────────

class SaveResumeRequest(BaseModel):
    """
    Payload for POST /api/resumes.

    job_title:         The target job title (denormalised for quick listing).
    content_json:      The full Zustand ResumeData object as a dict.
    current_ats_score: The last ATS score (0–100), or None if not yet scored.
    job_description:   The JD this resume was tailored to.  Optional.
    """
    job_title:         str  | None = Field(default=None,  max_length=200)
    content_json:      dict        = Field(default_factory=dict)
    current_ats_score: int  | None = Field(default=None,  ge=0, le=100)
    job_description:   str  | None = Field(default=None,  max_length=20_000)


class SaveResumeResponse(BaseModel):
    """The UUID of the newly created (or updated) resume row."""
    id:         str
    user_id:    str
    created_at: str


class LoadResumeResponse(BaseModel):
    """
    Full resume row returned by GET /api/resumes/{id}.
    Mirrors the columns of the `public.resumes` table.
    """
    id:                str
    user_id:           str
    job_title:         str | None
    content_json:      dict
    current_ats_score: int  | None
    job_description:   str  | None
    created_at:        str
    updated_at:        str


# ─── Auth dependency ───────────────────────────────────────────────────────────

async def get_authenticated_user_id(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> str:
    """
    FastAPI dependency: validates the Supabase JWT from the Authorization header
    and returns the authenticated user's UUID string.

    The frontend sends:
        Authorization: Bearer <supabase_access_token>

    We call supabase.auth.get_user(token) which validates the JWT and returns
    the user object.  On failure we raise HTTP 401.

    WHY NOT a shared JWT middleware?
      Task 4 (full auth) will add a proper middleware.  For now, this inline
      dependency keeps the two endpoints self-contained and testable without
      standing up a full auth stack.
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
        raise  # re-raise our own 401

    except Exception as exc:
        logger.warning("JWT validation failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials.",
        ) from exc


# ─── Save endpoint ─────────────────────────────────────────────────────────────

@router.post(
    "/resumes",
    response_model=SaveResumeResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Save the current resume to Supabase",
    description="""
Persist the current interview resume data to the `public.resumes` table.

**Requires:** `Authorization: Bearer <supabase_access_token>` header.

The `user_id` is read from the validated JWT — never from the request body.
This prevents any client-side impersonation.

Returns the new row's UUID so the frontend can store it in Zustand for later
re-loading.
    """,
)
async def save_resume(
    body: SaveResumeRequest,
    settings: Settings = Depends(get_settings),
    user_id: str = Depends(get_authenticated_user_id),
) -> SaveResumeResponse:
    """
    POST /api/resumes — Persist a resume snapshot.

    Ownership is enforced by the dependency: `user_id` comes from the JWT,
    not the request body.  The INSERT always sets user_id = authenticated user.
    """
    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)

        # Build the row to insert.  We never accept user_id from the body.
        row: dict[str, Any] = {
            "user_id":           user_id,
            "content_json":      body.content_json,
        }
        if body.job_title is not None:
            row["job_title"] = body.job_title
        if body.current_ats_score is not None:
            row["current_ats_score"] = body.current_ats_score
        if body.job_description is not None:
            row["job_description"] = body.job_description

        result = client.table("resumes").insert(row).execute()

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save resume — no data returned from Supabase.",
            )

        saved = result.data[0]
        logger.info(
            "Resume saved — user=%s  resume_id=%s  score=%s",
            user_id, saved["id"], body.current_ats_score,
        )

        return SaveResumeResponse(
            id=saved["id"],
            user_id=saved["user_id"],
            created_at=saved["created_at"],
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Save resume failed — user=%s  err=%s", user_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not save resume. Please try again.",
        ) from exc


# ─── Load endpoint ─────────────────────────────────────────────────────────────

@router.get(
    "/resumes/{resume_id}",
    response_model=LoadResumeResponse,
    summary="Load a saved resume by ID",
    description="""
Retrieve a previously saved resume snapshot.

**Requires:** `Authorization: Bearer <supabase_access_token>` header.

The query enforces `user_id = authenticated_user.id` — users can only
load their own resumes.  Returns HTTP 404 if the resume doesn't exist or
belongs to a different user (avoids leaking whether the ID exists at all).
    """,
)
async def load_resume(
    resume_id: str,
    settings: Settings = Depends(get_settings),
    user_id: str = Depends(get_authenticated_user_id),
) -> LoadResumeResponse:
    """
    GET /api/resumes/{resume_id} — Retrieve a saved resume.

    Ownership check: `.eq("user_id", user_id)` is applied in addition to
    the primary key filter.  If the resume exists but belongs to another user,
    the query returns 0 rows → 404 (no info leakage).
    """
    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)

        result = (
            client.table("resumes")
            .select("*")
            .eq("id",      resume_id)
            .eq("user_id", user_id)    # ownership enforcement
            .single()
            .execute()
        )

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resume not found.",
            )

        row = result.data
        logger.info("Resume loaded — user=%s  resume_id=%s", user_id, resume_id)

        return LoadResumeResponse(
            id=row["id"],
            user_id=row["user_id"],
            job_title=row.get("job_title"),
            content_json=row.get("content_json") or {},
            current_ats_score=row.get("current_ats_score"),
            job_description=row.get("job_description"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Load resume failed — user=%s  id=%s  err=%s", user_id, resume_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not load resume. Please try again.",
        ) from exc
