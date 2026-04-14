/**
 * stripe-webhook — Supabase Edge Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 12.6 — Stripe event handler.
 * Verifies the Stripe webhook signature then updates the `profiles` table so
 * the frontend can read premium status on the next session hydration.
 *
 * Handled events:
 *   checkout.session.completed   → grant premium (subscription OR one-time pass)
 *   customer.subscription.updated → sync subscription_status, period_end, etc.
 *   customer.subscription.deleted → revoke premium
 *
 * Security model:
 *   - Stripe signature is ALWAYS verified before touching the DB.
 *     An invalid signature returns 400 immediately.
 *   - DB writes use the service-role key (SUPABASE_SERVICE_ROLE_KEY) which
 *     bypasses RLS — this is intentional.  The webhook acts as a trusted server
 *     process, not as the user.
 *   - user.id is read ONLY from client_reference_id (set by create-checkout-session
 *     from the verified JWT — never from the request body).  This prevents a
 *     forged webhook from granting premium to an arbitrary user.
 *
 * Env vars (set via `supabase secrets set KEY=value`):
 *   STRIPE_SECRET_KEY          — sk_test_… or sk_live_…
 *   STRIPE_WEBHOOK_SECRET      — whsec_… from Stripe Dashboard → Webhooks
 *   SUPABASE_URL               — injected automatically by Edge runtime
 *   SUPABASE_SERVICE_ROLE_KEY  — NOT auto-injected; must be set manually
 *   SUPABASE_ANON_KEY          — injected automatically (not used here)
 *
 * Register endpoint in Stripe Dashboard:
 *   Local:  http://localhost:54321/functions/v1/stripe-webhook
 *   Prod:   https://<project>.supabase.co/functions/v1/stripe-webhook
 *   Events to send:
 *     checkout.session.completed
 *     customer.subscription.updated
 *     customer.subscription.deleted
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { serve }        from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe           from 'https://esm.sh/stripe@14.14.0';

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(body: unknown = { received: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400): Response {
  return new Response(message, { status });
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return err('Method not allowed', 405);
  }

  // ── 1. Validate env ──────────────────────────────────────────────────────────
  const stripeKey     = Deno.env.get('STRIPE_SECRET_KEY');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const supabaseUrl   = Deno.env.get('SUPABASE_URL');
  const serviceKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!stripeKey || !webhookSecret) {
    console.error('[webhook] Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return err('Stripe not configured on this server', 503);
  }
  if (!supabaseUrl || !serviceKey) {
    console.error('[webhook] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return err('Supabase not configured on this server', 503);
  }

  // ── 2. Verify Stripe signature ───────────────────────────────────────────────
  // constructEventAsync is the Deno-compatible variant (no sync crypto).
  // A mismatch means the payload was tampered with or the secret is wrong.
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return err('Missing stripe-signature header', 400);
  }

  const body = await req.text();   // must read as text BEFORE parsing JSON
  let event: Stripe.Event;

  try {
    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (verifyErr) {
    const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    console.error('[webhook] Signature verification failed:', msg);
    return err(`Webhook signature verification failed: ${msg}`, 400);
  }

  console.log(`[webhook] ✅ Verified event: ${event.type} (id: ${event.id})`);

  // ── 3. Service-role Supabase client ─────────────────────────────────────────
  // This client bypasses RLS — intentional.  We are the trusted billing system,
  // not a user.  We only write the columns the webhook owns.
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

  // ── 4. Route on event type ───────────────────────────────────────────────────
  try {
    switch (event.type) {

      // ── checkout.session.completed ─────────────────────────────────────────
      // Fired once when the customer successfully completes the Stripe Checkout
      // page (card charged, 3DS passed, etc.).
      //
      // client_reference_id is the Supabase user.id — set by create-checkout-session
      // from the verified JWT.  It is the ONLY value we trust for user lookup.
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId  = session.client_reference_id;

        if (!userId) {
          console.error('[webhook] checkout.session.completed: no client_reference_id — cannot identify user');
          // Return 200 so Stripe doesn't retry (we'd fail the same way every time).
          return ok({ received: true, warning: 'no client_reference_id' });
        }

        console.log(`[webhook] checkout.session.completed — userId: ${userId}, mode: ${session.mode}`);

        const patch: Record<string, unknown> = {
          is_premium: true,
          stripe_customer_id: session.customer as string | null,
          updated_at: new Date().toISOString(),
        };

        if (session.mode === 'subscription' && session.subscription) {
          // Monthly Pro — fetch the subscription to populate period fields.
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          patch.subscription_status   = sub.status;                                          // 'active'
          patch.stripe_price_id       = sub.items.data[0]?.price.id ?? null;
          patch.current_period_end    = new Date(sub.current_period_end * 1000).toISOString();
          patch.cancel_at_period_end  = sub.cancel_at_period_end;
        } else {
          // 24-Hour Pass (one-time payment) — mark as active; no period end.
          patch.subscription_status = 'active';
          patch.stripe_price_id     = session.line_items
            ? null   // line_items not expanded by default; price comes from the price ID we stored
            : null;
        }

        const { error: profileErr } = await supabase
          .from('profiles')
          .update(patch)
          .eq('id', userId);

        if (profileErr) {
          console.error('[webhook] ❌ Failed to update profiles for user', userId, ':', profileErr.message);
          // Return 500 so Stripe will retry (this might be a transient DB error).
          return err(`DB update failed: ${profileErr.message}`, 500);
        }

        // Sync the denormalised user_data.is_premium mirror.
        // Non-fatal — profiles.is_premium is the source of truth.
        const { error: udErr } = await supabase
          .from('user_data')
          .update({ is_premium: true })
          .eq('id', userId);

        if (udErr) {
          console.warn('[webhook] ⚠️  user_data.is_premium sync failed (non-fatal):', udErr.message);
        }

        console.log(`[webhook] ✅ Granted premium to user ${userId}`);
        break;
      }

      // ── customer.subscription.updated ─────────────────────────────────────
      // Fired when a subscription transitions state:
      //   trialing → active, active → past_due, active → canceled, etc.
      // Also fired on plan changes, quantity changes, and payment retries.
      case 'customer.subscription.updated': {
        const sub        = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        const isActive   = sub.status === 'active' || sub.status === 'trialing';

        console.log(`[webhook] customer.subscription.updated — customer: ${customerId}, status: ${sub.status}`);

        const { error: updateErr } = await supabase
          .from('profiles')
          .update({
            is_premium:          isActive,
            subscription_status: sub.status,
            stripe_price_id:     sub.items.data[0]?.price.id ?? null,
            current_period_end:  new Date(sub.current_period_end * 1000).toISOString(),
            cancel_at_period_end: sub.cancel_at_period_end,
            updated_at:          new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId);

        if (updateErr) {
          console.error('[webhook] ❌ subscription.updated — DB error for customer', customerId, ':', updateErr.message);
          return err(`DB update failed: ${updateErr.message}`, 500);
        }

        // Sync user_data.is_premium for the affected user.
        if (!isActive) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .maybeSingle();

          if (profile?.id) {
            await supabase
              .from('user_data')
              .update({ is_premium: false })
              .eq('id', profile.id);
          }
        }

        console.log(`[webhook] ✅ Updated subscription for customer ${customerId} → ${sub.status}`);
        break;
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      // Fired when a subscription is permanently cancelled (not just flagged for
      // cancellation at period end — that's subscription.updated with
      // cancel_at_period_end = true).  At this point the user loses access.
      case 'customer.subscription.deleted': {
        const sub        = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;

        console.log(`[webhook] customer.subscription.deleted — customer: ${customerId}`);

        // Fetch the user id BEFORE the update so we can sync user_data.
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();

        const { error: deleteErr } = await supabase
          .from('profiles')
          .update({
            is_premium:          false,
            subscription_status: 'canceled',
            cancel_at_period_end: false,
            current_period_end:  sub.ended_at
              ? new Date(sub.ended_at * 1000).toISOString()
              : null,
            updated_at:          new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId);

        if (deleteErr) {
          console.error('[webhook] ❌ subscription.deleted — DB error for customer', customerId, ':', deleteErr.message);
          return err(`DB update failed: ${deleteErr.message}`, 500);
        }

        if (profile?.id) {
          const { error: udErr } = await supabase
            .from('user_data')
            .update({ is_premium: false })
            .eq('id', profile.id);

          if (udErr) {
            console.warn('[webhook] ⚠️  user_data.is_premium sync failed (non-fatal):', udErr.message);
          }
        }

        console.log(`[webhook] ✅ Revoked premium for customer ${customerId}`);
        break;
      }

      // ── invoice.payment_failed ─────────────────────────────────────────────
      // Optional: Stripe moves the subscription to 'past_due' on its own after
      // a failed payment.  That triggers subscription.updated which we already
      // handle.  We log here for operational visibility only.
      case 'invoice.payment_failed': {
        const invoice    = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        console.warn(`[webhook] ⚠️  invoice.payment_failed — customer: ${customerId}`);
        // No DB change needed — subscription.updated will follow.
        break;
      }

      default:
        // Unhandled event types — acknowledged with 200 so Stripe stops retrying.
        console.log(`[webhook] Unhandled event type (ignored): ${event.type}`);
    }

    return ok();

  } catch (handlerErr) {
    const msg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
    console.error('[webhook] ❌ Unhandled error in event handler:', msg);
    // 500 causes Stripe to retry — appropriate for transient DB or network errors.
    return err(`Webhook handler failed: ${msg}`, 500);
  }
});
