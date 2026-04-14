/**
 * SandwichDiffInline — Phase 5
 * FRONTEND_RULES.md Rule 1: dumb component. Receives props, renders them.
 * Zero state. Zero store access. Zero business logic.
 *
 * Design: Claude (Anthropic) warm parchment system — DESIGN.md
 *   - Container: Ivory (#faf9f5) card, Border Warm (#e8e6dc), 16px radius
 *   - Removed: Error Crimson (#b53333) strikethrough
 *   - Proposed: Near Black (#141413) text, Terracotta (+) marker
 *   - Accept CTA: Terracotta Brand (#c96442), ring shadow
 *   - Reject: Warm Sand (#e8e6dc), Charcoal Warm (#4d4c48) text
 */

interface SandwichDiffInlineProps {
  oldText:  string;
  newText:  string;
  onAccept: () => void;
  onReject: () => void;
}

export default function SandwichDiffInline({
  oldText,
  newText,
  onAccept,
  onReject,
}: SandwichDiffInlineProps) {
  return (
    <li className="list-none mt-2 mb-1">
      <div
        style={{
          background: '#faf9f5',
          border: '1px solid #e8e6dc',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: 'rgba(0,0,0,0.05) 0px 4px 24px',
          fontFamily: 'system-ui, Arial, sans-serif',
        }}
      >

        {/* ── Strikethrough original ── */}
        <div
          className="px-4 pt-3 pb-2 flex gap-2 items-start"
          style={{ borderBottom: '1px solid #e8e6dc' }}
        >
          <span className="shrink-0 text-xs mt-0.5" style={{ color: '#b53333', opacity: 0.6 }}>−</span>
          <p className="text-sm leading-relaxed line-through" style={{ color: '#b0aea5' }}>
            {oldText}
          </p>
        </div>

        {/* ── Proposed replacement ── */}
        <div className="px-4 pt-2.5 pb-3 flex gap-2 items-start">
          <span className="shrink-0 text-xs mt-0.5" style={{ color: '#c96442' }}>+</span>
          <p className="text-sm leading-relaxed font-medium" style={{ color: '#141413' }}>
            {newText}
          </p>
        </div>

        {/* ── Action row ── */}
        <div className="px-4 pb-3 flex gap-2">
          {/* Accept — Terracotta Brand CTA */}
          <button
            onClick={onAccept}
            className="flex-1 py-1.5 text-xs font-semibold transition-colors"
            style={{
              borderRadius: 8,
              background: '#c96442',
              color: '#faf9f5',
              boxShadow: '#c96442 0px 0px 0px 0px, #c96442 0px 0px 0px 1px',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#b85538'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#c96442'; }}
          >
            ✓ Accept
          </button>

          {/* Reject — Warm Sand secondary */}
          <button
            onClick={onReject}
            className="flex-1 py-1.5 text-xs font-semibold transition-colors"
            style={{
              borderRadius: 8,
              background: '#e8e6dc',
              color: '#4d4c48',
              boxShadow: '#e8e6dc 0px 0px 0px 0px, #d1cfc5 0px 0px 0px 1px',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#d1cfc5'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#e8e6dc'; }}
          >
            ✕ Reject
          </button>
        </div>

      </div>
    </li>
  );
}
