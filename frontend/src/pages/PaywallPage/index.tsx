/**
 * PaywallPage — Route: /paywall
 * ─────────────────────────────────────────────────────────────────────────────
 * Rarely navigated to directly — the primary paywall experience is a modal
 * (PaywallModal from features/billing/ui). This route exists for:
 *   - Direct links (e.g. from email campaigns)
 *   - SEO / pricing page
 *   - Stripe return URL fallback
 *
 * Freemium limits (PRD §1.4 — server-side authoritative):
 *   Free:    3 magic rewrites, 1 interview session
 *   Premium: unlimited (pass $4.99/24h or monthly $14.99)
 *
 * Required UI sections (Phase 2 implementation):
 *   - Pricing cards: Free vs 24-hr Pass vs Monthly
 *   - Stripe Checkout CTA for each paid tier
 *   - Feature comparison table
 *   - BYOK callout: "Have your own Gemini key? Use it free, forever."
 * ─────────────────────────────────────────────────────────────────────────────
 */

export default function PaywallPage() {
  return (
    <main>
      {/* TODO Phase 2: implement paywall / pricing page */}
      <h1>PaywallPage — placeholder</h1>
    </main>
  );
}
