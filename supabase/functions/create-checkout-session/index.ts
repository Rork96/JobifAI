/**
 * create-checkout-session — Supabase Edge Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates a Stripe Checkout Session and returns the redirect URL.
 *
 * Called by:  useBillingStore.startCheckout()
 * Request:    POST  { priceId: string, returnUrl: string }
 * Response:   { url: string }    — Stripe hosted checkout URL
 *
 * Security model:
 *   - JWT from Authorization header is verified via supabase.auth.getUser().
 *   - user.id from Supabase is set as client_reference_id — NEVER from body.
 *     This is the critical link used by the Phase 12.6 webhook to grant premium.
 *   - priceId comes from body (safe — it's a public Stripe identifier).
 *
 * Env vars (set via `supabase secrets set KEY=value`):
 *   STRIPE_SECRET_KEY   — sk_test_… or sk_live_…
 *   SUPABASE_URL        — injected automatically by the Edge runtime
 *   SUPABASE_ANON_KEY   — injected automatically by the Edge runtime
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { serve }        from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe           from 'https://esm.sh/stripe@14.14.0';

// ── CORS headers ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── JSON response helper ──────────────────────────────────────────────────────
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Request body shape ────────────────────────────────────────────────────────
interface CheckoutRequest {
  priceId:   string;
  returnUrl: string;
  /**
   * Stripe Checkout mode.
   *   'subscription' — recurring billing (Pro monthly plan)
   *   'payment'      — one-time charge (24-Hour Pass)
   * Defaults to 'subscription' if omitted (safe backwards-compat default).
   */
  mode?: 'subscription' | 'payment';
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    // ── Step 1: Verify the caller is a signed-in Supabase user ───────────────
    // We NEVER trust a user_id from the request body — we read it from the
    // validated JWT. This value becomes client_reference_id in Stripe and is
    // the critical link used by the Phase 12.6 webhook to grant premium access.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Missing Authorization header' }, 401);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      console.error('[checkout] Auth failed:', authError?.message ?? 'no user');
      return json({ error: 'Unauthorized' }, 401);
    }

    // ── Step 2: Parse and validate the request body ───────────────────────────
    const body: CheckoutRequest = await req.json();
    const { priceId, returnUrl, mode = 'subscription' } = body;

    if (!priceId || !returnUrl) {
      return json({ error: 'priceId and returnUrl are required' }, 400);
    }

    // Guard against invalid mode values being passed from the client.
    if (mode !== 'subscription' && mode !== 'payment') {
      return json({ error: `Invalid mode: "${mode}". Must be "subscription" or "payment".` }, 400);
    }

    console.log(`[checkout] user=${user.id} email=${user.email} priceId=${priceId} mode=${mode}`);

    // ── Step 3: Validate the STRIPE_SECRET_KEY is present ────────────────────
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      console.error('[checkout] STRIPE_SECRET_KEY env var is not set');
      return json({ error: 'Stripe is not configured on this server' }, 503);
    }

    // ── Step 4: Create the Stripe Checkout Session ────────────────────────────
    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],

      // customer_email pre-fills the Stripe form — reduces friction.
      customer_email: user.email,

      // client_reference_id is the SECURE link back to our user.
      // Phase 12.6 webhook reads this to know which Supabase user to upgrade.
      // MUST come from the verified JWT — never from the request body.
      client_reference_id: user.id,

      line_items: [{ price: priceId, quantity: 1 }],

      // mode comes from the request body:
      //   'subscription' — Pro monthly plan (recurring)
      //   'payment'      — 24-Hour Pass (one-time charge)
      // Both price IDs must be created with the matching mode in Stripe Dashboard.
      mode,

      success_url: `${returnUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${returnUrl}?checkout=canceled`,

      // Store the user id in metadata too — redundancy for the webhook.
      metadata: { supabase_user_id: user.id },
    });

    if (!session.url) {
      console.error('[checkout] Stripe returned a session with no URL');
      return json({ error: 'Stripe session created but no checkout URL returned' }, 502);
    }

    console.log(`[checkout] Session created: ${session.id} → ${session.url}`);

    return json({ url: session.url });

  } catch (err) {
    // Stripe SDK throws typed errors — surface the message for easier debugging.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[checkout] Unhandled error:', msg);
    return json({ error: `Checkout failed: ${msg}` }, 500);
  }
});
