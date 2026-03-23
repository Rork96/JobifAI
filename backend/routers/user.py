"""
backend/routers/user.py — User Progress Persistence
─────────────────────────────────────────────────────────────────────────────
Three endpoints wired to the `public.user_data` table (one row per user):

  POST   /api/user/save-progress  — debounced auto-save from the frontend
  GET    /api/user/load-progress  — hydrate the store on page refresh / login
  DELETE /api/user/clear-data     — wipe the cloud row + reset the session

TABLE SCHEMA (run supabase/migrations/20240322000000_user_data.sql first):
─────────────────────────────────────────────────────────────────────────────
  CREATE TABLE public.user_data (
    id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    resume_data      jsonb NOT NULL DEFAULT '{}'::jsonb,
    analysis_result  jsonb DEFAULT NULL,
    chat_history     jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_premium       boolean NOT NULL DEFAULT false,
    updated_at       timestamptz NOT NULL DEFAULT now()
  );

UPSERT STRATEGY:
  `id` IS the user's UUID (auth.users.id). One row per user — no sentinel
  `job_title = '__autosave__'` needed. The upsert targets `id` directly.

OWNERSHIP:
  `id` written to the row is ALWAYS taken from the validated JWT, never from
  the request body. A forged payload cannot touch another user's row.

AUTHENTICATION:
  Expects:  Authorization: Bearer <supabase_access_token>
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import jwt as pyjwt  # PyJWT — local HS256 decode; avoids network round-trip per request
from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from pydantic import BaseModel, Field

from ..config import Settings, get_settings

logger = logging.getLogger("jobifai.user")

# ─── Router ───────────────────────────────────────────────────────────────────
router = APIRouter(
    prefix="/api/user",
    tags=["user"],
)


# ─── Auth dependency ───────────────────────────────────────────────────────────

async def get_authenticated_user_id(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> str:
    """
    Validates the Supabase JWT from the Authorization header.
    Returns the authenticated user's UUID string, or raises HTTP 401.

    Two-strategy validation:

    Strategy A — Local HS256 decode (preferred):
        When SUPABASE_JWT_SECRET is set, we decode the token entirely in-process.
        Zero network, zero latency, no dependency on Supabase Auth availability.
        Supabase signs all user access tokens with HS256 using this shared secret.

    Strategy B — Supabase Auth API (fallback):
        Used when SUPABASE_JWT_SECRET is not configured.
        Calls POST /auth/v1/user against the Supabase project; slower and requires
        the Supabase Auth service to be reachable, but requires no additional config.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header. Expected: Bearer <token>",
        )

    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token is empty.",
        )

    # ── Strategy A: local JWT decode (fast path) ─────────────────────────────
    if settings.supabase_jwt_secret:
        try:
            payload: dict[str, Any] = pyjwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                # Supabase issues access tokens with aud="authenticated".
                # Passing the audience here causes PyJWT to verify it,
                # rejecting service-role or anon tokens sent by accident.
                audience="authenticated",
            )
        except pyjwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Session has expired. Please sign in again.",
            )
        except pyjwt.InvalidAudienceError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token has unexpected audience (expected 'authenticated').",
            )
        except pyjwt.exceptions.InvalidAlgorithmError as exc:
            # The token's alg header isn't HS256 (e.g. project uses RS256).
            # HS256 assumption is wrong — fall through to Strategy B so the
            # Supabase Auth API can validate it regardless of algorithm.
            logger.warning(
                "JWT alg mismatch — token is not HS256, falling back to Auth API: %s",
                exc,
            )
            # jump to Strategy B below by skipping the return
        except pyjwt.InvalidTokenError as exc:
            # Covers InvalidSignatureError, DecodeError, etc.
            # These are definitive rejections — the token is malformed or tampered.
            logger.warning("JWT local decode failed: %s: %s", type(exc).__name__, exc)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid token: {type(exc).__name__}",
            ) from exc
        else:
            # Strategy A succeeded — extract sub and return immediately.
            user_id: str | None = payload.get("sub")
            if not user_id:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Token is missing the 'sub' claim.",
                )
            logger.debug("JWT validated locally — user=%s", user_id)
            return user_id

    # ── Strategy B: Supabase Auth API (fallback when no JWT secret) ──────────
    logger.debug(
        "SUPABASE_JWT_SECRET not set — falling back to Auth API validation "
        "(set it for faster, network-free token checks)"
    )
    try:
        from supabase import create_client  # type: ignore[import-untyped]

        # Use the service-role key so the admin client can call auth.get_user().
        client = create_client(settings.supabase_url, settings.supabase_key)
        resp = client.auth.get_user(token)

        if not resp or not resp.user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired session token (Auth API returned no user).",
            )

        logger.debug("JWT validated via Auth API — user=%s", resp.user.id)
        return resp.user.id

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "Auth API validation failed — %s: %s",
            type(exc).__name__,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Supabase API Error: {exc}",
        ) from exc


# ─── Request / Response Models ─────────────────────────────────────────────────

class SaveProgressRequest(BaseModel):
    """
    Payload for POST /api/user/save-progress.

    All fields have safe defaults so a partial save never 422s.
    The frontend sends the full Zustand snapshot on every debounced fire.
    """
    resume_data:     dict                 = Field(
        default_factory=dict,
        description="Full Zustand ResumeData object (targetTitle, experiences, skills…)",
    )
    analysis_result: dict | None         = Field(
        default=None,
        description="ATSAnalysisResponse from /api/analyze — score, keywords, macMessage",
    )
    ats_score:       int | None          = Field(
        default=None, ge=0, le=100,
        description="currentAtsScore — persisted as a top-level column for fast reads",
    )
    messages:        list[dict[str, Any]] = Field(
        default_factory=list,
        description="Chat message history [{role, content}]",
    )


class SaveProgressResponse(BaseModel):
    """Returned after a successful upsert."""
    saved:      bool
    id:         str
    updated_at: str


class LoadProgressResponse(BaseModel):
    """
    Payload returned by GET /api/user/load-progress.

    found = False means no row yet (brand-new user).
    Frontend treats this as a clean slate, NOT an error.
    """
    found:           bool
    resume_data:     dict                   = Field(default_factory=dict)
    analysis_result: dict | None           = None
    ats_score:       int | None            = None
    messages:        list[dict[str, Any]]  = Field(default_factory=list)


# ─── Save Progress ──────────────────────────────────────────────────────────────

@router.post(
    "/save-progress",
    response_model=SaveProgressResponse,
    summary="Auto-save full session state for the authenticated user",
    description="""
Upserts a single row in `public.user_data` (id = auth JWT user_id).

**Columns written:**
- `resume_data`     ← Zustand ResumeData object
- `analysis_result` ← Full ATSAnalysisResponse (score, keywords, macMessage)
- `chat_history`    ← Full message array
- `updated_at`      ← Auto-bumped by DB trigger

Called by the frontend's 3-second debounced `syncToSupabase()` action
whenever `resumeData`, `messages`, or `analysisResult` changes.
    """,
)
async def save_progress(
    body:     SaveProgressRequest,
    settings: Settings = Depends(get_settings),
    user_id:  str      = Depends(get_authenticated_user_id),
) -> SaveProgressResponse:
    """POST /api/user/save-progress — upsert the user's full session state."""
    # Always have a fallback timestamp so we return valid JSON even if the DB
    # trigger doesn't populate updated_at (e.g. empty result.data on 204).
    now_iso = datetime.now(timezone.utc).isoformat()

    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)

        # id = user_id (the auth UUID).  Upsert resolves conflict on `id`.
        row: dict[str, Any] = {
            "id":              user_id,
            "resume_data":     body.resume_data,
            "analysis_result": body.analysis_result,
            "chat_history":    body.messages,
        }

        # ── Supabase upsert ──────────────────────────────────────────────────
        # Wrapped in its own try/except so we can distinguish a Supabase-level
        # failure (RLS, schema mismatch, network blip) from a general server
        # error.  The 400 status code tells the frontend that the payload was
        # valid but the DB rejected it — actionable for debugging.
        try:
            result = (
                client.table("user_data")
                .upsert(row, on_conflict="id")
                .execute()
            )
        except Exception as sb_exc:
            # Supabase SDK raises its own exception types (APIError, etc.).
            # Stringify and surface as 400 so the frontend can log the detail.
            detail = f"Supabase upsert failed: {type(sb_exc).__name__}: {sb_exc}"
            logger.error("save-progress Supabase error — user=%s: %s", user_id, detail)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail,
            ) from sb_exc

        # result.data is a list; it may be empty if the DB returned 0 rows
        # (e.g. a RETURNING clause that matched nothing — shouldn't happen on
        # upsert but guard anyway rather than throwing a KeyError).
        updated_at = now_iso
        if result.data:
            updated_at = result.data[0].get("updated_at") or now_iso

        logger.info(
            "Progress saved — user=%s  msgs=%d  score=%s  has_analysis=%s",
            user_id,
            len(body.messages),
            body.ats_score,
            body.analysis_result is not None,
        )

        return SaveProgressResponse(saved=True, id=user_id, updated_at=updated_at)

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "Auto-save failed — user=%s  err=%s: %s",
            user_id, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Could not save progress ({type(exc).__name__}). Please try again.",
        ) from exc


# ─── Load Progress ──────────────────────────────────────────────────────────────

@router.get(
    "/load-progress",
    response_model=LoadProgressResponse,
    summary="Hydrate the frontend store from the last saved session",
    description="""
Fetches the `user_data` row for the authenticated user.

Called by `useAuth.ts` immediately after a Supabase session is confirmed
(page refresh / magic-link return / Google OAuth).

Returns `found: false` (HTTP 200) for new users — this is normal and should
NOT be treated as an error by the frontend.
    """,
)
async def load_progress(
    settings: Settings = Depends(get_settings),
    user_id:  str      = Depends(get_authenticated_user_id),
) -> LoadProgressResponse:
    """GET /api/user/load-progress — restore the latest saved session on boot."""

    def _safe_dict(v: Any) -> dict:
        return v if isinstance(v, dict) and v else {}

    def _safe_list(v: Any) -> list:
        if not isinstance(v, list):
            return []
        return [m for m in v if isinstance(m, dict)]

    def _safe_score(v: Any) -> int | None:
        if isinstance(v, (int, float)) and 0 <= int(v) <= 100:
            return int(v)
        return None

    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)

        result = (
            client.table("user_data")
            .select("id, resume_data, analysis_result, chat_history, updated_at")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )

        if not result.data:
            logger.info("load-progress — no row for user=%s (new user)", user_id)
            return LoadProgressResponse(found=False)

        row          = result.data[0]
        resume_data  = _safe_dict(row.get("resume_data"))
        analysis     = row.get("analysis_result")          # may be None
        messages     = _safe_list(row.get("chat_history"))

        # Guard: treat an empty resume_data as "no draft yet"
        if not resume_data:
            logger.info(
                "load-progress — empty resume_data for user=%s (treating as new user)",
                user_id,
            )
            return LoadProgressResponse(found=False)

        # Extract ATS score from analysis_result if available
        ats_score = None
        if isinstance(analysis, dict):
            ats_score = _safe_score(analysis.get("score"))

        logger.info(
            "load-progress — restored user=%s  score=%s  resume_keys=%d  msgs=%d",
            user_id, ats_score, len(resume_data), len(messages),
        )

        return LoadProgressResponse(
            found=           True,
            resume_data=     resume_data,
            analysis_result= analysis if isinstance(analysis, dict) else None,
            ats_score=       ats_score,
            messages=        messages,
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


# ─── Clear Data ────────────────────────────────────────────────────────────────

@router.delete(
    "/clear-data",
    # response_class=Response bypasses FastAPI's Pydantic serialisation pipeline
    # entirely, which prevents the Starlette startup AssertionError:
    #   "Status code 204 must not have a response body"
    # that fires with FastAPI 0.111 + Pydantic v2 when the route's return-type
    # annotation is left as `-> None` and the framework tries to attach a model.
    response_class=Response,
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete the user's saved cloud data and reset their session",
    description="""
Deletes the `user_data` row for the authenticated user.

Called when the user clicks **Clear All Data** in the Settings panel.
The frontend resets its local Zustand store to `IDLE` independently —
this endpoint only handles the server-side deletion.

Returns 204 No Content on success.
Returns 404 if no row exists (treated as success by the frontend).
    """,
)
async def clear_data(
    settings: Settings = Depends(get_settings),
    user_id:  str      = Depends(get_authenticated_user_id),
) -> Response:
    """DELETE /api/user/clear-data — wipe the user's persisted session."""
    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)

        client.table("user_data").delete().eq("id", user_id).execute()

        logger.info("Cloud data cleared — user=%s", user_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception(
            "clear-data failed — user=%s  err=%s: %s",
            user_id, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not clear data. Please try again.",
        ) from exc
