/**
 * WorkspacePage — Route: /workspace?mode=resume|interview|cover
 * PRD §4 — Sandwich UI Protocol
 *
 * Layout (PRD §4.3):
 *
 *   Desktop (md+):
 *   ┌──────────────────────────────┬───────────────────────────────┐
 *   │ RESUME PANEL  (flex-1)       │ MAC COACHING PANEL  (w-72/80) │
 *   │                              │                               │
 *   │  [Experience]                │  [MacMascot .webm 120px]      │
 *   │  • Built internal tooling…   │  ╰── speech bubble            │
 *   │      ← hover: "✨ improve"   │                               │
 *   │    ┌─ SandwichDiffInline ──┐ │  ATS: 58/100                  │
 *   │    │ ✨ AI  +6 pts         │ │                               │
 *   │    │ [Accept]  [Reject]    │ │  [TypeScript]  [CI/CD]        │
 *   │    └──────────────────────┘ │  ← click to inject            │
 *   │  • Managed 5 engineers…     │                               │
 *   │    (dimmed 40% when diff     │  chat history                 │
 *   │     on a sibling bullet)     │  [Ask Mac…]  [🎤]  [Send ▶]  │
 *   └──────────────────────────────┴───────────────────────────────┘
 *
 *   Mobile (<md):
 *   Full-width resume (pb-[42vh] to clear drawer).
 *   BottomSheet — 3 snaps: 20vh peek | 50vh half | 80vh full.
 *   iOS spring drag with velocity-based snap.
 *   SandwichDiffInline always inline — never inside the drawer.
 *
 * Parser (FIXED):
 *   EVERY non-empty line = one bullet.
 *   Section headers (Experience, Education, Skills, …) start a new section.
 *   Bullet prefixes (-, •, 1.) are stripped but the line is never joined
 *   with siblings — "Built internal tooling" is ALWAYS its own clickable row.
 *
 * Chat: POST /api/coach — conversational coaching with Mac.
 *   macState = 'listening' while ChatInput is focused.
 *   macState = 'processing' while any AI call is in flight.
 *   Last Mac chat response replaces the speech bubble text.
 *
 * Voice: useSpeechRecognition — mic icon in ChatInput.
 *   finalText → committed to textarea value; interimText shown as placeholder.
 */

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import { useNavigate, useSearchParams }         from 'react-router-dom';
import { motion, AnimatePresence, useAnimation } from 'framer-motion';
import type { PanInfo }                          from 'framer-motion';

import DevNav                                   from '@/shared/ui/DevNav';
import MacMascot, { type MacState }             from '@/shared/ui/MacMascot';
import SandwichDiffInline                       from '@/shared/ui/SandwichDiffInline';
import { useSessionStore }                      from '@/store/useSessionStore';
import { useAuthStore }                         from '@/store/useAuthStore';
import { useDocumentStore, type PendingDiff }   from '@/store/useDocumentStore';
import { useChatStore, type ChatMessage }        from '@/store/useChatStore';
import { coachMessage as apiCoachMessage }       from '@/lib/api';
import { useSpeechRecognition }                 from '@/hooks/useSpeechRecognition';
import { calculateAtsScore, getMissingKeywords } from '@/shared/utils/atsScore';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WorkspaceMode = 'resume' | 'interview' | 'cover';

interface ResumeBullet  { id: string; text: string; }
interface ResumeSection {
  id: string;
  title: string;       // "Experience" | "Education" | "Skills" | …
  company: string;     // legacy compat — same as title for plain sections
  role: string;
  period: string;
  location: string;
  bullets: ResumeBullet[];
}
interface ResumeHeader  { name: string; title: string; contact: string; }

// ─────────────────────────────────────────────────────────────────────────────
// Resume parser — EVERY LINE = ONE BULLET
// ─────────────────────────────────────────────────────────────────────────────
//
// Root cause of the "solid block of text" bug:
//   The previous Pass 2 did `.replace(/\n/g, ' ')` which JOINED all lines
//   in a paragraph into one mega-string. "Built internal tooling\nManaged 5
//   engineers" became "Built internal tooling Managed 5 engineers" — one
//   unclickable blob.
//
// Fix: split by \n first. Each non-empty line is ALWAYS its own bullet.
//   Section headers (Experience, Education, Skills, etc.) create a new
//   ResumeSection. Contact info at the top (email, phone, URLs) is skipped.

const SECTION_MAP: Record<string, string> = {
  'experience':             'Experience',
  'work experience':        'Experience',
  'work history':           'Experience',
  'employment':             'Experience',
  'employment history':     'Experience',
  'professional experience':'Experience',
  'career history':         'Experience',
  'education':              'Education',
  'academic background':    'Education',
  'academic history':       'Education',
  'academic qualifications':'Education',
  'skills':                 'Skills',
  'technical skills':       'Skills',
  'core competencies':      'Skills',
  'technologies':           'Skills',
  'tools & technologies':   'Skills',
  'summary':                'Summary',
  'professional summary':   'Summary',
  'executive summary':      'Summary',
  'profile':                'Summary',
  'objective':              'Summary',
  'about me':               'Summary',
  'about':                  'Summary',
  'projects':               'Projects',
  'personal projects':      'Projects',
  'key projects':           'Projects',
  'certifications':         'Certifications',
  'certificates':           'Certifications',
  'licenses':               'Certifications',
  'achievements':           'Achievements',
  'awards':                 'Achievements',
  'honors':                 'Achievements',
  'publications':           'Publications',
  'references':             'References',
  'languages':              'Languages',
  'interests':              'Interests',
  'hobbies':                'Interests',
  'volunteering':           'Volunteering',
  'volunteer experience':   'Volunteering',
};

const BULLET_PREFIX_RE = /^[-•*▪·✓➤→▸]\s+|^\d+[.)]\s+/;
const EMAIL_RE         = /\S+@\S+\.\S+/;
const PHONE_RE         = /\+?\d[\d\s\-().]{6,}\d/;
const URL_RE           = /https?:\/\/|linkedin\.com|github\.com|twitter\.com/i;

function getSectionTitle(line: string): string | null {
  const key = line.toLowerCase()
    .replace(/[:.\/|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Exact match
  if (SECTION_MAP[key]) return SECTION_MAP[key];

  // Prefix match (only for short lines — headers are rarely > 35 chars)
  if (line.length <= 35) {
    for (const [k, v] of Object.entries(SECTION_MAP)) {
      if (key.startsWith(k)) return v;
    }
  }
  return null;
}

function makeSection(id: string, title: string): ResumeSection {
  return { id, title, company: title, role: '', period: '', location: '', bullets: [] };
}

function parseResumeToSections(rawText: string): ResumeSection[] {
  if (!rawText?.trim()) return [];

  // Split strictly by newlines — never join lines. Each line = own bullet.
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return [];

  const sections: ResumeSection[] = [];
  let current: ResumeSection | null = null;
  let sIdx = 0;

  // Identify "contact header" lines (name, email, phone, URL) that precede
  // the first section header.  We skip these — they're shown in ResumeHeader.
  const isContactLine = (l: string) =>
    EMAIL_RE.test(l) || PHONE_RE.test(l) || URL_RE.test(l);

  let skippingHeader = true; // true until first section header OR first bullet
  let headerLinesSeen = 0;

  const pushBullet = (text: string) => {
    const clean = text.replace(BULLET_PREFIX_RE, '').trim();
    if (clean.length < 4) return;
    if (!current) {
      current = makeSection(`s${sIdx++}`, 'Experience');
      sections.push(current);
    }
    current.bullets.push({ id: `${current.id}-b${current.bullets.length}`, text: clean });
  };

  for (const line of lines) {
    // Section header detection
    const secTitle = getSectionTitle(line);
    if (secTitle) {
      skippingHeader = false;
      current = makeSection(`s${sIdx++}`, secTitle);
      sections.push(current);
      headerLinesSeen = 0;
      continue;
    }

    // Skip contact/name lines at the very top (before any section header)
    if (skippingHeader) {
      headerLinesSeen++;
      if (headerLinesSeen === 1) continue; // almost certainly the person's name
      if (isContactLine(line)) continue;
      // Non-contact, non-name, non-header → we're in content now
      skippingHeader = false;
    }

    // Every remaining line → its own bullet
    pushBullet(line);
  }

  const withBullets = sections.filter(s => s.bullets.length > 0);

  // Absolute fallback: if nothing matched, every line becomes its own bullet
  if (withBullets.length === 0) {
    const id = 's0';
    return [{
      id, title: 'Resume', company: 'Resume', role: '', period: '', location: '',
      bullets: lines
        .slice(1)  // skip first line (name)
        .filter(l => l.length >= 4)
        .map((text, i) => ({ id: `s0-b${i}`, text: text.replace(BULLET_PREFIX_RE, '').trim() })),
    }];
  }

  return withBullets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section interactivity gate (Phase 1 — PRD §4 scope restriction)
// ─────────────────────────────────────────────────────────────────────────────
//
// ONLY bullets inside Summary and Experience sections are interactive
// EditableBullet targets. All other sections (Education, Skills, Contacts,
// Projects, Certifications, etc.) are rendered as static read-only text.
// This ensures the AI can only be aimed at content worth rewriting.

const INTERACTIVE_SECTIONS = new Set(['Summary', 'Experience']);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MIN_BULLET_LEN = 8;

function buildResumeContext(sections: ResumeSection[], excludeId: string): string {
  return sections
    .flatMap(s => s.bullets)
    .filter(b => b.id !== excludeId)
    .map(b => b.text)
    .join(' | ')
    .slice(0, 1200);
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatInput — textarea + send + microphone
// ─────────────────────────────────────────────────────────────────────────────

interface ChatInputProps {
  onSend:          (text: string) => void;
  isGenerating:    boolean;
  onFocusChange:   (focused: boolean) => void;
  placeholder?:    string;
  compact?:        boolean;
}

function ChatInput({
  onSend, isGenerating, onFocusChange,
  placeholder = 'Ask Mac for coaching…', compact = false,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Voice (Web Speech API) ──────────────────────────────────────────────────
  const {
    isSupported: voiceSupported,
    isListening,
    interimText,
    finalText,
    permissionDenied,
    startListening,
    stopListening,
  } = useSpeechRecognition('en-US');

  // When speech recognition produces a committed final transcript, append it
  // to the textarea value.
  useEffect(() => {
    if (finalText) {
      setValue(prev => (prev ? prev + ' ' : '') + finalText);
    }
  }, [finalText]);

  const handleSend = useCallback(() => {
    // Stop voice if active
    if (isListening) stopListening();

    const trimmed = value.trim();
    if (!trimmed || isGenerating) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [value, isGenerating, isListening, stopListening, onSend]);

  // Auto-grow textarea
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 96) + 'px';
  }, [value]);

  const pad = compact ? 'p-2' : 'p-3';

  const micTitle = permissionDenied
    ? 'Microphone permission denied — check browser settings'
    : isListening
      ? 'Stop recording'
      : voiceSupported
        ? 'Start voice input'
        : 'Voice input not supported in this browser';

  return (
    <div className={`flex-shrink-0 border-t border-slate-100 bg-white ${pad}`}>
      <div className="flex items-end gap-1.5 bg-slate-50 rounded-xl border border-slate-200
                      px-3 py-2 focus-within:border-brand-400 transition-colors">
        <textarea
          ref={textareaRef}
          value={isListening && interimText ? value + interimText : value}
          onChange={e => {
            // If voice is active, ignore keyboard edits to the interim portion
            if (!isListening) setValue(e.target.value);
          }}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            isListening
              ? (interimText || 'Listening…')
              : isGenerating
                ? 'Mac is thinking…'
                : placeholder
          }
          rows={1}
          disabled={isGenerating}
          className="flex-1 bg-transparent resize-none text-sm text-slate-700
                     placeholder-slate-400 focus:outline-none disabled:opacity-60"
          style={{ maxHeight: 96, overflowY: 'auto' }}
        />

        {/* Microphone button */}
        {voiceSupported && (
          <button
            type="button"
            title={micTitle}
            disabled={permissionDenied || isGenerating}
            onClick={() => isListening ? stopListening() : startListening()}
            className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center
                        transition-all active:scale-95
                        ${isListening
                          ? 'bg-red-500 text-white animate-pulse'
                          : 'text-slate-400 hover:text-brand-600 hover:bg-brand-50'
                        }
                        disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {/* Mic icon */}
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
          </button>
        )}

        {/* Send button */}
        <button
          type="button"
          onClick={handleSend}
          disabled={!value.trim() || isGenerating}
          aria-label="Send message"
          className="flex-shrink-0 w-7 h-7 rounded-lg bg-brand-600 hover:bg-brand-700
                     active:scale-95 flex items-center justify-center text-white
                     transition-all disabled:opacity-40 disabled:cursor-not-allowed
                     disabled:active:scale-100"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>

      {!compact && (
        <p className="mt-1 text-[9px] text-slate-400 text-center tracking-wide">
          ↵ send · Shift+↵ new line{voiceSupported ? ' · 🎤 voice' : ''}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatMessages — scrollable message list
// ─────────────────────────────────────────────────────────────────────────────

function ChatMessages({ messages, isGenerating }: { messages: ChatMessage[]; isGenerating: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isGenerating]);

  const showTyping =
    isGenerating &&
    (messages.length === 0 || messages[messages.length - 1].role === 'user');

  if (messages.length === 0 && !isGenerating) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <p className="text-xs text-slate-400 text-center leading-relaxed">
          Ask Mac anything —<br />
          <span className="text-slate-300">wording, strategy, keywords…</span>
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hidden px-3 py-3 space-y-2">
      {messages.map(msg => (
        <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div className={`
            max-w-[90%] text-sm leading-relaxed px-3 py-2 rounded-2xl break-words
            ${msg.role === 'user'
              ? 'bg-brand-600 text-white rounded-br-sm'
              : 'bg-slate-100 text-slate-800 rounded-bl-sm'
            }
          `}>
            {msg.content}
          </div>
        </div>
      ))}

      {showTyping && (
        <div className="flex justify-start">
          <div className="bg-slate-100 px-3 py-2.5 rounded-2xl rounded-bl-sm">
            <div className="flex gap-1 items-center h-4">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:120ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:240ms]" />
            </div>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Navbar
// ─────────────────────────────────────────────────────────────────────────────

function WorkspaceNavbar({
  mode, atsScore, liveScore,
}: { mode: WorkspaceMode; atsScore: number | null; liveScore: number | null }) {
  const navigate = useNavigate();
  const user     = useAuthStore(s => s.user);

  const BADGE = {
    resume:    { label: 'Fix Resume',     cls: 'bg-brand-100 text-brand-700' },
    interview: { label: 'Interview Prep', cls: 'bg-blue-100 text-blue-700'   },
    cover:     { label: 'Cover Letter',   cls: 'bg-pink-100 text-pink-700'   },
  };
  const b = BADGE[mode];

  // Use live client-side score while backend score is null, else show backend's
  const displayScore = atsScore ?? liveScore;

  return (
    <nav className="fixed top-0 inset-x-0 z-40 glass border-b border-white/20">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-slate-400 hover:text-slate-700 transition-colors text-sm"
          >
            ← Dashboard
          </button>
          <span className="text-slate-200 hidden sm:block">|</span>
          <span className="font-bold text-base tracking-tight text-slate-900 hidden sm:block">
            Jobif<span className="text-brand-600">AI</span>
          </span>
        </div>

        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${b.cls}`}>
          {b.label}
        </span>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1 text-xs">
            <span className="text-slate-400 font-medium">ATS</span>
            {displayScore !== null ? (
              <>
                <span className={`font-bold tabular-nums ${
                  displayScore >= 70 ? 'text-green-600' :
                  displayScore >= 40 ? 'text-amber-600' :
                  'text-red-600'
                }`}>
                  {displayScore}
                </span>
                <span className="text-slate-300">/100</span>
                {atsScore === null && liveScore !== null && (
                  <span className="text-[9px] text-slate-400 ml-0.5">(est.)</span>
                )}
              </>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </div>
          {user && (
            <span className="hidden md:block text-xs text-slate-400 font-mono truncate max-w-[140px]">
              {user.email}
            </span>
          )}
        </div>
      </div>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CoachingPanel props
// ─────────────────────────────────────────────────────────────────────────────

interface CoachingPanelProps {
  macState:          MacState;
  macSays:           string;
  atsScore:          number | null;
  liveScore:         number | null;
  diff:              PendingDiff | null;
  missingSkills:     string[];
  matchedSkills:     string[];
  atsGaps:           string[];
  messages:          ChatMessage[];
  chatIsGenerating:  boolean;
  onSendMessage:     (text: string) => void;
  onChatFocusChange: (focused: boolean) => void;
  onKeywordClick:    (keyword: string) => void;
  focusedBullet:     ResumeBullet | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Desktop CoachingPanel — right sidebar
// ─────────────────────────────────────────────────────────────────────────────

function CoachingPanel({
  macState, macSays, atsScore, liveScore, diff,
  missingSkills, matchedSkills, atsGaps,
  messages, chatIsGenerating, onSendMessage, onChatFocusChange,
  onKeywordClick, focusedBullet,
}: CoachingPanelProps) {

  const displayScore = atsScore ?? liveScore;

  // Merge backend missing-skills with local client-side gaps (deduped)
  const displayMissing: string[] = useMemo(() => {
    const backendList = missingSkills.length > 0
      ? missingSkills
      : atsGaps.map(g => { const m = g.match(/["']([^"']+)["']/); return m ? m[1] : g; }).filter(Boolean);
    return [...new Set(backendList)].slice(0, 8);
  }, [missingSkills, atsGaps]);

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── MacMascot + speech bubble ──────────────────────────────────────── */}
      <div className="flex-shrink-0 flex flex-col items-center pt-5 pb-3 px-5">
        <MacMascot state={macState} size={120} />

        {/* CSS-triangle speech bubble pointing UP toward mascot */}
        <div className="relative mt-3 w-full">
          <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-0 h-0
                          border-l-[8px] border-l-transparent
                          border-r-[8px] border-r-transparent
                          border-b-[8px] border-b-slate-100" />
          <div className="rounded-2xl bg-slate-100 border border-slate-200 px-4 py-3">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">
              Mac says
            </p>
            <p className="text-sm text-slate-700 leading-snug line-clamp-3">{macSays}</p>
          </div>
        </div>
      </div>

      {/* ── ATS score + pending diff badge ─────────────────────────────────── */}
      <div className="flex-shrink-0 px-5 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">
              ATS Score
            </p>
            <div className="flex items-baseline gap-1">
              {displayScore !== null ? (
                <>
                  <span className={`text-2xl font-black tabular-nums ${
                    displayScore >= 70 ? 'text-green-600' :
                    displayScore >= 40 ? 'text-amber-600' :
                    'text-red-600'
                  }`}>
                    {displayScore}
                  </span>
                  <span className="text-sm text-slate-400">/100</span>
                  {atsScore === null && liveScore !== null && (
                    <span className="text-[9px] text-slate-400">(est.)</span>
                  )}
                </>
              ) : (
                <span className="text-2xl font-black text-slate-300">—</span>
              )}
            </div>
          </div>
          {diff && (
            <span className="text-xs font-bold text-green-600 bg-green-50 border border-green-200
                             px-2.5 py-1 rounded-full">
              +{diff.scoreImpact} pts ready
            </span>
          )}
        </div>
        {displayScore !== null && displayScore < 50 && (
          <p className="mt-1 text-xs text-red-500 font-medium">
            ATS may auto-reject this resume.
          </p>
        )}
      </div>

      {/* ── Keyword chips ──────────────────────────────────────────────────── */}
      {displayMissing.length > 0 && (
        <div className="flex-shrink-0 px-5 pb-3">
          <div className="h-px bg-slate-100 mb-3" />
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
            {focusedBullet ? '↓ Inject into focused bullet' : 'Missing Keywords'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {displayMissing.map(kw => (
              <button
                key={kw}
                type="button"
                onClick={() => onKeywordClick(kw)}
                title={focusedBullet
                  ? `Inject "${kw}" into: "${focusedBullet.text.slice(0, 40)}…"`
                  : `Missing keyword: ${kw}`}
                className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200
                           px-2.5 py-1 rounded-full hover:bg-red-100 hover:border-red-300
                           active:scale-95 transition-all cursor-pointer"
              >
                – {kw}
              </button>
            ))}
          </div>

          {matchedSkills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {matchedSkills.slice(0, 6).map(kw => (
                <span key={kw}
                  className="text-[10px] font-semibold text-green-700 bg-green-50
                             border border-green-200 px-2 py-0.5 rounded-full">
                  ✓ {kw}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-shrink-0 mx-5 h-px bg-slate-100" />

      {/* ── Chat messages — flex-1, scrolls internally ─────────────────────── */}
      <ChatMessages messages={messages} isGenerating={chatIsGenerating} />

      {/* ── Chat input — pinned at bottom ───────────────────────────────────── */}
      <ChatInput
        onSend={onSendMessage}
        isGenerating={chatIsGenerating}
        onFocusChange={onChatFocusChange}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MobileBottomSheet — iOS-style 3-snap drawer
// ─────────────────────────────────────────────────────────────────────────────
//
// Fix: previously used string-based heights ('40vh', '78vh').
// Framer Motion cannot spring-interpolate between CSS string values.
// Now uses pixel values calculated from window.innerHeight so the spring
// animation is smooth.
//
// 3 snap levels:
//   0 → 20% vh  (Peek — drag handle + mascot strip only)
//   1 → 50% vh  (Half — full chat)
//   2 → 80% vh  (Full — full chat + keyboard clearance)

const SPRING = { type: 'spring', stiffness: 380, damping: 36 } as const;
const VELOCITY_THRESHOLD = 300; // px/s

function MobileBottomSheet(props: CoachingPanelProps) {
  const {
    macState, macSays, atsScore, liveScore, diff,
    missingSkills, atsGaps,
    messages, chatIsGenerating, onSendMessage, onChatFocusChange,
    onKeywordClick, focusedBullet,
  } = props;

  // Pixel-based snap geometry
  const [vh, setVh] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight : 800,
  );
  useEffect(() => {
    const handler = () => setVh(window.innerHeight);
    window.addEventListener('resize', handler, { passive: true });
    return () => window.removeEventListener('resize', handler);
  }, []);

  const sheetHeight = Math.round(vh * 0.80);
  const snapY = useMemo(() => ({
    2: 0,                                          // 80% visible (Full)
    1: sheetHeight - Math.round(vh * 0.50),        // 50% visible (Half)
    0: sheetHeight - Math.round(vh * 0.20),        // 20% visible (Peek)
  }), [sheetHeight, vh]);

  const [snapLevel, setSnapLevel] = useState<0 | 1 | 2>(0);
  const snapLevelRef = useRef<0 | 1 | 2>(0);
  const controls     = useAnimation();

  snapLevelRef.current = snapLevel;

  const animateTo = useCallback((level: 0 | 1 | 2) => {
    controls.start({ y: snapY[level], transition: SPRING });
    setSnapLevel(level);
    if (level === 2 && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([50]);
    }
  }, [controls, snapY]);

  // Re-snap on resize
  useEffect(() => {
    controls.start({ y: snapY[snapLevelRef.current], transition: SPRING });
  }, [vh]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDragEnd = useCallback((_e: unknown, info: PanInfo) => {
    const { velocity, offset } = info;
    const cur = snapLevelRef.current;
    let target: 0 | 1 | 2;

    if (velocity.y < -VELOCITY_THRESHOLD) {
      target = Math.min(2, cur + 1) as 0 | 1 | 2;
    } else if (velocity.y > VELOCITY_THRESHOLD) {
      target = Math.max(0, cur - 1) as 0 | 1 | 2;
    } else {
      const currentY = snapY[cur] + offset.y;
      const sorted   = ([0, 1, 2] as const)
        .map(l => ({ l, d: Math.abs(snapY[l] - currentY) }))
        .sort((a, b) => a.d - b.d);
      target = sorted[0].l;
    }
    animateTo(target);
  }, [animateTo, snapY]);

  const handleHandleTap = useCallback(() => {
    animateTo(((snapLevelRef.current + 1) % 3) as 0 | 1 | 2);
  }, [animateTo]);

  const displayScore   = atsScore ?? liveScore;
  const displayMissing = missingSkills.length > 0
    ? missingSkills.slice(0, 6)
    : atsGaps
        .map(g => { const m = g.match(/["']([^"']+)["']/); return m ? m[1] : g; })
        .filter(Boolean).slice(0, 6);

  return (
    <motion.div
      drag="y"
      dragConstraints={{ top: 0, bottom: snapY[0] }}
      dragElastic={{ top: 0.04, bottom: 0.06 }}
      onDragEnd={handleDragEnd}
      animate={controls}
      initial={{ y: snapY[0] }}
      className="fixed bottom-0 left-0 right-0 z-40 flex flex-col
                 bg-white rounded-t-[28px]
                 shadow-[0_-8px_40px_rgba(0,0,0,0.12)]
                 select-none overflow-hidden"
      style={{ height: sheetHeight }}
    >
      {/* ── Drag handle — tap cycles snap levels ─────────────────────────── */}
      <button
        onClick={handleHandleTap}
        className="flex-shrink-0 flex flex-col items-center justify-center gap-1
                   pt-3 pb-2 cursor-grab active:cursor-grabbing w-full"
        aria-label={
          snapLevel === 0 ? 'Expand coaching panel'
          : snapLevel === 1 ? 'Expand to full view'
          : 'Minimise coaching panel'
        }
      >
        <motion.div
          className="h-1 rounded-full bg-slate-300 transition-colors"
          animate={{ width: snapLevel === 2 ? 48 : snapLevel === 1 ? 36 : 28 }}
          transition={SPRING}
        />
        {snapLevel === 0 && (
          <span className="text-[10px] font-medium text-slate-400">
            Mac Coaching Panel
          </span>
        )}
      </button>

      {/* ── Peek strip — always visible at all snap levels ───────────────── */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 pb-3">
        <MacMascot state={macState} size={48} />

        <div className="flex-1 min-w-0 rounded-2xl bg-slate-100 border border-slate-200 px-3 py-2">
          <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-0.5">
            Mac says
          </p>
          <p className="text-sm text-slate-700 leading-snug line-clamp-2">{macSays}</p>
        </div>

        {displayScore !== null && (
          <div className="flex-shrink-0 text-right">
            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-0.5">
              ATS
            </p>
            <p className={`text-xl font-black tabular-nums leading-none ${
              displayScore >= 70 ? 'text-green-600' :
              displayScore >= 40 ? 'text-amber-600' :
              'text-red-600'
            }`}>
              {displayScore}
            </p>
          </div>
        )}

        {diff && (
          <span className="flex-shrink-0 text-[10px] font-bold text-green-700
                           bg-green-50 border border-green-200 px-2 py-0.5
                           rounded-full whitespace-nowrap">
            +{diff.scoreImpact}
          </span>
        )}
      </div>

      {/* ── Expanded content (snap 1 & 2) ────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden border-t border-slate-100">

        {/* Missing keyword chips */}
        {displayMissing.length > 0 && (
          <div className="flex-shrink-0 px-4 pt-3 pb-2">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              {focusedBullet ? '↓ Inject into focused bullet' : 'Missing Keywords'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {displayMissing.map(kw => (
                <button key={kw} type="button" onClick={() => onKeywordClick(kw)}
                  className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200
                             px-2.5 py-1 rounded-full hover:bg-red-100 active:scale-95 transition-all">
                  – {kw}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Chat messages */}
        <ChatMessages messages={messages} isGenerating={chatIsGenerating} />

        {/* Chat input */}
        <ChatInput
          onSend={onSendMessage}
          isGenerating={chatIsGenerating}
          onFocusChange={onChatFocusChange}
          compact
        />
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ResumePanel — structured editable document
// ─────────────────────────────────────────────────────────────────────────────

interface ResumePanelProps {
  header:            ResumeHeader;
  sections:          ResumeSection[];
  pendingDiff:       PendingDiff | null;
  improvingBulletId: string | null;
  focusedBullet:     ResumeBullet | null;
  onBulletClick:     (b: ResumeBullet, s: ResumeSection) => void;
  onAccept:          () => void;
  onReject:          () => void;
}

function ResumePanel({
  header, sections,
  pendingDiff, improvingBulletId, focusedBullet,
  onBulletClick, onAccept, onReject,
}: ResumePanelProps) {
  const hasDiff = pendingDiff !== null;

  return (
    <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">

      {/* Header — name / title / contact */}
      <div className="border-b border-slate-100 p-5 sm:p-7">
        <h2 className="text-xl sm:text-2xl font-black text-slate-900">
          {header.name || 'Your Resume'}
        </h2>
        {header.title   && <p className="text-sm font-semibold text-brand-600 mt-0.5">{header.title}</p>}
        {header.contact && <p className="text-xs text-slate-400 mt-1">{header.contact}</p>}
      </div>

      {/* Sections */}
      <div className="p-5 sm:p-7 space-y-8">
        {sections.map(section => {
          const sectionHasDiff =
            (hasDiff && section.bullets.some(b => b.id === pendingDiff?.fieldPath)) ||
            section.bullets.some(b => b.id === improvingBulletId);
          const sectionDimmed = (hasDiff || improvingBulletId !== null) && !sectionHasDiff;

          return (
            <motion.div
              key={section.id}
              layout
              className={`transition-opacity duration-300 ${sectionDimmed ? 'opacity-40' : ''}`}
            >
              {/* Section title */}
              <div className="flex items-center gap-3 mb-3">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                  {section.title}
                </h3>
                <div className="flex-1 h-px bg-slate-100" />
              </div>

              {/*
                Bullet list.
                INTERACTIVE_SECTIONS (Summary, Experience) → EditableBullet (role="button").
                All other sections → StaticBullet (read-only, no AI scope).
              */}
              <ul className="space-y-1">
                {section.bullets.map(bullet => {

                  // ── Static sections: Education, Skills, Contacts, etc. ────────
                  if (!INTERACTIVE_SECTIONS.has(section.title)) {
                    return (
                      <li key={bullet.id}
                          className="flex items-start gap-2 text-sm leading-relaxed py-0.5">
                        <span className="mt-[7px] flex-shrink-0 w-1.5 h-1.5 rounded-full bg-slate-200" />
                        <span className="text-slate-600 flex-1 select-text">{bullet.text}</span>
                      </li>
                    );
                  }

                  // ── Interactive sections: Summary + Experience ────────────────
                  const isImproving   = bullet.id === improvingBulletId;
                  const isTargeted    = hasDiff && bullet.id === pendingDiff?.fieldPath;
                  const isFocused     = focusedBullet?.id === bullet.id && !isTargeted && !isImproving;
                  const isDimmed      = (hasDiff || improvingBulletId !== null)
                                          && !isTargeted && !isImproving && sectionHasDiff;
                  const isHighlighted = isTargeted || isImproving;
                  const isImprovable  = bullet.text.trim().length >= MIN_BULLET_LEN;

                  return (
                    <motion.li key={bullet.id} layout>
                      {/*
                        EditableBullet — the atomic, clickable unit.
                        Role="button" so it's keyboard-accessible.
                        hover:bg-slate-50 + group-hover "✨ improve" badge = hover affordance.
                        amber highlight = targeted/in-progress.
                        brand-50 highlight = focused (selected for keyword injection).
                      */}
                      <div
                        role="button"
                        tabIndex={isImprovable ? 0 : -1}
                        onClick={() => onBulletClick(bullet, section)}
                        onKeyDown={e => e.key === 'Enter' && onBulletClick(bullet, section)}
                        aria-label={isImprovable ? `Improve: ${bullet.text.slice(0, 60)}` : undefined}
                        aria-disabled={!isImprovable}
                        className={[
                          'flex items-start gap-2 text-sm leading-relaxed rounded-lg',
                          'transition-all duration-150 select-none',
                          isDimmed        ? 'opacity-40 pointer-events-none' : '',
                          isHighlighted   ? 'bg-amber-50 border border-amber-200 px-3 py-2 -mx-3 cursor-default' :
                          isFocused       ? 'bg-brand-50 border border-brand-100 px-3 py-2 -mx-3 cursor-pointer' :
                          isImprovable    ? 'px-0 py-0.5 cursor-pointer hover:bg-slate-50 hover:-mx-2 hover:px-2 group' :
                                            'px-0 py-0.5 cursor-default opacity-50',
                        ].join(' ')}
                      >
                        {/* Bullet dot */}
                        <span className={`mt-[7px] flex-shrink-0 w-1.5 h-1.5 rounded-full transition-colors ${
                          isHighlighted ? 'bg-amber-500' :
                          isFocused     ? 'bg-brand-500' :
                          'bg-slate-300 group-hover:bg-brand-400'
                        }`} />

                        {/* Bullet text */}
                        <span className={
                          isHighlighted ? 'text-amber-900 font-medium flex-1' :
                          isFocused     ? 'text-brand-900 font-medium flex-1' :
                          'text-slate-700 flex-1'
                        }>
                          {bullet.text}
                        </span>

                        {/* Right-side status badge */}
                        {isImproving && (
                          <span className="flex-shrink-0 flex items-center gap-1 text-[10px]
                                           font-bold text-amber-600 bg-amber-100
                                           px-2 py-0.5 rounded-full self-start mt-0.5">
                            <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25"/>
                              <path fill="currentColor" className="opacity-75" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                            </svg>
                            rewriting…
                          </span>
                        )}
                        {isTargeted && !isImproving && (
                          <span className="flex-shrink-0 text-[10px] font-bold text-amber-600
                                           bg-amber-100 px-2 py-0.5 rounded-full self-start mt-0.5">
                            original
                          </span>
                        )}
                        {isFocused && (
                          <span className="flex-shrink-0 text-[10px] font-bold text-brand-600
                                           bg-brand-50 border border-brand-200
                                           px-2 py-0.5 rounded-full self-start mt-0.5">
                            focused
                          </span>
                        )}
                        {/* Hover affordance — "✨ improve" */}
                        {!isHighlighted && !isFocused && isImprovable && (
                          <span className="flex-shrink-0 opacity-0 group-hover:opacity-100
                                           text-[10px] font-bold text-brand-600 bg-brand-50
                                           border border-brand-200 px-2 py-0.5 rounded-full
                                           self-start mt-0.5 transition-opacity duration-100">
                            ✨ improve
                          </span>
                        )}
                      </div>

                      {/* SandwichDiffInline — renders INLINE below the targeted bullet */}
                      <AnimatePresence>
                        {(isTargeted || isImproving) && (
                          <SandwichDiffInline
                            key={`diff-${bullet.id}`}
                            diff={isTargeted ? pendingDiff : null}
                            loading={isImproving}
                            onAccept={onAccept}
                            onReject={onReject}
                          />
                        )}
                      </AnimatePresence>
                    </motion.li>
                  );
                })}
              </ul>
            </motion.div>
          );
        })}

        {!hasDiff && improvingBulletId === null && sections.length > 0 && (
          <p className="text-xs text-slate-400 text-center pt-2 select-none">
            Click any bullet to get an instant AI rewrite ✨
          </p>
        )}
      </div>
    </div>
  );
}

function ResumeSkeleton() {
  return (
    <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-6 space-y-6 animate-pulse">
      <div className="space-y-2 pb-5 border-b border-slate-100">
        <div className="h-6 w-48 rounded bg-slate-200" />
        <div className="h-3.5 w-32 rounded bg-slate-100" />
        <div className="h-3 w-64 rounded bg-slate-100" />
      </div>
      {[0, 1, 2].map(i => (
        <div key={i} className="space-y-2">
          <div className="h-3 w-28 rounded bg-slate-200" />
          <div className="h-px w-full bg-slate-100" />
          <div className="h-3 w-full rounded bg-slate-100" />
          <div className="h-3 w-5/6 rounded bg-slate-100" />
          <div className="h-3 w-4/5 rounded bg-slate-100" />
          <div className="h-3 w-3/4 rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MODES: WorkspaceMode[] = ['resume', 'interview', 'cover'];
const isValidMode = (m: string | null): m is WorkspaceMode =>
  VALID_MODES.includes(m as WorkspaceMode);

export default function WorkspacePage() {
  const [searchParams] = useSearchParams();
  const navigate       = useNavigate();

  const { setWorkspaceMode, workspaceMode } = useSessionStore();
  const user = useAuthStore(s => s.user);

  // ── Document store ─────────────────────────────────────────────────────────
  const {
    resumeRawText,
    activeCvFilename,
    activeJobDescription,
    isLoadingResume,
    pendingDiff,
    improvingBulletId,
    lastRewriteFailed,
    currentAtsScore,
    missingSkills,
    matchedSkills,
    atsGaps,
    applyDiff,
    rejectDiff,
    bumpAtsScore,
    improveBullet,
    loadLatestResume,
  } = useDocumentStore();

  // ── Chat store ─────────────────────────────────────────────────────────────
  const messages         = useChatStore(s => s.messages);
  const chatIsGenerating = useChatStore(s => s.isGenerating);
  const addMessage       = useChatStore(s => s.addMessage);
  const setIsGenerating  = useChatStore(s => s.setIsGenerating);

  // ── Local state ────────────────────────────────────────────────────────────
  const [isChatFocused, setIsChatFocused] = useState(false);
  const [focusedBullet, setFocusedBullet] = useState<ResumeBullet | null>(null);
  const [attempted,     setAttempted]     = useState(false);

  // ── Refresh hydration ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    if (resumeRawText) { setAttempted(true); return; }
    loadLatestResume(user.id).then(() => setAttempted(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!attempted || isLoadingResume) return;
    if (!resumeRawText) navigate('/dashboard', { replace: true });
  }, [attempted, isLoadingResume, resumeRawText, navigate]);

  // ── URL mode ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const m = searchParams.get('mode');
    setWorkspaceMode(isValidMode(m) ? m : 'resume');
  }, [searchParams, setWorkspaceMode]);

  const mode = workspaceMode ?? 'resume';

  // ── Parse resume text → sections ──────────────────────────────────────────
  const parsedSections = useMemo(
    () => (resumeRawText ? parseResumeToSections(resumeRawText) : null),
    [resumeRawText],
  );

  const resumeHeader = useMemo((): ResumeHeader => {
    if (!resumeRawText) return { name: '', title: '', contact: '' };
    const fl = resumeRawText.split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(0, 6);
    return {
      name:    fl[0] ?? '',
      title:   fl[1] ?? activeCvFilename ?? '',
      contact: fl.slice(2, 4).filter(l =>
        /[@]/.test(l) || /\+?\d[\d\s\-().]{4,}/.test(l) || l.length < 60,
      ).join('  ·  '),
    };
  }, [resumeRawText, activeCvFilename]);

  const [sections, setSections] = useState<ResumeSection[]>(() => parsedSections ?? []);

  useEffect(() => {
    if (parsedSections && parsedSections.length > 0) setSections(parsedSections);
  }, [parsedSections]);

  // ── Live client-side ATS score ─────────────────────────────────────────────
  // Used when backend score hasn't been computed yet.
  const liveAtsScore = useMemo(() => {
    if (!resumeRawText || !activeJobDescription) return null;
    return calculateAtsScore(resumeRawText, activeJobDescription);
  }, [resumeRawText, activeJobDescription]);

  // Live missing keywords (client-side, shown when backend list is empty)
  const liveMissingKeywords = useMemo(() => {
    if (missingSkills.length > 0) return [];  // backend list takes precedence
    if (!resumeRawText || !activeJobDescription) return [];
    return getMissingKeywords(resumeRawText, activeJobDescription);
  }, [resumeRawText, activeJobDescription, missingSkills]);

  const effectiveMissing = missingSkills.length > 0 ? missingSkills : liveMissingKeywords;

  // ── Mascot state machine (PRD §4.4) ───────────────────────────────────────
  const macState: MacState =
    isLoadingResume            ? 'processing' :
    improvingBulletId !== null ? 'processing' :
    chatIsGenerating           ? 'processing' :
    lastRewriteFailed          ? 'warning'    :
    isChatFocused              ? 'listening'  :
    (pendingDiff !== null && pendingDiff.scoreImpact >= 6) ? 'success' :
    'idle';

  // The speech bubble shows the latest Mac response, falling back to
  // contextual coaching text when no chat history exists.
  const lastMacMsg = [...messages].reverse().find(m => m.role === 'assistant');

  const macSays: string = lastMacMsg
    ? lastMacMsg.content.slice(0, 180)
    : isLoadingResume
      ? 'Loading your resume…'
      : improvingBulletId !== null
        ? 'Rewriting your bullet against the job description…'
        : chatIsGenerating
          ? 'Thinking…'
          : lastRewriteFailed
            ? 'Something went wrong. Try a different bullet or check your connection.'
            : pendingDiff !== null
              ? `Accept to add +${pendingDiff.scoreImpact} ATS points. Reject to try again.`
              : focusedBullet !== null
                ? `"${focusedBullet.text.slice(0, 60)}…" is selected — click a keyword chip to inject it.`
                : sections.length > 0
                  ? 'Click any bullet to improve it with AI. I\'ll target this exact job.'
                  : 'Loading your resume…';

  // ── AbortControllers ───────────────────────────────────────────────────────
  const abortRef     = useRef<AbortController | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);

  // ── Bullet click ───────────────────────────────────────────────────────────
  const handleBulletClick = useCallback((bullet: ResumeBullet, _section: ResumeSection) => {
    if (!resumeRawText) return;
    if (bullet.text.trim().length < MIN_BULLET_LEN) return;

    // Toggle focus — clicking the same bullet again unfocuses it
    setFocusedBullet(prev => prev?.id === bullet.id ? null : bullet);

    if (bullet.id === improvingBulletId) return;
    if (pendingDiff?.fieldPath === bullet.id) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    void improveBullet(
      bullet.id,
      bullet.text,
      buildResumeContext(sections, bullet.id),
      abortRef.current.signal,
    );
  }, [resumeRawText, improvingBulletId, pendingDiff, sections, improveBullet]);

  // ── Accept / Reject ────────────────────────────────────────────────────────
  const handleAccept = useCallback(() => {
    if (!pendingDiff) return;
    setSections(prev =>
      prev.map(s => ({
        ...s,
        bullets: s.bullets.map(b =>
          b.id === pendingDiff.fieldPath
            ? { ...b, text: pendingDiff.proposedText }
            : b,
        ),
      })),
    );
    bumpAtsScore(pendingDiff.scoreImpact);
    applyDiff();
    setFocusedBullet(null);
  }, [pendingDiff, applyDiff, bumpAtsScore]);

  const handleReject = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    rejectDiff();
  }, [rejectDiff]);

  // ── Keyword chip click — inject via /api/rewrite-section ──────────────────
  // PRD §4.7: keywords ALWAYS pass through the rewrite pipeline. Never raw.
  const handleKeywordClick = useCallback((keyword: string) => {
    const target = focusedBullet ?? sections[0]?.bullets[0];
    if (!target || target.text.trim().length < MIN_BULLET_LEN) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    // Prepend keyword constraint to the resume context so the rewrite model
    // knows it must include this keyword in its output.
    const ctxWithKw = `[REQUIRED_KEYWORD: ${keyword}] ${buildResumeContext(sections, target.id)}`;
    void improveBullet(target.id, target.text, ctxWithKw, abortRef.current.signal);
  }, [focusedBullet, sections, improveBullet]);

  // ── Chat message ───────────────────────────────────────────────────────────
  const handleSendMessage = useCallback(async (text: string) => {
    addMessage({
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date(),
    });
    setIsGenerating(true);
    chatAbortRef.current?.abort();
    chatAbortRef.current = new AbortController();

    try {
      const result = await apiCoachMessage(
        {
          message:         text,
          job_description: activeJobDescription ?? '',
          resume_context:  buildResumeContext(sections, focusedBullet?.id ?? ''),
          focused_bullet:  focusedBullet?.text ?? '',
          conversation_history: messages.slice(-8).map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
        },
        { signal: chatAbortRef.current.signal },
      );
      addMessage({
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: result.response,
        timestamp: new Date(),
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      addMessage({
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: 'Connection error. Click any bullet for an AI rewrite, or try again.',
        timestamp: new Date(),
      });
    } finally {
      setIsGenerating(false);
    }
  }, [addMessage, setIsGenerating, activeJobDescription, sections, focusedBullet, messages]);

  useEffect(() => () => {
    abortRef.current?.abort();
    chatAbortRef.current?.abort();
  }, []);

  // ── Coaching panel props ───────────────────────────────────────────────────
  const coachingProps: CoachingPanelProps = {
    macState, macSays,
    atsScore: currentAtsScore,
    liveScore: liveAtsScore,
    diff: pendingDiff,
    missingSkills: effectiveMissing,
    matchedSkills,
    atsGaps,
    messages,
    chatIsGenerating,
    onSendMessage:     handleSendMessage,
    onChatFocusChange: setIsChatFocused,
    onKeywordClick:    handleKeywordClick,
    focusedBullet,
  };

  const isHydrating = !attempted || isLoadingResume;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      <DevNav />
      <WorkspaceNavbar
        mode={mode}
        atsScore={currentAtsScore}
        liveScore={liveAtsScore}
      />

      {/*
        pt-[97px] = DevNav (~41px) + WorkspaceNavbar (56px).
        Desktop: flex-row side-by-side. Mobile: full-width + bottom sheet.
      */}
      <div className="flex-1 flex flex-row overflow-hidden pt-[97px]">

        {/* ── Resume panel ──────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto scrollbar-hidden px-4 py-4
                         pb-[22vh] md:pb-4">
          <div className="max-w-2xl mx-auto">
            {isHydrating ? (
              <ResumeSkeleton />
            ) : sections.length > 0 ? (
              <ResumePanel
                header={resumeHeader}
                sections={sections}
                pendingDiff={pendingDiff}
                improvingBulletId={improvingBulletId}
                focusedBullet={focusedBullet}
                onBulletClick={handleBulletClick}
                onAccept={handleAccept}
                onReject={handleReject}
              />
            ) : null}
          </div>
        </main>

        {/* ── Desktop coaching sidebar ─────────────────────────────────── */}
        <aside className="hidden md:flex md:flex-col w-72 lg:w-80 flex-shrink-0
                          border-l border-slate-200 bg-white overflow-hidden">
          <CoachingPanel {...coachingProps} />
        </aside>

      </div>

      {/* ── Mobile bottom sheet ───────────────────────────────────────────── */}
      <div className="md:hidden">
        <MobileBottomSheet {...coachingProps} />
      </div>

    </div>
  );
}
