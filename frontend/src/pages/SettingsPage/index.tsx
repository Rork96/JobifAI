/**
 * SettingsPage — Route: /settings  (protected)
 * PRD §6 — Settings, Privacy & Localization
 * TODO Phase 2: BYOK key field, language prefs, data privacy controls, billing portal.
 */
import DevNav from '@/shared/ui/DevNav';

export default function SettingsPage() {
  return (
    <div style={{ paddingTop: '56px', minHeight: '100vh', background: '#fdf4ff' }}>
      <DevNav />
      <div style={{ padding: '48px 32px', maxWidth: '720px', margin: '0 auto' }}>
        <h1 style={{
          fontSize: '48px', fontWeight: 900, color: '#0f172a',
          borderLeft: '6px solid #a855f7', paddingLeft: '16px',
          marginBottom: '24px',
        }}>
          Settings
        </h1>
        <p style={{ color: '#475569', fontSize: '18px', lineHeight: 1.6 }}>
          <strong>Route:</strong> <code>/settings</code> — Protected (JWT required)
        </p>
        <p style={{ color: '#475569', fontSize: '16px', marginTop: '12px' }}>
          Phase 2 sections: BYOK Gemini key (session-only, never DB) ·
          UI + resume language prefs · data privacy / account deletion ·
          Stripe billing portal link.
        </p>
        <div style={{
          marginTop: '32px', padding: '16px', borderRadius: '8px',
          background: '#f3e8ff', border: '1px solid #d8b4fe',
          fontSize: '14px', color: '#6b21a8',
        }}>
          🔑 <strong>BYOK rule (PRD §1.4):</strong> <code>useChatStore.byokApiKey</code> is
          stored in Zustand only — never persisted to DB, never sent to Supabase.
          Bypasses all server-side quota when set.
        </div>
      </div>
    </div>
  );
}
