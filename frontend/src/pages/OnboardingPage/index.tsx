/**
 * OnboardingPage — Route: /onboarding  (protected)
 * Post-auth context capture placeholder.
 * TODO Phase 2: implement if a dedicated post-auth onboarding route is needed.
 */
import DevNav from '@/shared/ui/DevNav';

export default function OnboardingPage() {
  return (
    <div style={{ paddingTop: '56px', minHeight: '100vh', background: '#f0f9ff' }}>
      <DevNav />
      <div style={{ padding: '48px 32px', maxWidth: '720px', margin: '0 auto' }}>
        <h1 style={{
          fontSize: '48px', fontWeight: 900, color: '#0f172a',
          borderLeft: '6px solid #0ea5e9', paddingLeft: '16px',
          marginBottom: '24px',
        }}>
          Onboarding
        </h1>
        <p style={{ color: '#475569', fontSize: '18px', lineHeight: 1.6 }}>
          <strong>Route:</strong> <code>/onboarding</code> — Protected (JWT required)
        </p>
        <p style={{ color: '#475569', fontSize: '16px', marginTop: '12px' }}>
          Reserved for post-auth profile setup. Primary onboarding (CV + JD upload → ATS score)
          lives on <code>/</code> and is intentionally anonymous-first (PRD §2).
        </p>
      </div>
    </div>
  );
}
