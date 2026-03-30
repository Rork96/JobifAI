/**
 * DevNav — temporary dev-only navigation bar
 * Delete this file (and its imports) before shipping Phase 2 UI.
 */
import { Link, useLocation } from 'react-router-dom';

const LINKS = [
  { to: '/',                    label: '/ Landing'   },
  { to: '/dashboard',           label: '/dashboard'  },
  { to: '/workspace?mode=resume', label: '/workspace'  },
  { to: '/settings',            label: '/settings'   },
  { to: '/paywall',             label: '/paywall'    },
];

export default function DevNav() {
  const { pathname } = useLocation();

  return (
    <nav style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: '#0f172a', borderBottom: '2px solid #6366f1',
      display: 'flex', gap: '4px', padding: '8px 16px', alignItems: 'center',
      fontFamily: 'monospace', fontSize: '13px',
    }}>
      <span style={{ color: '#94a3b8', marginRight: '8px', fontWeight: 'bold' }}>
        🧭 DEV NAV
      </span>
      {LINKS.map(({ to, label }) => {
        const active = pathname === to.split('?')[0];
        return (
          <Link
            key={to}
            to={to}
            style={{
              padding: '4px 12px',
              borderRadius: '4px',
              textDecoration: 'none',
              background: active ? '#6366f1' : '#1e293b',
              color:      active ? '#fff'    : '#93c5fd',
              border: `1px solid ${active ? '#6366f1' : '#334155'}`,
              transition: 'all 0.15s',
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
