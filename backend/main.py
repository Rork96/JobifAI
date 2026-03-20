"""
JobifAI — FastAPI Entry Point
─────────────────────────────────────────────────────────────────────────────
This file is the heart of the backend.  Every HTTP request flows through here
before being dispatched to a router (which we'll add in later tasks).

Architecture note:
  We use the "application factory" pattern — create_app() builds and returns
  the FastAPI instance rather than declaring it at module level.  This makes
  the app easy to test (just call create_app() with test settings) and keeps
  startup logic explicit.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import google.generativeai as genai        # Gemini SDK — configured at startup

from .config import Settings, get_settings  # typed settings — see config.py
from .routers import evaluate               # Task 5: ATS edit scorer endpoint
from .routers import interview               # Task 3: AI interview SSE endpoint
from .routers import job                    # Task 7: Job description scraper endpoint
from .routers import upload                 # Task 7: Resume file upload + parser endpoint
from .routers import resumes                # Task 9: Resume save/load persistence
from .routers import payments               # Task 9: Stripe checkout + webhook

# ─── Logging ──────────────────────────────────────────────────────────────────
# Use Python's stdlib logger so output lands in Docker logs (stdout/stderr).
# We'll upgrade to structlog for JSON logs in a later task.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("jobifai")


# ─── Lifespan (startup / shutdown hooks) ──────────────────────────────────────
# FastAPI recommends the @asynccontextmanager lifespan pattern over the old
# @app.on_event("startup") decorator — it groups setup/teardown in one place.
@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    """
    Everything before `yield` runs on startup.
    Everything after `yield` runs on shutdown (graceful cleanup).
    """
    settings: Settings = get_settings()
    logger.info("🚀  JobifAI backend starting — env=%s", settings.environment)
    logger.info("🔗  Supabase URL: %s", settings.supabase_url)

    # ── Gemini SDK global configuration ──────────────────────────────────────
    # `genai.configure()` sets the API key once for the entire process.
    # The ai_service module calls `genai.GenerativeModel()` per-request, so
    # this must run before any request is served.
    genai.configure(api_key=settings.gemini_api_key)
    logger.info("🤖  Gemini AI configured — model=gemini-2.5-flash")

    # TODO (Task 4): initialise Supabase client and attach to app.state
    # TODO (Task 5): register Stripe webhook secret

    yield  # ← application runs while we're suspended here

    logger.info("👋  JobifAI backend shutting down cleanly")


# ─── Application Factory ───────────────────────────────────────────────────────
def create_app(settings: Settings | None = None) -> FastAPI:
    """
    Build and return the configured FastAPI application.

    Args:
        settings: Optional Settings override (useful in tests).
                  When None we load from environment variables.
    """
    if settings is None:
        settings = get_settings()

    # ── FastAPI metadata (auto-generates /docs and /redoc) ───────────────────
    app = FastAPI(
        title="JobifAI API",
        version="0.1.0",
        description="AI Career Co-pilot — Multi-Agent resume optimisation engine.",
        # Disable docs in production to reduce attack surface
        docs_url="/docs" if settings.environment == "dev" else None,
        redoc_url="/redoc" if settings.environment == "dev" else None,
        lifespan=lifespan,
    )

    # ── CORS ─────────────────────────────────────────────────────────────────
    # CORS tells browsers which *origins* are allowed to call this API.
    # An "origin" = scheme + host + port.  We must be explicit — wildcard "*"
    # would allow any website to make credentialed requests to our API.
    #
    # allowed_origins is built from settings so it can be overridden via env.
    allowed_origins: list[str] = [
        "http://localhost:5173",   # Vite dev server (frontend)
        "https://cv.wealthifai.xyz",  # Production domain
    ]

    # In dev we also allow the raw IP in case the tester hits the Pi directly
    if settings.environment == "dev":
        allowed_origins += [
            "http://localhost:4173",   # Vite preview (npm run preview)
            "http://127.0.0.1:5173",
        ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        # allow_credentials=True lets the browser send cookies / Auth headers.
        # Required for Supabase JWT tokens sent as Bearer headers.
        allow_credentials=True,
        # Only allow the methods our API actually uses — principle of least
        # privilege applied to HTTP verbs.
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        # Content-Type & Authorization are the minimum needed for JSON + JWT.
        # Expose X-Request-ID so the frontend can log correlation IDs.
        allow_headers=["Content-Type", "Authorization", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
    )

    # ── Request timing middleware ─────────────────────────────────────────────
    # Middleware is a function that wraps every request/response.
    # We use it to log latency and attach a request-id for tracing.
    @app.middleware("http")
    async def add_timing_header(request: Request, call_next: Any) -> Any:
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000
        response.headers["X-Response-Time-Ms"] = f"{duration_ms:.1f}"
        logger.info(
            "%s %s → %s  (%.1f ms)",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
        )
        return response

    # ── Routers ───────────────────────────────────────────────────────────────
    # Each feature area has its own APIRouter in backend/routers/.
    # We mount them here so this file stays focused on app-level concerns
    # (middleware, CORS, lifespan) rather than individual endpoint logic.
    #
    # The router already declares its own prefix ("/api/chat") and tags, so we
    # include it without an extra prefix here.
    app.include_router(interview.router)  # POST /api/chat/interview (SSE)
    app.include_router(evaluate.router)   # POST /api/evaluate-edit (ATS scorer)
    app.include_router(upload.router)     # POST /api/upload-resume (file parser)
    app.include_router(job.router)        # POST /api/parse-job (JD scraper)
    app.include_router(resumes.router)    # POST /api/resumes, GET /api/resumes/{id}
    app.include_router(payments.router)   # POST /api/checkout, POST /api/webhooks/stripe
    # Future routers:
    #   app.include_router(auth.router)      # /api/auth

    # ── Core routes (inline for now) ─────────────────────────────────────────
    @app.get("/health", tags=["ops"])
    async def health_check() -> JSONResponse:
        """
        Liveness probe — used by Docker/Kubernetes to decide if the container
        is healthy.  Returns 200 as long as the process is alive.

        A *readiness* probe (is the app ready to serve traffic?) would also
        ping Supabase.  We'll add that in Task 3 once the DB client exists.
        """
        return JSONResponse(
            status_code=200,
            content={
                "status": "ok",
                "service": "jobifai-api",
                "version": app.version,
                "environment": settings.environment,
            },
        )

    @app.get("/", include_in_schema=False)
    async def root() -> JSONResponse:
        """Redirect hint for humans hitting the bare root URL."""
        return JSONResponse({"message": "JobifAI API — see /docs for endpoints."})

    return app


# ─── WSGI/ASGI entry-point ────────────────────────────────────────────────────
# `app` is the object uvicorn imports when you run:
#   uvicorn backend.main:app --reload
#
# We build it once at import time using production settings.
# Tests should call create_app(settings=mock_settings) directly.
app: FastAPI = create_app()
