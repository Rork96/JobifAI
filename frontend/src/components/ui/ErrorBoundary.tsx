/**
 * ErrorBoundary — Global Crash Net
 * ─────────────────────────────────────────────────────────────────────────────
 * Catches any unhandled React render error in the subtree and renders a
 * bright red full-screen panel instead of an invisible blank page.
 *
 * React error boundaries MUST be class components — hooks cannot implement
 * getDerivedStateFromError / componentDidCatch.
 *
 * Usage (main.tsx):
 *   <ErrorBoundary><App /></ErrorBoundary>
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, componentStack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('❌ [ErrorBoundary] FATAL REACT CRASH:', error);
    console.error('❌ [ErrorBoundary] Component stack:', info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: '#7f1d1d', color: '#fff',
          fontFamily: 'monospace', padding: '2.5rem',
          overflowY: 'auto',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1rem' }}>
          ❌ FATAL REACT CRASH — ErrorBoundary caught an error
        </h1>

        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem', color: '#fca5a5' }}>
          Error
        </h2>
        <pre
          style={{
            background: '#991b1b', padding: '1rem', borderRadius: '0.5rem',
            marginBottom: '1.5rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            fontSize: '0.8rem',
          }}
        >
          {this.state.error?.toString() ?? 'Unknown error'}
        </pre>

        {this.state.componentStack && (
          <>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem', color: '#fca5a5' }}>
              Component Stack
            </h2>
            <pre
              style={{
                background: '#991b1b', padding: '1rem', borderRadius: '0.5rem',
                marginBottom: '1.5rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                fontSize: '0.75rem', opacity: 0.85,
              }}
            >
              {this.state.componentStack}
            </pre>
          </>
        )}

        <button
          onClick={() => window.location.href = '/'}
          style={{
            background: '#dc2626', border: 'none', color: '#fff',
            padding: '0.6rem 1.5rem', borderRadius: '0.5rem',
            fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
            marginRight: '1rem',
          }}
        >
          ← Reload App
        </button>
        <button
          onClick={() => this.setState({ hasError: false, error: null, componentStack: null })}
          style={{
            background: 'transparent', border: '1px solid #fca5a5', color: '#fca5a5',
            padding: '0.6rem 1.5rem', borderRadius: '0.5rem',
            fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
          }}
        >
          Try to recover
        </button>
      </div>
    );
  }
}
