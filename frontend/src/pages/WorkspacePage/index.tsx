/**
 * WorkspacePage — Route: /workspace?mode=resume|interview|cover
 * ─────────────────────────────────────────────────────────────────────────────
 * PRD §4 — Sandwich UI Protocol
 *
 * The Workspace is the surgery room. Three modes share the same two-column
 * layout (Resume Panel + Mac Coaching Panel); only the action panel content
 * and active API endpoints change.
 *
 * Mode routing (PRD §4.8):
 *   ?mode=resume    → Resume Fix (magic rewrite, sandwich diffs)
 *   ?mode=interview → Interview Coach (SSE stream, turn-based)
 *   ?mode=cover     → Cover Letter (generation + inline edit)
 *
 * On-mount:
 *   Read URL param → useSessionStore.setWorkspaceMode(mode)
 *
 * NON-NEGOTIABLE: The Sandwich UI is mandatory for all resume editing.
 * Any implementation that shows AI suggestions as a disconnected list,
 * sidebar, modal, or separate tab is a v1 regression. Reject at code review.
 * See PRD §4.1 for the mandate.
 *
 * Required UI sections (Phase 2 implementation):
 *   Left panel  — Resume Panel: structured editable resume + SandwichDiffInline
 *   Right panel — Mac Coaching Panel: MacMascot + coaching copy + keyword chips
 *   Navbar      — [← Dashboard] + ATS score preview (before → after)
 *
 * Mobile (< 768px):
 *   Coaching panel appears ABOVE resume panel.
 *   Coaching panel collapses to 40vh bottom drawer with drag handle.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSessionStore } from '@/store/useSessionStore';

type WorkspaceMode = 'resume' | 'interview' | 'cover';

const VALID_MODES: WorkspaceMode[] = ['resume', 'interview', 'cover'];

function isValidMode(m: string | null): m is WorkspaceMode {
  return VALID_MODES.includes(m as WorkspaceMode);
}

export default function WorkspacePage() {
  const [searchParams] = useSearchParams();
  const setWorkspaceMode = useSessionStore((s) => s.setWorkspaceMode);

  // Hydrate workspaceMode from URL param on mount (PRD §4.8)
  useEffect(() => {
    const modeParam = searchParams.get('mode');
    setWorkspaceMode(isValidMode(modeParam) ? modeParam : 'resume');
  }, [searchParams, setWorkspaceMode]);

  return (
    <main>
      {/* TODO Phase 2: implement full workspace per PRD §4 */}
      <h1>WorkspacePage — placeholder</h1>
    </main>
  );
}
