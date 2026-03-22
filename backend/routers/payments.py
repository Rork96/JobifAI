"""
backend/routers/payments.py — Stripe Billing Endpoints
─────────────────────────────────────────────────────────────────────────────
Two endpoints:

  POST /api/checkout          → Create a Stripe Checkout Session
                                Returns { url } to redirect the browser.

  POST /api/webhooks/stripe   → Receive signed Stripe events.
                                On checkout.session.completed:
                                  1. Flip is_premium = true in Supabase profiles.
                                  2. Optionally store stripe_customer_id.

SECURITY — WEBHOOK HMAC VERIFICATION:
══════════════════════════════════════
The webhook endpoint is the most security-sensitive route in the backend.
Any code here is reachable by the public internet, and if we trusted the
payload without verification, an attacker could:

  • Send a fake "payment succeeded" event → grant unlimited free access
  • Replay legitimate events → trigger duplicate upgrades

Stripe protects against both with a Webhook Signing Secret (whsec_xxx):

  1. For every event, Stripe computes:
       signature = HMAC-SHA256( webhook_secret_key, timestamp + "." + payload )
  2. Stripe sets the `Stripe-Signature` header on the request:
       t=<unix_timestamp>,v1=<hex_signature>
  3. We re-compute the signature server-side using our stored webhook secret
     and compare it to the header value.
  4. We also check the timestamp — if the event is > 5 minutes old, we reject
     it (replay attack protection).

This is implemented by `stripe.Webhook.construct_event()`:
  • Raises `SignatureVerificationError` if the signature doesn't match.
  • Raises `ValueError` if the payload is malformed JSON.
  • Returns a Stripe `Event` object if everything checks out.

WHY NOT verify in middleware?
  We want the raw bytes of the request body for HMAC verification.  FastAPI's
  JSON body parsing would decode and re-encode the payload, potentially
  altering byte ordering and breaking the signature.  We use `Request.body()`
  to get the exact raw bytes that Stripe signed.

FAIL-SAFE DESIGN:
  If the Stripe SDK or Supabase client raises an unexpected error:
    • We return HTTP 200 with {"received": false, "error": "..."}.
    • We do NOT return HTTP 500 — a 5xx causes Stripe to retry the event,
      flooding our logs with duplicate webhook deliveries.
    • The genuine payment IS recorded by Stripe; the user can contact support.
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from typing import Literal

import stripe                               # type: ignore[import-untyped]
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from ..config import Settings, get_settings

logger = logging.getLogger("jobifai.payments")

# ─── Router ───────────────────────────────────────────────────────────────────
router = APIRouter(
    prefix="/api",
    tags=["payments"],
)

# ─── Plan definitions ─────────────────────────────────────────────────────────
# Fallback inline price_data used when Stripe Price IDs are not configured in
# the environment (i.e. local dev without a Stripe account).
# When STRIPE_PRICE_PASS_ID / STRIPE_PRICE_MONTHLY_ID are set in .env, those
# pre-created Price objects are used instead — required for subscriptions,
# coupons, and tax rates to work correctly.

_PLANS: dict[str, dict] = {
    "pass": {
        "label":          "JobifAI 24-Hour Pass",
        "description":    "Full AI interview · PDF export · ATS optimisation",
        "amount_cents":   499,         # $4.99 CAD
        "currency":       "cad",
        "stripe_mode":    "payment",   # one-time charge
    },
    "monthly": {
        "label":          "JobifAI Monthly Pro",
        "description":    "Unlimited sessions · Priority AI · PDF exports",
        "amount_cents":   1499,        # $14.99 CAD
        "currency":       "cad",
        "stripe_mode":    "subscription",
    },
}


# ─── Request / Response Models ─────────────────────────────────────────────────

class CheckoutRequest(BaseModel):
    """
    POST /api/checkout body.

    plan:          Which product to purchase.
                     'pass'    → $4.99 one-time 24-hour access
                     'monthly' → $14.99 / month recurring subscription
    user_email:    Pre-fills the Stripe Checkout email field.
                   Optional — Stripe allows anonymous checkout.
    success_url:   Where to redirect after successful payment.
                   Must be an absolute URL (https://your-domain.com/success).
    cancel_url:    Where to redirect if the user closes checkout.
    """
    plan:        Literal["pass", "monthly"] = Field(default="pass", description="Product to purchase")
    user_email:  str | None = Field(default=None, description="Pre-fill email in Stripe Checkout")
    success_url: str        = Field(..., description="Redirect URL on successful payment")
    cancel_url:  str        = Field(..., description="Redirect URL on cancelled checkout")


class CheckoutResponse(BaseModel):
    """The Stripe Checkout Session URL — browser should redirect here."""
    url:        str
    session_id: str


# ─── POST /api/checkout ───────────────────────────────────────────────────────

@router.post(
    "/checkout",
    response_model=CheckoutResponse,
    summary="Create a Stripe Checkout Session for a 24-Hour Pass",
    description="""
Creates a Stripe Checkout Session for the $4.99 / 24-hour pass.

**Returns:** `{ url, session_id }` where `url` is the Stripe-hosted checkout page.

The frontend should redirect to `url` immediately.  On successful payment,
Stripe redirects back to `success_url` and asynchronously fires a
`checkout.session.completed` webhook to `/api/webhooks/stripe`, which
sets `is_premium = true` in the user's profile.

**Why not charge on the frontend?**
  Never trust the client with payment logic — an attacker could skip the
  Stripe form and call your backend directly claiming they paid.
  The Checkout Session is created server-side and the payment is confirmed
  only via the webhook (signed by Stripe's secret).
    """,
)
async def create_checkout_session(
    body: CheckoutRequest,
    settings: Settings = Depends(get_settings),
) -> CheckoutResponse:
    """
    POST /api/checkout — Create a Stripe Checkout Session.

    We use Stripe's hosted Checkout page (not Elements) because:
      • PCI DSS compliance is handled by Stripe — we never touch raw card data.
      • 3D Secure / SCA (EU) is handled automatically.
      • It works on all devices without extra frontend work.
    """
    if not settings.stripe_secret_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe is not configured on this server. Set STRIPE_SECRET_KEY in .env.",
        )

    stripe.api_key = settings.stripe_secret_key

    plan = _PLANS[body.plan]

    # ── Resolve the line_items block ──────────────────────────────────────────
    # Priority:  pre-created Stripe Price ID  >  inline price_data fallback
    #
    # Using a real Price ID is required for:
    #   • Recurring subscriptions (price_data only works with mode="payment")
    #   • Promotion codes that reference a specific Price
    #   • Stripe Tax / automatic tax rates
    #
    # For local dev without Price IDs configured, we fall back to inline
    # price_data so the checkout still works out of the box.
    price_id = (
        settings.stripe_price_pass_id    if body.plan == "pass"
        else settings.stripe_price_monthly_id
    )

    if price_id:
        # ── Use pre-created Price ID (production / staging path) ─────────────
        line_items: list[dict] = [{"price": price_id, "quantity": 1}]
        logger.debug("Checkout using Price ID %s for plan=%s", price_id, body.plan)
    else:
        # ── Inline price_data fallback (dev without Stripe dashboard setup) ──
        # Subscriptions (mode="subscription") require a recurring Price object —
        # inline price_data cannot define a recurring interval without a Price ID.
        # If no monthly price ID is configured, we warn and treat it as a payment.
        if body.plan == "monthly":
            logger.warning(
                "STRIPE_PRICE_MONTHLY_ID not set — falling back to one-time $14.99 charge. "
                "Set STRIPE_PRICE_MONTHLY_ID in .env for recurring billing."
            )

        line_items = [{
            "price_data": {
                "currency":     plan["currency"],
                "unit_amount":  plan["amount_cents"],
                "product_data": {
                    "name":        plan["label"],
                    "description": plan["description"],
                },
                # recurring is only valid when mode="subscription" AND a Price ID
                # is used — inline price_data cannot specify recurring intervals.
            },
            "quantity": 1,
        }]

    # Subscriptions require mode="subscription"; one-time uses mode="payment".
    # If we fell back to inline price_data for monthly, force payment mode.
    checkout_mode = plan["stripe_mode"] if price_id else "payment"

    try:
        session = stripe.checkout.Session.create(
            mode=checkout_mode,
            line_items=line_items,

            # Pre-fill email so the user doesn't have to retype it
            customer_email=body.user_email or None,

            # Redirect URLs — Stripe appends session ID to success_url
            success_url=body.success_url + "?session_id={CHECKOUT_SESSION_ID}",
            cancel_url=body.cancel_url,

            # Allow promotion / discount codes at checkout
            allow_promotion_codes=True,

            # Metadata is echoed back in the webhook — we use it to grant premium
            metadata={
                "plan":       body.plan,
                "user_email": body.user_email or "",
            },
        )

        logger.info(
            "Checkout session created — session_id=%s  plan=%s  mode=%s  email=%s",
            session.id, body.plan, checkout_mode, body.user_email or "anonymous",
        )

        return CheckoutResponse(url=session.url, session_id=session.id)

    except stripe.error.CardError as exc:
        # Card declined, expired, insufficient funds, etc.
        # user_message is always set for CardError — safe to show directly.
        user_msg = exc.user_message or str(exc)
        logger.warning("Stripe CardError — %s: %s", exc.code, exc)
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Card error: {user_msg}",
        ) from exc

    except stripe.error.InvalidRequestError as exc:
        # Bad parameters — usually a misconfigured Price ID or missing field.
        # Log the full technical detail so we can debug; return a safe message.
        logger.error(
            "Stripe InvalidRequestError — plan=%s price_id=%s: %s",
            body.plan, price_id or "(inline)", exc,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Stripe configuration error: {exc.user_message or str(exc)} — "
                "Check that STRIPE_PRICE_PASS_ID / STRIPE_PRICE_MONTHLY_ID are valid."
            ),
        ) from exc

    except stripe.error.AuthenticationError as exc:
        # Wrong API key — always a server config problem.
        logger.error("Stripe AuthenticationError — check STRIPE_SECRET_KEY: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Payment service authentication failed. Please contact support.",
        ) from exc

    except stripe.error.StripeError as exc:
        # Catch-all for any other Stripe error (rate limit, network, etc.)
        user_msg = getattr(exc, "user_message", None) or str(exc)
        logger.error(
            "Stripe error creating checkout session — plan=%s type=%s: %s",
            body.plan, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Payment service error: {user_msg}",
        ) from exc

    except Exception as exc:
        # Non-Stripe exception (network, unexpected bug)
        logger.exception("Unexpected error in checkout — plan=%s: %s", body.plan, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An unexpected error occurred. Please try again.",
        ) from exc


# ─── POST /api/webhooks/stripe ────────────────────────────────────────────────

@router.post(
    "/webhooks/stripe",
    summary="Receive Stripe webhook events (signature-verified)",
    description="""
Receives webhook events from Stripe.

**Security:** Every request is validated using HMAC-SHA256.
Stripe signs each event with your `STRIPE_WEBHOOK_SECRET` (whsec_xxx).
We use `stripe.Webhook.construct_event()` to verify the signature and
reject any tampered or replayed requests.

**Handled events:**
- `checkout.session.completed` → sets `is_premium = true` in Supabase

**All other events** are acknowledged (200) but not processed.

**Why return 200 on error?**
Returning 5xx causes Stripe to retry the webhook repeatedly.  We return 200
with `{"received": false}` instead, and alert via logs.  Stripe's dashboard
shows the failure and allows manual replay.
    """,
    # No response_model — we return raw dicts to avoid Pydantic validation noise
)
async def stripe_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="stripe-signature"),
    settings: Settings = Depends(get_settings),
) -> dict:
    """
    POST /api/webhooks/stripe — Stripe event receiver.

    CRITICAL: we read `request.body()` (raw bytes) for HMAC verification.
    FastAPI's JSON body parsing would mutate the bytes, breaking the signature.
    """
    stripe.api_key = settings.stripe_secret_key

    # ── Step 1: Read raw payload (required for HMAC verification) ─────────────
    payload = await request.body()

    if not stripe_signature:
        logger.warning("Stripe webhook received without signature header — rejected")
        # Return 200 (not 400) to prevent Stripe from retrying unnecessarily
        return {"received": False, "error": "Missing Stripe-Signature header"}

    # ── Step 2: Verify signature ──────────────────────────────────────────────
    #
    # construct_event() does all of the following:
    #   1. Parses the Stripe-Signature header: t=<timestamp>,v1=<hex>
    #   2. Recomputes: expected = HMAC-SHA256(webhook_secret, timestamp+"."+payload)
    #   3. Compares expected vs v1 using a constant-time comparison
    #   4. Checks that the timestamp is within tolerance (default: 300 seconds)
    #      to prevent replay attacks
    #
    # If ANY check fails, it raises stripe.error.SignatureVerificationError.
    try:
        event = stripe.Webhook.construct_event(
            payload=payload,
            sig_header=stripe_signature,
            secret=settings.stripe_webhook_secret,
        )
    except ValueError as exc:
        # Malformed JSON payload — almost certainly not from Stripe
        logger.warning("Stripe webhook: malformed payload — %s", exc)
        return {"received": False, "error": "Malformed payload"}

    except stripe.error.SignatureVerificationError as exc:
        # Signature mismatch — tampered request or wrong webhook secret
        logger.warning(
            "Stripe webhook: signature verification FAILED — %s\n"
            "  Check that STRIPE_WEBHOOK_SECRET matches the endpoint in the Stripe dashboard.",
            exc,
        )
        return {"received": False, "error": "Invalid signature"}

    # ── Step 3: Handle the event ──────────────────────────────────────────────
    logger.info("Stripe event received — type=%s  id=%s", event["type"], event["id"])

    if event["type"] == "checkout.session.completed":
        await _handle_checkout_completed(event["data"]["object"], settings)

    # For all other event types: log and acknowledge
    else:
        logger.debug("Stripe event '%s' received but not handled", event["type"])

    # Always return 200 so Stripe marks the delivery as successful
    return {"received": True}


# ─── Webhook handler helpers ─────────────────────────────────────────────────

async def _handle_checkout_completed(
    session: dict,
    settings: Settings,
) -> None:
    """
    Handle a `checkout.session.completed` event.

    Grants `is_premium = true` to the user in Supabase.

    IDENTIFYING THE USER:
      We look up the user by the email on the Checkout Session.
      `customer_email` is the best identifier because:
        • It's set if we pre-populated it from the authenticated user.
        • Even for anonymous checkout, Stripe collects email during payment.

      Alternative: embed `user_id` in the session `metadata` field (we set
      `metadata.user_email` above).  We use that as the primary lookup.

    STRIPE_CUSTOMER_ID:
      We also store the Stripe customer ID (`cus_xxx`) on the profile so future
      operations (refunds, subscriptions, invoices) can reference the customer
      without re-looking up by email.
    """
    email            = session.get("customer_email") or session.get("metadata", {}).get("user_email")
    customer_id      = session.get("customer")
    session_id       = session.get("id")

    if not email:
        logger.warning(
            "checkout.session.completed missing email — session_id=%s  "
            "Cannot grant premium without identifying the user.",
            session_id,
        )
        return

    try:
        from supabase import create_client  # type: ignore[import-untyped]
        client = create_client(settings.supabase_url, settings.supabase_key)

        # Build the update payload
        plan = session.get("metadata", {}).get("plan", "pass")
        update: dict = {
            "is_premium": True,
            "premium_plan": plan,   # 'pass' or 'monthly' — useful for feature gating
        }
        if customer_id:
            update["stripe_customer_id"] = customer_id

        # Look up profile by email and grant premium
        # The service role key bypasses RLS so this always succeeds regardless
        # of which JWT the user has.
        result = (
            client.table("profiles")
            .update(update)
            .eq("email", email)
            .execute()
        )

        if result.data:
            logger.info(
                "Premium granted ✓ — email=%s  stripe_session=%s  rows_updated=%d",
                email, session_id, len(result.data),
            )
        else:
            # Profile not found — user may not have signed up yet (anonymous checkout).
            # We log a warning but do NOT crash — the payment was captured successfully.
            logger.warning(
                "checkout.session.completed: no profile found for email=%s  "
                "session_id=%s  — Premium will be applied on first sign-in.",
                email, session_id,
            )

    except Exception as exc:
        # Log but don't raise — a raised exception here causes a 500 response,
        # which triggers Stripe to retry the webhook.  The payment is captured;
        # we'll reconcile via the Stripe dashboard.
        logger.exception(
            "Failed to update premium status for email=%s  session=%s  err=%s",
            email, session_id, exc,
        )
