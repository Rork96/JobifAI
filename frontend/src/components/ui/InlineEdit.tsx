/**
 * components/ui/InlineEdit.tsx — Manual Override Inline Editor
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders text as a styled span until the user activates editing, then
 * swaps in a transparent input/textarea that inherits the surrounding
 * typographic context perfectly.
 *
 * Two trigger modes:
 *   'click'  — the whole span is clickable (name, contact info). Safe where
 *              the parent has no competing click handler.
 *   'button' — a pencil icon appears on hover and triggers editing via
 *              stopPropagation (bullets, which live inside a clickable <li>
 *              that also fires setActiveBullet).
 *
 * Keyboard:
 *   Enter  — commit (single-line mode)
 *   Escape — cancel, restore original value
 *   Blur   — commit
 *
 * Print:
 *   The pencil button carries className="no-print" so it never appears in the
 *   exported PDF.  The input itself is only rendered while the user is actively
 *   typing — it won't appear in print either since users will not be editing
 *   during window.print().
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

// ── Pencil icon (inline SVG — no icon-lib dependency) ─────────────────────────
const PencilIcon = () => (
  <svg
    width="11" height="11" viewBox="0 0 16 16" fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    style={{ display: 'inline', verticalAlign: 'middle', flexShrink: 0 }}
  >
    <path
      d="M11.293 1.293a1 1 0 0 1 1.414 0l2 2a1 1 0 0 1 0 1.414l-9 9A1 1 0 0 1 5 14H3a1 1 0 0 1-1-1v-2a1 1 0 0 1 .293-.707l9-9ZM4 12v1h1l7.5-7.5-1-1L4 12Z"
      fill="currentColor"
    />
  </svg>
);

// ── Shared input styles — make the field blend into surrounding typography ─────
const INPUT_BASE: React.CSSProperties = {
  background:  'transparent',
  border:      'none',
  outline:     'none',
  padding:     0,
  margin:      0,
  fontFamily:  'inherit',
  fontSize:    'inherit',
  fontWeight:  'inherit',
  lineHeight:  'inherit',
  color:       'inherit',
  letterSpacing: 'inherit',
  width:       '100%',
  borderBottom: '1.5px solid #c96442',   // brand underline signals edit mode
  borderRadius: 0,
  resize:      'none',
};

// ── Props ──────────────────────────────────────────────────────────────────────

export interface InlineEditProps {
  /** Current text value (controlled). */
  value:       string;
  /** Called with the trimmed new value when the user commits. */
  onSave:      (newValue: string) => void;
  /** Applied to the display <span> when not editing. */
  className?:  string;
  style?:      React.CSSProperties;
  /**
   * 'click'  — clicking the text span activates editing.
   * 'button' — a pencil icon button activates editing (safe inside clickable containers).
   */
  trigger?:    'click' | 'button';
  /** Use <textarea> instead of <input> — auto-selected when value exceeds 80 chars. */
  multiline?:  boolean;
  placeholder?: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function InlineEdit({
  value,
  onSave,
  className = '',
  style,
  trigger    = 'click',
  multiline,
  placeholder = 'Click to edit',
}: InlineEditProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft,     setDraft]     = useState(value);

  const inputRef    = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Derive whether to use a textarea: explicit prop or auto-detect long text
  const useTextarea = multiline ?? value.length > 80;

  // Sync draft when the value changes externally (AI rewrite accepted, etc.)
  useEffect(() => {
    if (!isEditing) setDraft(value);
  }, [value, isEditing]);

  // Auto-focus + move cursor to end when edit mode opens
  useEffect(() => {
    if (!isEditing) return;
    const el = useTextarea ? textareaRef.current : inputRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [isEditing, useTextarea]);

  const open = useCallback(() => {
    setDraft(value);
    setIsEditing(true);
  }, [value]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    } else {
      setDraft(value);  // restore if blank or unchanged
    }
    setIsEditing(false);
  }, [draft, value, onSave]);

  const cancel = useCallback(() => {
    setDraft(value);
    setIsEditing(false);
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Enter' && !useTextarea) { e.preventDefault(); commit(); }
    },
    [cancel, commit, useTextarea],
  );

  // ── Edit mode ──────────────────────────────────────────────────────────────
  if (isEditing) {
    const sharedProps = {
      value:       draft,
      onChange:    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                     setDraft(e.target.value),
      onBlur:      commit,
      onKeyDown:   handleKeyDown,
      // Stop bubbling so a parent <li onClick> doesn't also fire
      onClick:     (e: React.MouseEvent) => e.stopPropagation(),
      style:       INPUT_BASE,
      autoComplete: 'off' as const,
      spellCheck:  true,
    };

    return useTextarea ? (
      <textarea
        ref={textareaRef}
        {...sharedProps}
        rows={Math.min(Math.ceil(draft.length / 70) + 1, 6)}
        style={{ ...INPUT_BASE, display: 'block' }}
      />
    ) : (
      <input
        ref={inputRef}
        type="text"
        {...sharedProps}
      />
    );
  }

  // ── Button trigger mode (pencil icon) ──────────────────────────────────────
  if (trigger === 'button') {
    return (
      <span className="group/ie inline-flex items-baseline gap-1 min-w-0 w-full">
        <span className={`flex-1 min-w-0 break-words ${className}`} style={style}>
          {value || <span style={{ color: '#b0aea5' }}>{placeholder}</span>}
        </span>
        <button
          type="button"
          className="no-print shrink-0 opacity-0 group-hover/ie:opacity-100 text-[#b0aea5] hover:text-[#5e5d59] transition-all duration-100 rounded p-0.5 -mb-px"
          style={{ lineHeight: 1 }}
          onClick={(e) => { e.stopPropagation(); open(); }}
          title="Edit manually"
          tabIndex={-1}
          aria-label="Edit text manually"
        >
          <PencilIcon />
        </button>
      </span>
    );
  }

  // ── Click trigger mode (whole span is the target) ──────────────────────────
  return (
    <span
      className={`group/ie cursor-text rounded-sm px-0.5 -mx-0.5 transition-colors hover:bg-[#e8e6dc]/50 ${className}`}
      style={style}
      onClick={open}
      title="Click to edit"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(); }}
    >
      {value || <span style={{ color: '#b0aea5' }}>{placeholder}</span>}
    </span>
  );
}
