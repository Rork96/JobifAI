/**
 * PaywallPage — Route: /paywall  (public)
 * PRD §1.4 — Freemium limits & pricing
 * TODO Phase 2: pricing cards, Stripe Checkout CTAs, BYOK callout.
 */
import DevNav from '@/shared/ui/DevNav';

export default function PaywallPage() {
  return (
    <div style={{ paddingTop: '56px', minHeight: '100vh', background: '#fff7ed' }}>
      <DevNav />
      <div style={{ padding: '48px 32px', maxWidth: '720px', margin: '0 auto' }}>
        <h1 style={{
          fontSize: '48px', fontWeight: 900, color: '#0f172a',
          borderLeft: '6px solid #f97316', paddingLeft: '16px',
          marginBottom: '24px',
        }}>
          Paywall / Pricing
        </h1>
        <p style={{ color: '#475569', fontSize: '18px', lineHeight: 1.6 }}>
          <strong>Route:</strong> <code>/paywall</code> — Public
        </p>
        <p style={{ color: '#475569', fontSize: '16px', marginTop: '12px' }}>
          Phase 2 will render: Free vs 24-hr Pass ($4.99) vs Monthly ($14.99) ·
          Stripe Checkout CTA · BYOK "use your own key, free forever" callout.
        </p>
        <div style={{
          marginTop: '32px', padding: '16px', borderRadius: '8px',
          background: '#ffedd5', border: '1px solid #fdba74',
          fontSize: '14px', color: '#9a3412',
        }}>
          🚫 <strong>Server is authoritative (PRD §1.4):</strong> Frontend counters in
          <code> useBillingStore</code> are display-only. <code>check_action_limit</code> FastAPI
          dependency is the enforcement gate — it cannot be bypassed by client state.
        </div>
      </div>
    </div>
  );
}
