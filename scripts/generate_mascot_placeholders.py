#!/usr/bin/env python3
"""
scripts/generate_mascot_placeholders.py
────────────────────────────────────────
Generates minimal valid .webm stub files for each MacMascot state.

This script is a pure-Python fallback for machines without ffmpeg.
It writes the smallest structurally-valid WebM EBML document that will
be accepted by browsers without a console error.

WHY not just write empty files?
  An empty file or a file with random bytes will cause the browser to log
  a "Failed to load resource" / media decode error.  A valid EBML header
  with an empty segment loads silently and fires the 'canplay' event,
  which is exactly what we want for placeholders.

WEBM BINARY FORMAT (EBML)
─────────────────────────
  WebM uses EBML (Extensible Binary Meta Language), a binary TLV format.
  Each element is: [ID bytes] [size varint] [payload bytes]

  Minimum valid document:
    ┌──────────────────────────────────────────────────────────────────┐
    │ EBML (1A 45 DF A3) — EBML Header                                │
    │   EBMLVersion          (42 86 81) 01                             │
    │   EBMLReadVersion      (42 F7 81) 01                             │
    │   EBMLMaxIDLength      (42 F2 81) 04                             │
    │   EBMLMaxSizeLength    (42 F3 81) 08                             │
    │   DocType              (42 82 84) w e b m                        │
    │   DocTypeVersion       (42 87 81) 04                             │
    │   DocTypeReadVersion   (42 85 81) 02                             │
    ├──────────────────────────────────────────────────────────────────┤
    │ Segment (18 53 80 67) [unknown size: 01 FF FF FF FF FF FF FF]   │
    │   (empty — no tracks, no clusters, no video data)               │
    └──────────────────────────────────────────────────────────────────┘

USAGE
─────
  python3 scripts/generate_mascot_placeholders.py

  OR (the shell script wrapper):
  bash scripts/generate_mascot_placeholders.sh   ← tries ffmpeg first,
                                                    falls back to this script
"""

from __future__ import annotations
import os
import sys
from pathlib import Path

# ── Mascot state filenames ─────────────────────────────────────────────────────
# These are the canonical contract — don't rename without updating MacMascot.tsx
STATES = [
    "idle",
    "listening",
    "processing",
    "talking",
    "warning",
    "shocked",
    "success",
]

# ── Minimal valid WebM binary ──────────────────────────────────────────────────
def _make_minimal_webm() -> bytes:
    """
    Build the smallest structurally-valid WebM file (EBML document).

    The file contains:
      - A valid EBML header declaring doctype = "webm"
      - An empty Segment element with unknown size

    This is ~46 bytes.  Browsers will accept it, fire 'canplay', and display
    a blank black frame with zero duration.
    """
    # ── EBML child elements ────────────────────────────────────────────────
    # Each entry: [EBML element ID] [size: 0x81 = 1 byte] [value]
    ebml_content = (
        b'\x42\x86\x81\x01'      # EBMLVersion        = 1
        b'\x42\xf7\x81\x01'      # EBMLReadVersion    = 1
        b'\x42\xf2\x81\x04'      # EBMLMaxIDLength    = 4
        b'\x42\xf3\x81\x08'      # EBMLMaxSizeLength  = 8
        b'\x42\x82\x84webm'      # DocType            = "webm" (4 bytes)
        b'\x42\x87\x81\x04'      # DocTypeVersion     = 4
        b'\x42\x85\x81\x02'      # DocTypeReadVersion = 2
    )

    # ── EBML header: ID + size varint + payload ────────────────────────────
    # Size varint: leading 1-bit determines width.  Payload is 30 bytes < 127,
    # so we encode it as a 1-byte varint: 0x80 | len.
    ebml_id      = b'\x1a\x45\xdf\xa3'          # EBML element ID
    ebml_size    = bytes([0x80 | len(ebml_content)])  # 1-byte varint
    ebml_header  = ebml_id + ebml_size + ebml_content

    # ── Segment element with "unknown" size ────────────────────────────────
    # Unknown size 0x01FFFFFFFFFFFFFF tells the parser to read until EOF.
    # The empty payload means: no tracks, no clusters — valid but empty video.
    segment_id   = b'\x18\x53\x80\x67'
    segment_size = b'\x01\xff\xff\xff\xff\xff\xff\xff'  # unknown size sentinel
    segment      = segment_id + segment_size
    # (no segment payload — empty segment is valid WebM)

    return ebml_header + segment


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    repo_root  = Path(__file__).resolve().parent.parent
    output_dir = repo_root / "frontend" / "public" / "mascot"
    output_dir.mkdir(parents=True, exist_ok=True)

    stub_bytes  = _make_minimal_webm()
    generated   = 0
    skipped     = 0

    print(f"🎬  Generating mascot WebM placeholders → {output_dir}")
    print(f"    Stub size: {len(stub_bytes)} bytes per file\n")

    for state in STATES:
        out_path = output_dir / f"{state}.webm"

        if out_path.exists():
            existing_size = out_path.stat().st_size
            if existing_size > 10_240:
                # Looks like a real asset (> 10 kB) — don't overwrite it
                print(f"  ⏭  {state}.webm — looks like a real asset ({existing_size:,} bytes), skipping")
                skipped += 1
                continue
            print(f"  ♻️  {state}.webm — replacing existing stub")

        out_path.write_bytes(stub_bytes)
        print(f"  ✅  {state}.webm  ({len(stub_bytes)} bytes)")
        generated += 1

    print(f"\nDone — generated {generated} stubs, skipped {skipped} real assets.")
    print(f"\n📂  {output_dir}/")
    for f in sorted(output_dir.iterdir()):
        if not f.name.startswith('.'):
            print(f"    {f.name:20s}  {f.stat().st_size:>6,} bytes")
    print()
    print("💡  Replace each .webm with the final 3D render when assets are ready.")
    print("    Files > 10 kB will be preserved by this script on re-runs.")


if __name__ == "__main__":
    main()
