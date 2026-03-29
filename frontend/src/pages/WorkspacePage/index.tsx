// PRD §4 — Sandwich UI Protocol — Route: /workspace (protected)

const style: React.CSSProperties = {
  padding: '48px',
  color: '#f3f4f6',
  fontFamily: 'system-ui, sans-serif',
}

export default function WorkspacePage() {
  return (
    <div style={style}>
      <h1 style={{ fontSize: '48px', margin: '0 0 8px', color: '#60a5fa' }}>
        Workspace
      </h1>
      <p style={{ color: '#9ca3af' }}>
        Route: /workspace?mode=resume|interview|cover-letter — protected, requires auth
      </p>
      <p style={{ marginTop: '16px', color: '#6b7280', fontSize: '14px' }}>
        Scaffold only — ResumePanel, SandwichDiffInline, MacCoachingPanel come next.
      </p>
    </div>
  )
}
