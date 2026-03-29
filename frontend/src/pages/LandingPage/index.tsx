// PRD §2 — Soft-Gate Onboarding — Route: /

const style: React.CSSProperties = {
  padding: '48px',
  color: '#f3f4f6',
  fontFamily: 'system-ui, sans-serif',
}

export default function LandingPage() {
  return (
    <div style={style}>
      <h1 style={{ fontSize: '48px', margin: '0 0 8px', color: '#c084fc' }}>
        Landing Page
      </h1>
      <p style={{ color: '#9ca3af' }}>Route: / — public, no auth required</p>
      <p style={{ marginTop: '16px', color: '#6b7280', fontSize: '14px' }}>
        Scaffold only — CV upload zone, JD textarea, ATS score panel, soft-gate CTAs come next.
      </p>
    </div>
  )
}
