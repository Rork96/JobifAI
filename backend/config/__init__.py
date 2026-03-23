"""
JobifAI — Typed Application Settings
─────────────────────────────────────────────────────────────────────────────
Pydantic BaseSettings reads values from:
  1. Environment variables (highest priority)
  2. A .env file (if present and python-dotenv is installed)
  3. Default values defined on the model

This means you never hard-code secrets.  In Docker we pass env vars via
docker-compose.yml (which reads from .env on the host).

NOTE ON PACKAGE LAYOUT:
  This file was originally backend/config.py.  When the Task 6 architectural
  cleanup created backend/config/prompts.py, Python's package resolution rules
  caused the config/ directory to shadow the config.py module — so
  `from .config import Settings` silently hit this (then-empty) __init__.py
  instead of the real Settings class.  Moving Settings here fixes the conflict:
  the package now exports both Settings (from this file) and prompts (sub-module).
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    All runtime configuration lives here.  Type annotations let FastAPI/Pydantic
    validate that every required secret is present at startup — fail fast is
    better than mysterious runtime errors mid-request.
    """

    # ── Environment ───────────────────────────────────────────────────────────
    # Literal["dev", "prod"] means Pydantic will reject any other string value.
    environment: Literal["dev", "prod"] = Field(
        default="dev",
        description="Controls log verbosity, /docs availability, CORS extras.",
    )

    # ── Supabase ──────────────────────────────────────────────────────────────
    # The URL is public (it's in the Supabase dashboard).
    # The KEY here should be the *service role* key for server-side operations
    # (bypasses Row Level Security when needed).  Never expose it to the browser.
    supabase_url: str = Field(..., description="https://<ref>.supabase.co")
    supabase_key: str = Field(..., description="Supabase service-role secret key")

    # ── Gemini ────────────────────────────────────────────────────────────────
    # Our hosted key for the free tier.  Users can supply their own (BYOK easter
    # egg) — that'll be handled per-request, not here.
    gemini_api_key: str = Field(..., description="Google AI Studio API key")

    # ── Stripe ────────────────────────────────────────────────────────────────
    stripe_secret_key: str = Field(..., description="Stripe sk_live_ or sk_test_ key")
    # Webhook signing secret so we can verify events came from Stripe, not an
    # attacker who reverse-engineered our endpoint URL.
    stripe_webhook_secret: str = Field(
        default="",
        description="whsec_... from Stripe dashboard; required in prod.",
    )
    # Pre-created Stripe Price IDs (from the Stripe dashboard Products page).
    # Using a Price ID is more reliable than inline price_data:
    #   • The product name / currency / trial period are locked in the dashboard.
    #   • Stripe Connect, coupons, and tax rates attach to the Price object.
    # Leave as "" to fall back to inline price_data for local dev without prices.
    stripe_price_pass_id: str = Field(
        default="",
        description="Stripe Price ID for the $4.99 / 24-hour pass (price_1xxx)",
    )
    stripe_price_monthly_id: str = Field(
        default="",
        description="Stripe Price ID for the $14.99 / monthly plan (price_1xxx)",
    )

    # ── Pydantic v2 model config ───────────────────────────────────────────────
    # env_file tells BaseSettings to load .env automatically.
    # extra="ignore" means unknown env vars don't cause a validation error —
    # handy when the host has unrelated variables set.
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """
    Returns a cached singleton Settings instance.

    @lru_cache means we only parse environment variables once, no matter how
    many times get_settings() is called throughout the app.  In tests, call
    get_settings.cache_clear() to force a fresh read.
    """
    return Settings()  # type: ignore[call-arg]
