// PRD §3 — Central Hub — Route: /dashboard (protected)

const style: React.CSSProperties = {
  padding: '48px',
  color: '#f3f4f6',
  fontFamily: 'system-ui, sans-serif',
}

export default function DashboardPage() {
  return (
    <div style={style}>
      <h1 style={{ fontSize: '48px', margin: '0 0 8px', color: '#34d399' }}>
        Dashboard
      </h1>
      <p style={{ color: '#9ca3af' }}>Route: /dashboard — protected, requires auth</p>
      <p style={{ marginTop: '16px', color: '#6b7280', fontSize: '14px' }}>
        Scaffold only — ContextBar, ActionCards, HardcoreToggle, RecentSessions come next.
      </p>
    </div>
  )
}
