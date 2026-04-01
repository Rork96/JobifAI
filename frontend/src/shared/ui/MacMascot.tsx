/**
 * MacMascot — Animated .webm state machine
 * FSD location: shared/ui/MacMascot.tsx  (Handbook §3.2)
 *
 * Plays a looping .webm clip matching the current AI state.
 * Assets live in /public/mascot/ and are served by Vite at /mascot/*.webm.
 *
 * The `key={state}` on <video> forces React to unmount + remount the element
 * whenever the state changes — this is the reliable way to restart autoplay
 * since calling .load()/.play() imperatively races with React's reconciler.
 *
 * State → asset mapping (PRD §2.7):
 *   idle        → /mascot/idle.webm        — default resting state
 *   listening   → /mascot/listening.webm   — user input focus
 *   processing  → /mascot/processing.webm  — API call in-flight (overrides all)
 *   success     → /mascot/success.webm     — AI suggestion ready to review
 *   warning     → /mascot/warning.webm     — API error, user attention needed
 *   shocked     → /mascot/shocked.webm     — ATS score < 40
 *
 * Transition rules (PRD §2.7):
 *   - 'processing' overrides all other states while any API call is in flight
 *   - 'success' shows when pendingDiff is set (accept/reject to return to idle)
 *   - 'warning' shows on rewrite error (caller auto-reverts after 3 s)
 *   - 'listening' activates on chat input focus, reverts on blur
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

/**
 * Maps each state to a .webm filename in /public/mascot/.
 * 'listening' and 'talking' assets are stub files (48 bytes) — they fall back
 * to 'idle.webm' so the video element always has a valid source.
 */
const ASSET: Record<MacState, string> = {
  idle:       'idle.webm',
  listening:  'idle.webm',       // stub file — use idle until real asset is ready
  processing: 'processing.webm',
  shocked:    'shocked.webm',
  success:    'success.webm',
  warning:    'warning.webm',
};

/** Tailwind ring colour per state */
const RING: Record<MacState, string> = {
  idle:       'ring-slate-200',
  listening:  'ring-blue-300',
  processing: 'ring-violet-400',
  shocked:    'ring-red-400',
  success:    'ring-green-400',
  warning:    'ring-amber-400',
};

export default function MacMascot({ state, size = 160 }: MacMascotProps) {
  return (
    <div
      className={`
        relative flex items-center justify-center rounded-2xl
        overflow-hidden bg-slate-50 ring-2 ${RING[state]}
        transition-shadow duration-300
      `}
      style={{ width: size, height: size, flexShrink: 0 }}
      aria-label={`Mac mascot — ${state}`}
    >
      {/* Pulsing ring overlay while processing */}
      {state === 'processing' && (
        <div className="absolute inset-0 rounded-2xl ring-2 ring-violet-400 animate-ping opacity-25 pointer-events-none" />
      )}

      {/*
        key={state} forces a full DOM remount on state change so autoplay
        fires reliably — no need for imperative .play() calls.
        muted is required by all browsers before autoplay is permitted.
        playsInline prevents iOS Safari from going full-screen.
      */}
      <video
        key={state}
        src={`/mascot/${ASSET[state]}`}
        autoPlay
        loop
        muted
        playsInline
        className="w-full h-full object-contain"
      />
    </div>
  );
}
