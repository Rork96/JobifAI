/**
 * AtsScoreDial — Animated SVG arc dial
 * FSD location: shared/ui/AtsScoreDial.tsx  (PRD §2.6 + Handbook §3.2)
 *
 * PRD §2.6 spec:
 *   - SVG arc, Framer Motion useSpring, 0 → score over 1.2 seconds
 *   - 0–39:  arc fills red,   label "ATS will reject this resume."
 *   - 40–69: arc fills amber, label "Borderline — targeted fixes needed."
 *   - 70–100: arc fills green, label "Strong match."
 *
 * Arc geometry:
 *   r = 38, centre (50, 50), viewBox "0 0 100 100"
 *   270° sweep (gap at bottom). circumference = 2π×38 ≈ 238.76
 *   arc length for 270° = 238.76 × (3/4) = 179.07
 *   rotate(-225deg) on the circle positions the arc start at bottom-left.
 *   strokeDasharray = "179.07 59.69"  (arc + gap)
 *   strokeDashoffset animates from 179.07 (empty) → 179.07×(1−score/100)
 */

import { useEffect } from 'react';
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';

interface AtsScoreDialProps {
  score: number;        // 0–100
  size?: number;        // px, defaults to 160
  isHardcore?: boolean; // PRD §5.5 — changes label text when < 40
}

// Arc geometry constants
const R = 38;
const CX = 50;
const CY = 50;
const CIRCUMFERENCE = 2 * Math.PI * R;          // 238.76
const ARC_LENGTH = CIRCUMFERENCE * (270 / 360);  // 179.07
const GAP_LENGTH = CIRCUMFERENCE - ARC_LENGTH;   // 59.69

function scoreToColor(score: number) {
  if (score >= 70) return { stroke: '#22c55e', text: 'text-green-600', label: 'Strong match.' };
  if (score >= 40) return { stroke: '#f59e0b', text: 'text-amber-600', label: 'Borderline — targeted fixes needed.' };
  return { stroke: '#ef4444', text: 'text-red-600', label: 'ATS will reject this resume.' };
}

function hardcoreLabel(score: number) {
  if (score < 40) return '0 recruiters will see this. Fix it now.';
  return null;
}

export default function AtsScoreDial({ score, size = 160, isHardcore = false }: AtsScoreDialProps) {
  const { stroke, text, label } = scoreToColor(score);
  const displayLabel = isHardcore ? (hardcoreLabel(score) ?? label) : label;

  // Animate score counter and arc simultaneously via a shared spring
  const raw = useMotionValue(0);
  const spring = useSpring(raw, { stiffness: 50, damping: 18, restDelta: 0.01 });

  // strokeDashoffset: full = ARC_LENGTH (empty arc), 0 = fully filled
  const dashOffset = useTransform(spring, [0, 100], [ARC_LENGTH, 0]);

  // Displayed integer score
  const displayScore = useTransform(spring, v => Math.round(v));

  useEffect(() => {
    // Small delay so the animation plays after the panel enters
    const t = setTimeout(() => raw.set(score), 120);
    return () => clearTimeout(t);
  }, [score, raw]);

  return (
    <div className="flex flex-col items-center gap-3">
      {/* SVG dial */}
      <div style={{ width: size, height: size }} className="relative">
        <svg viewBox="0 0 100 100" className="w-full h-full" style={{ transform: 'rotate(-225deg)' }}>
          {/* Background arc (grey track) */}
          <circle
            cx={CX} cy={CY} r={R}
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${ARC_LENGTH} ${GAP_LENGTH}`}
          />
          {/* Animated foreground arc */}
          <motion.circle
            cx={CX} cy={CY} r={R}
            fill="none"
            stroke={stroke}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${ARC_LENGTH} ${GAP_LENGTH}`}
            style={{ strokeDashoffset: dashOffset }}
          />
        </svg>

        {/* Score number — centred inside the dial */}
        <div className="absolute inset-0 flex flex-col items-center justify-center"
             style={{ transform: 'rotate(0deg)' }}>
          <motion.span className={`font-bold tabular-nums ${text}`}
                       style={{ fontSize: size * 0.22, lineHeight: 1 }}>
            {displayScore}
          </motion.span>
          <span className="text-slate-400 font-medium"
                style={{ fontSize: size * 0.1, lineHeight: 1.4 }}>
            / 100
          </span>
        </div>
      </div>

      {/* Label */}
      <p className={`text-sm font-semibold text-center max-w-xs leading-snug ${text}`}>
        {displayLabel}
      </p>
    </div>
  );
}
