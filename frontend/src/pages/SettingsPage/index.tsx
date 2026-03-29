// PRD §6 — Settings, Privacy & Localization — Route: /settings (protected)

const style: React.CSSProperties = {
  padding: '48px',
  color: '#f3f4f6',
  fontFamily: 'system-ui, sans-serif',
}

export default function SettingsPage() {
  return (
    <div style={style}>
      <h1 style={{ fontSize: '48px', margin: '0 0 8px', color: '#fb923c' }}>
        Settings
      </h1>
      <p style={{ color: '#9ca3af' }}>Route: /settings — protected, requires auth</p>
      <p style={{ marginTop: '16px', color: '#6b7280', fontSize: '14px' }}>
        Scaffold only — BYOK key input, language preferences, data export come next.
      </p>
    </div>
  )
}
