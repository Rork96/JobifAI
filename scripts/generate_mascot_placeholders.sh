#!/usr/bin/env bash
# =============================================================================
# generate_mascot_placeholders.sh — Create stub .webm files for Mac's states
# =============================================================================
#
# PURPOSE
# ───────
# The current MacMascot component is built entirely in CSS + Framer Motion —
# no video files are loaded today.  This script creates the INFRASTRUCTURE
# for when the final 3D Pixar-style assets are rendered, so:
#
#   1. The public/mascot/ directory structure is ready for asset drop-in.
#   2. Any future <video> elements referencing these paths won't 404.
#   3. CI/CD pipelines can validate the asset manifest without real renders.
#
# GENERATED FILES  (public/mascot/)
# ──────────────────────────────────
#   idle.webm        — Default floating state (loopable, ~2 s)
#   listening.webm   — Mic-active, sound waves, attentive
#   processing.webm  — Thinking bubble, spinning ring
#   talking.webm     — Speaking, lip sync placeholder
#   warning.webm     — Head-shake amber glow (HR field rejection)
#   shocked.webm     — ATS score reveal drama (score < 50)
#   success.webm     — ATS score > 80, gold celebration
#
# PLACEHOLDER FORMAT
# ──────────────────
# Each stub is a 1-second silent 1×1-pixel black WebM (VP9).
# These are the SMALLEST valid WebM files ffmpeg can produce.
# File sizes: ~2–5 kB each (negligible).
#
# REQUIREMENTS
# ────────────
# ffmpeg must be installed:
#   • macOS:  brew install ffmpeg
#   • Ubuntu: apt-get install ffmpeg
#   • Pi 5:   apt-get install ffmpeg   (apt repo ships ARM64 build)
#
# USAGE
# ─────
#   chmod +x scripts/generate_mascot_placeholders.sh
#   ./scripts/generate_mascot_placeholders.sh
#
# When the real 3D assets are ready, simply REPLACE each .webm with the
# full-resolution render.  The filenames are the contract — don't rename.
# =============================================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/frontend/public/mascot"

# These filenames are the canonical contract between this script and the
# future MacMascot <video> elements.  Don't change them without updating
# MacMascot.tsx at the same time.
STATES=(
  "idle"
  "listening"
  "processing"
  "talking"
  "warning"
  "shocked"
  "success"
)

# Stub dimensions (1×1 px) and duration (1 second at 1 fps).
# Keeping it tiny ensures the stubs have zero visual impact if they somehow
# render before the real assets are swapped in.
WIDTH=1
HEIGHT=1
FPS=1
DURATION=1   # seconds

# ── Preflight checks ──────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  echo "⚠️   ffmpeg not found — falling back to Python generator."
  echo ""
  if command -v python3 &>/dev/null; then
    python3 "$(dirname "${BASH_SOURCE[0]}")/generate_mascot_placeholders.py"
    exit $?
  else
    echo "❌  Neither ffmpeg nor python3 found."
    echo ""
    echo "   Install one of:"
    echo "     ffmpeg:  brew install ffmpeg  /  apt-get install ffmpeg"
    echo "     python3: brew install python  /  apt-get install python3"
    echo ""
    exit 1
  fi
fi

echo "🎬  Generating mascot WebM placeholders → $OUTPUT_DIR"
echo "    ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
echo ""

# ── Create output directory ───────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"

# ── Generate each stub ────────────────────────────────────────────────────────
GENERATED=0
SKIPPED=0

for state in "${STATES[@]}"; do
  OUT="$OUTPUT_DIR/${state}.webm"

  if [[ -f "$OUT" ]]; then
    SIZE=$(wc -c < "$OUT")
    # If the file is already there and > 10 kB, it's probably a real asset.
    # Don't overwrite it — just skip.
    if (( SIZE > 10240 )); then
      echo "  ⏭  ${state}.webm — looks like a real asset (${SIZE} bytes), skipping"
      SKIPPED=$(( SKIPPED + 1 ))
      continue
    fi
    echo "  ♻️  ${state}.webm — replacing existing stub"
  fi

  # Generate 1×1-pixel black VP9 WebM, 1 fps, 1 second, no audio.
  # -loglevel error  — suppress ffmpeg's verbose startup banner
  # -f lavfi          — use the virtual input device (no real source file)
  # -i color=black    — generate a solid black frame
  # -c:v libvpx-vp9  — VP9 codec (universally supported in modern browsers)
  # -b:v 0 -crf 63   — constant quality, maximum compression (file = ~2 kB)
  # -an               — no audio stream
  # -y                — overwrite without asking
  ffmpeg \
    -loglevel error \
    -f lavfi \
    -i "color=black:s=${WIDTH}x${HEIGHT}:r=${FPS}" \
    -t "$DURATION" \
    -c:v libvpx-vp9 \
    -b:v 0 \
    -crf 63 \
    -an \
    -y \
    "$OUT" 2>/dev/null

  SIZE=$(wc -c < "$OUT")
  echo "  ✅  ${state}.webm  (${SIZE} bytes)"
  GENERATED=$(( GENERATED + 1 ))
done

echo ""
echo "Done — generated $GENERATED stubs, skipped $SKIPPED real assets."
echo ""
echo "📂  $OUTPUT_DIR/"
ls -lh "$OUTPUT_DIR/"
echo ""
echo "💡  Replace each .webm with the final 3D render when assets are ready."
echo "    Files > 10 kB will be preserved by this script on re-runs."
