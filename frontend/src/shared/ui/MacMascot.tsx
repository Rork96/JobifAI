/**
 * MacMascot — Visual state-machine placeholder
 * FSD location: shared/ui/MacMascot.tsx  (Handbook §3.2)
 *
 * Phase 2: renders a styled placeholder indicating which .webm asset
 * should play. Phase 3: replace the inner <div> with a <video> element:
 *
 *   <video key={state} src={`/assets/mascot/${ASSETS[state]}`}
 *          autoPlay loop muted playsInline
 *          className="w-full h-full object-contain" />
 *
 * Asset inventory (PRD §2.7):
 *   idle        → idle.webm
 *   listening   → listening.webm
 *   processing  → processing.webm
 *   shocked     → shocked.webm  (score < 40)
 *   success     → success.webm  (score ≥ 70)
 *   warning     → warning.webm  (score 40–69)
 *
 * Transition rules (PRD §2.7):
 *   - 'processing' overrides all other states while any API call is in flight
 *   - 'shocked' | 'success' | 'warning' revert to 'idle' after 3s
 *   - 'listening' activates on input focus, reverts on blur
 */

export type MacState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'shocked'
  | 'success'
  | 'warning';

interface MacMascotProps {
  state: MacState;
  /** 160px desktop, 80px mobile (PRD §2.7) */
  size?: number;
}

const STATE_CONFIG: Record<MacState, { asset: string; bg: string; ring: string; emoji: string; label: string }> = {
  idle:       { asset: 'idle.webm',       bg: 'bg-slate-100',   ring: 'ring-slate-300',  emoji: '💤', label: 'Idle'       },
  listening:  { asset: 'listening.webm',  bg: 'bg-blue-50',     ring: 'ring-blue-300',   emoji: '👂', label: 'Listening'  },
  processing: { asset: 'processing.webm', bg: 'bg-violet-50',   ring: 'ring-violet-400', emoji: '⚙️', label: 'Processing' },
  shocked:    { asset: 'shocked.webm',    bg: 'bg-red-50',      ring: 'ring-red-400',    emoji: '😱', label: 'Shocked'    },
  success:    { asset: 'success.webm',    bg: 'bg-green-50',    ring: 'ring-green-400',  emoji: '✅', label: 'Success'    },
  warning:    { asset: 'warning.webm',    bg: 'bg-amber-50',    ring: 'ring-amber-400',  emoji: '⚠️', label: 'Warning'    },
};

export default function MacMascot({ state, size = 160 }: MacMascotProps) {
  const cfg = STATE_CONFIG[state];

  return (
    <div
      className={`
        relative flex flex-col items-center justify-center rounded-2xl
        ${cfg.bg} ring-2 ${cfg.ring}
        transition-all duration-300
      `}
      style={{ width: size, height: size }}
      aria-label={`Mac mascot — ${cfg.label}`}
    >
      {/* Pulsing ring when processing */}
      {state === 'processing' && (
        <div className="absolute inset-0 rounded-2xl ring-2 ring-violet-400 animate-ping opacity-30" />
      )}

      <span className="text-4xl leading-none" style={{ fontSize: size * 0.3 }}>
        {cfg.emoji}
      </span>

      {/* Asset label — replace this entire block with <video> in Phase 3 */}
      <span className="mt-1 text-center font-mono leading-tight text-slate-500"
            style={{ fontSize: Math.max(9, size * 0.075) }}>
        {cfg.asset}
      </span>
    </div>
  );
}
