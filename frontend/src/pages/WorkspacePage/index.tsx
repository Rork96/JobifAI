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
 *   │  [Section header]            │  [MacMascot .webm 120px]      │
 *   │  • Bullet — hover → ✨ icon  │  ╰── speech bubble            │
 *   │    ┌─ SandwichDiffInline ──┐ │                               │
 *   │    │ ✨ AI  +6 pts         │ │  ATS: 58/100                  │
 *   │    │ [Accept]  [Reject]    │ │                               │
 *   │    └──────────────────────┘ │  [TypeScript]  [CI/CD]        │
 *   │  • Bullet 2 (dimmed 40%)    │  ← click to inject            │
 *   │                              │                               │
 *   │                              │  ┌───────────────────────┐   │
 *   │                              │  │  Mac: Great question…  │   │
 *   │                              │  │  You: Make it senior   │   │
 *   │                              │  └───────────────────────┘   │
 *   │                              │  [Ask Mac…]      [Send ▶]    │
 *   └──────────────────────────────┴───────────────────────────────┘
 *
 *   Mobile (<md):
 *   Resume panel = full-width, scrollable.
 *   Coaching = bottom drawer (40vh peek, 78vh expanded, iOS-spring drag).
 *   SandwichDiffInline still renders inline in the resume — never moves.
 *
 * Chat: POST /api/coach — conversational coaching with Mac.
 *   - User types any question → Mac responds in ≤4 sentences.
 *   - macState = 'listening' while ChatInput is focused.
 *   - macState = 'processing' while coach API call is in flight.
 *   - Last Mac message shown in the speech bubble.
 *
 * Keywords: clicking a missing-keyword chip calls improveBullet on the
 *   currently focused bullet, injecting the keyword as a hard constraint.
 *
 * Refresh hydration:
 *   Store hydrated → render immediately.
 *   Store empty    → loadLatestResume(userId) → redirect /dashboard if still empty.
 */

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  motion,
  AnimatePresence,
  useDragControls,
} from 'framer-motion';

import DevNav               from '@/shared/ui/DevNav';
import MacMascot, { type MacState } from '@/shared/ui/MacMascot';
import SandwichDiffInline   from '@/shared/ui/SandwichDiffInline';
import { useSessionStore }  from '@/store/useSessionStore';
import { useAuthStore }     from '@/store/useAuthStore';
import { useDocumentStore, type PendingDiff } from '@/store/useDocumentStore';
import { useChatStore, type ChatMessage }      from '@/store/useChatStore';
import { coachMessage as apiCoachMessage }     from '@/lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WorkspaceMode = 'resume' | 'interview' | 'cover';

interface ResumeBullet  { id: string; text: string; }
interface ResumeSection { id: string; company: string; role: string; period: string; location: string; bullets: ResumeBullet[]; }
interface ResumeHeader  { name: string; title: string; contact: string; }

// ─────────────────────────────────────────────────────────────────────────────
// Resilient 3-pass resume parser
// ─────────────────────────────────────────────────────────────────────────────
//
// Pass 1 — structured bullets (classic CV with -, •, *, 1., etc.)
// Pass 2 — paragraph fallback (dense prose split by blank lines)
// Pass 3 — absolute fallback (every non-empty line is a bullet)
//
// NEVER returns an empty array if rawText has content.

const BULLET_RE         = /^[-•*▪·✓➤→▸]\s+/;
const NUMBERED_RE       = /^\d+[.)]\s+/;
const DATE_RE           = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|20\d{2}|19\d{2}|present|current)\b/i;
const SECTION_HEADER_RE = /^(experience|work history|employment|education|skills|summary|objective|profile|projects|certifications|achievements|publications|references)\s*:?\s*$/i;

const isBullet    = (l: string) => BULLET_RE.test(l) || NUMBERED_RE.test(l);
const stripBullet = (l: string) => l.replace(BULLET_RE, '').replace(NUMBERED_RE, '').trim();
const isDate      = (l: string) => DATE_RE.test(l);
const isHeader    = (l: string) => SECTION_HEADER_RE.test(l) && l.length < 35;

function makeBullet(sectionId: string, idx: number, text: string): ResumeBullet {
  return { id: `${sectionId}-b${idx}`, text: text.trim() };
}

function parseResumeToSections(rawText: string): ResumeSection[] {
  if (!rawText?.trim()) return [];

  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // ── Pass 1: structured parsing (bullet-prefixed lines) ────────────────────
  const sections: ResumeSection[] = [];
  let current: ResumeSection | null = null;
  let si = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isHeader(line)) continue;

    if (isBullet(line)) {
      if (!current) {
        const id = `s${si++}`;
        current = { id, company: 'Experience', role: '', period: '', location: '', bullets: [] };
        sections.push(current);
      }
      const text = stripBullet(line);
      if (text.length >= 8) current.bullets.push(makeBullet(current.id, current.bullets.length, text));

    } else if (isDate(line) && current && !current.period) {
      current.period = line.slice(0, 60);

    } else {
      const next  = lines[i + 1] ?? '';
      const next2 = lines[i + 2] ?? '';
      const looksLikeHeader =
        isBullet(next) || isDate(next) || isBullet(next2) || isDate(next2) || !current;

      if (looksLikeHeader) {
        const id    = `s${si++}`;
        const split = line.match(/^(.+?)\s*(?:\bat\b|[|·—–])\s*(.+)$/i);
        if (split) {
          current = { id, role: split[1].trim(), company: split[2].trim(), period: '', location: '', bullets: [] };
        } else {
          const nextIsRole = next && !isBullet(next) && !isDate(next) && next.length < 60;
          if (nextIsRole) {
            current = { id, company: line, role: next, period: '', location: '', bullets: [] };
            i++;
          } else {
            current = { id, company: line, role: '', period: '', location: '', bullets: [] };
          }
        }
        sections.push(current);
      }
    }
  }

  const structured = sections.filter(s => s.bullets.length > 0);
  if (structured.length > 0) return structured;

  // ── Pass 2: paragraph fallback ────────────────────────────────────────────
  const blocks = rawText
    .split(/\n\s*\n/)
    .map(b => b.replace(/\n/g, ' ').trim())
    .filter(b => b.length >= 15);

  if (blocks.length > 0) {
    const id = 's0';
    return [{
      id, company: 'Experience', role: '', period: '', location: '',
      bullets: blocks.map((text, idx) => makeBullet(id, idx, text)),
    }];
  }

  // ── Pass 3: absolute fallback — every non-empty line ──────────────────────
  const id = 's0';
  return [{
    id, company: 'Resume Content', role: '', period: '', location: '',
    bullets: lines.filter(l => l.length >= 8).map((text, idx) => makeBullet(id, idx, text)),
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MIN_BULLET_LEN = 10;

function buildResumeContext(sections: ResumeSection[], excludeId: string): string {
  return sections
    .flatMap(s => s.bullets)
    .filter(b => b.id !== excludeId)
    .map(b => b.text)
    .join(' | ')
    .slice(0, 1200);
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatInput — the "Ask Mac" text field
// ─────────────────────────────────────────────────────────────────────────────

interface ChatInputProps {
  onSend:          (text: string) => void;
  isGenerating:    boolean;
  onFocusChange:   (focused: boolean) => void;
  placeholder?:    string;
  compact?:        boolean;  // smaller padding for mobile drawer
}

function ChatInput({ onSend, isGenerating, onFocusChange, placeholder = 'Ask Mac for coaching…', compact = false }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isGenerating) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [value, isGenerating, onSend]);

  // Auto-grow textarea up to ~4 lines
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 96) + 'px';
  }, [value]);

  const pad = compact ? 'p-2.5' : 'p-3';

  return (
    <div className={`flex-shrink-0 border-t border-slate-100 bg-white ${pad}`}>
      <div className="flex items-end gap-2 bg-slate-50 rounded-xl border border-slate-200 px-3 py-2 focus-within:border-brand-400 transition-colors">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={isGenerating ? 'Mac is thinking…' : placeholder}
          rows={1}
          disabled={isGenerating}
          className="flex-1 bg-transparent resize-none text-sm text-slate-700 placeholder-slate-400 focus:outline-none disabled:opacity-60"
          style={{ maxHeight: 96, overflowY: 'auto' }}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!value.trim() || isGenerating}
          aria-label="Send message"
          className="flex-shrink-0 w-8 h-8 rounded-lg bg-brand-600 hover:bg-brand-700 active:scale-[0.95]
                     flex items-center justify-center text-white transition-all
                     disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
        >
          {/* Paper-plane icon */}
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
      <p className="mt-1.5 text-[9px] text-slate-400 text-center tracking-wide">
        ↵ send · Shift+↵ new line
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatMessages — scrollable message history
// ─────────────────────────────────────────────────────────────────────────────

function ChatMessages({ messages, isGenerating }: { messages: ChatMessage[]; isGenerating: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isGenerating]);

  const showTyping = isGenerating && (
    messages.length === 0 || messages[messages.length - 1].role === 'user'
  );

  if (messages.length === 0 && !isGenerating) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <p className="text-xs text-slate-400 text-center leading-relaxed">
          Ask Mac anything —<br />
          <span className="text-slate-300">strategy, wording, keywords…</span>
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

      {/* Mac typing indicator */}
      {showTyping && (
        <div className="flex justify-start">
          <div className="bg-slate-100 px-3 py-2.5 rounded-2xl rounded-bl-sm">
            <div className="flex gap-1 items-center h-4">
              <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
              <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:120ms]" />
              <div className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:240ms]" />
            </div>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Navbar
// ─────────────────────────────────────────────────────────────────────────────

function WorkspaceNavbar({ mode, atsScore }: { mode: WorkspaceMode; atsScore: number | null }) {
  const navigate = useNavigate();
  const user     = useAuthStore(s => s.user);
  const BADGE = {
    resume:    { label: 'Fix Resume',     cls: 'bg-brand-100 text-brand-700' },
    interview: { label: 'Interview Prep', cls: 'bg-blue-100 text-blue-700'   },
    cover:     { label: 'Cover Letter',   cls: 'bg-pink-100 text-pink-700'   },
  };
  const b = BADGE[mode];
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
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${b.cls}`}>{b.label}</span>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1 text-xs">
            <span className="text-slate-400 font-medium">ATS</span>
            {atsScore !== null ? (
              <span className={`font-bold tabular-nums ${
                atsScore >= 70 ? 'text-green-600' :
                atsScore >= 40 ? 'text-amber-600' :
                'text-red-600'
              }`}>
                {atsScore}<span className="text-slate-300 font-normal">/100</span>
              </span>
            ) : <span className="text-slate-400">—</span>}
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
  diff:              PendingDiff | null;
  missingSkills:     string[];
  matchedSkills:     string[];
  atsGaps:           string[];
  // Chat
  messages:          ChatMessage[];
  chatIsGenerating:  boolean;
  onSendMessage:     (text: string) => void;
  onChatFocusChange: (focused: boolean) => void;
  // Keywords
  onKeywordClick:    (keyword: string) => void;
  focusedBullet:     ResumeBullet | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Desktop CoachingPanel — Mac's right sidebar
// ─────────────────────────────────────────────────────────────────────────────

function CoachingPanel({
  macState, macSays, atsScore, diff,
  missingSkills, matchedSkills, atsGaps,
  messages, chatIsGenerating, onSendMessage, onChatFocusChange,
  onKeywordClick, focusedBullet,
}: CoachingPanelProps) {

  const displayMissing: string[] = missingSkills.length > 0
    ? missingSkills.slice(0, 8)
    : atsGaps
        .map(g => { const m = g.match(/["']([^"']+)["']/); return m ? m[1] : g; })
        .filter(Boolean)
        .slice(0, 8);

  return (
    // flex-col h-full: fills the aside element perfectly.
    // The chat messages section grows to fill remaining space (flex-1 min-h-0).
    // The chat input is pinned at the bottom (flex-shrink-0).
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── MacMascot + speech bubble ────────────────────────────────────── */}
      <div className="flex-shrink-0 flex flex-col items-center pt-5 pb-3 px-5">
        <MacMascot state={macState} size={120} />

        {/* Speech bubble with CSS triangle pointing UP toward mascot */}
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

      {/* ── ATS score + diff badge ────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-5 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">
              ATS Score
            </p>
            <div className="flex items-baseline gap-1">
              {atsScore !== null ? (
                <>
                  <span className={`text-2xl font-black tabular-nums ${
                    atsScore >= 70 ? 'text-green-600' :
                    atsScore >= 40 ? 'text-amber-600' :
                    'text-red-600'
                  }`}>
                    {atsScore}
                  </span>
                  <span className="text-sm text-slate-400">/100</span>
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
        {atsScore !== null && atsScore < 50 && (
          <p className="mt-1 text-xs text-red-500 font-medium">ATS may auto-reject this resume.</p>
        )}
      </div>

      {/* ── Missing keyword chips ─────────────────────────────────────────── */}
      {displayMissing.length > 0 && (
        <div className="flex-shrink-0 px-5 pb-3">
          <div className="h-px bg-slate-100 mb-3" />
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
            {focusedBullet ? '↓ Click to inject into bullet' : 'Missing Keywords'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {displayMissing.map(kw => (
              <button
                key={kw}
                type="button"
                onClick={() => onKeywordClick(kw)}
                title={focusedBullet ? `Inject "${kw}" into focused bullet` : `Missing: ${kw}`}
                className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200
                           px-2.5 py-1 rounded-full
                           hover:bg-red-100 hover:border-red-300 active:scale-95
                           transition-all cursor-pointer"
              >
                – {kw}
              </button>
            ))}
          </div>

          {/* Matched keywords — collapsed by default, subtle */}
          {matchedSkills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {matchedSkills.slice(0, 6).map(kw => (
                <span
                  key={kw}
                  className="text-[10px] font-semibold text-green-700 bg-green-50 border border-green-200
                             px-2 py-0.5 rounded-full"
                >
                  ✓ {kw}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Divider before chat ───────────────────────────────────────────── */}
      <div className="flex-shrink-0 mx-5 h-px bg-slate-100" />

      {/* ── Chat messages — grows to fill remaining space ─────────────────── */}
      <ChatMessages messages={messages} isGenerating={chatIsGenerating} />

      {/* ── Chat input — always pinned at bottom of panel ─────────────────── */}
      <ChatInput
        onSend={onSendMessage}
        isGenerating={chatIsGenerating}
        onFocusChange={onChatFocusChange}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile Bottom Drawer — iOS-style coaching panel
// ─────────────────────────────────────────────────────────────────────────────

const DRAWER_PEEK = '40vh';
const DRAWER_FULL = '78vh';

function MobileDrawer(props: CoachingPanelProps) {
  const {
    macState, macSays, atsScore, diff,
    missingSkills, atsGaps,
    messages, chatIsGenerating, onSendMessage, onChatFocusChange,
    onKeywordClick, focusedBullet,
  } = props;

  const dragControls = useDragControls();
  const [isOpen, setIsOpen] = useState(false);

  const displayMissing: string[] = missingSkills.length > 0
    ? missingSkills.slice(0, 6)
    : atsGaps
        .map(g => { const m = g.match(/["']([^"']+)["']/); return m ? m[1] : g; })
        .filter(Boolean)
        .slice(0, 6);

  return (
    <>
      {/* Scrim — blurred backdrop when expanded */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            key="scrim"
            className="fixed inset-0 z-30 pointer-events-auto"
            style={{
              backdropFilter: 'blur(4px)',
              WebkitBackdropFilter: 'blur(4px)',
              background: 'rgba(0,0,0,0.10)',
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setIsOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Drawer — fixed bottom, z-40 above scrim */}
      <motion.div
        className="fixed bottom-0 left-0 right-0 z-40 bg-white rounded-t-[28px] shadow-[0_-8px_40px_rgba(0,0,0,0.12)]
                   flex flex-col overflow-hidden"
        animate={{ height: isOpen ? DRAWER_FULL : DRAWER_PEEK }}
        initial={false}
        transition={{ type: 'spring', damping: 32, stiffness: 320, mass: 0.9 }}
        drag="y"
        dragControls={dragControls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.1}
        onDragEnd={(_, info) => {
          if (info.velocity.y > 200 || info.offset.y > 80)  setIsOpen(false);
          if (info.velocity.y < -200 || info.offset.y < -80) setIsOpen(true);
        }}
      >

        {/* ── iOS drag handle (also tap to toggle) ──────────────────────── */}
        <div
          className="flex-shrink-0 flex flex-col items-center pt-3 pb-2
                     cursor-grab active:cursor-grabbing select-none"
          onPointerDown={e => dragControls.start(e)}
          onClick={() => setIsOpen(o => !o)}
        >
          <div className="w-9 h-[5px] rounded-full bg-slate-300" />
        </div>

        {/* ── Peek row — always visible ─────────────────────────────────── */}
        {/*
          Always-visible strip: mascot (48px) + speech bubble + ATS badge.
          Height: ~72px. Clicking it toggles open/close.
        */}
        <div
          className="flex-shrink-0 flex items-center gap-3 px-4 pb-3 cursor-pointer"
          onClick={() => !isOpen && setIsOpen(true)}
        >
          <MacMascot state={macState} size={48} />

          <div className="flex-1 min-w-0 rounded-2xl bg-slate-100 border border-slate-200 px-3 py-2">
            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-0.5">
              Mac says
            </p>
            <p className="text-sm text-slate-700 leading-snug line-clamp-2">{macSays}</p>
          </div>

          {atsScore !== null && (
            <div className="flex-shrink-0 text-right">
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-0.5">
                ATS
              </p>
              <p className={`text-xl font-black tabular-nums leading-none ${
                atsScore >= 70 ? 'text-green-600' :
                atsScore >= 40 ? 'text-amber-600' :
                'text-red-600'
              }`}>
                {atsScore}
              </p>
            </div>
          )}
          {diff && (
            <span className="flex-shrink-0 text-[10px] font-bold text-green-700 bg-green-50 border border-green-200
                             px-2 py-0.5 rounded-full whitespace-nowrap">
              +{diff.scoreImpact}pts
            </span>
          )}
        </div>

        {/* ── Expanded content — visible when open ──────────────────────── */}
        {/*
          This section takes all remaining height.
          It itself is flex-col so keywords sit on top and chat fills the rest.
          overflow-hidden on this + flex-1 inside ChatMessages to keep scrolling correct.
        */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          {/* Keyword chips */}
          {displayMissing.length > 0 && (
            <div className="flex-shrink-0 px-4 py-3 border-t border-slate-100">
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                {focusedBullet ? '↓ Click to inject into bullet' : 'Missing Keywords'}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {displayMissing.map(kw => (
                  <button
                    key={kw}
                    type="button"
                    onClick={() => onKeywordClick(kw)}
                    className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200
                               px-2.5 py-1 rounded-full hover:bg-red-100 active:scale-95 transition-all"
                  >
                    – {kw}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Chat messages — grows to fill remaining drawer space */}
          <ChatMessages messages={messages} isGenerating={chatIsGenerating} />

          {/* Chat input — pinned at bottom of drawer */}
          <ChatInput
            onSend={onSendMessage}
            isGenerating={chatIsGenerating}
            onFocusChange={onChatFocusChange}
            compact
          />
        </div>

      </motion.div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ResumePanel — live editable document
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

      {/* Header */}
      <div className="border-b border-slate-100 p-5 sm:p-7">
        <h2 className="text-xl sm:text-2xl font-black text-slate-900">{header.name || 'Your Resume'}</h2>
        {header.title   && <p className="text-sm font-semibold text-brand-600 mt-0.5">{header.title}</p>}
        {header.contact && <p className="text-xs text-slate-400 mt-1">{header.contact}</p>}
      </div>

      {/* Sections */}
      <div className="p-5 sm:p-7 space-y-7">

        {sections.map(section => {
          const sectionHasTarget =
            (hasDiff && section.bullets.some(b => b.id === pendingDiff?.fieldPath)) ||
            section.bullets.some(b => b.id === improvingBulletId);
          const sectionDimmed = (hasDiff || improvingBulletId !== null) && !sectionHasTarget;

          return (
            <motion.div
              key={section.id}
              layout
              className={`transition-opacity duration-300 ${sectionDimmed ? 'opacity-40' : ''}`}
            >
              {/* Section header */}
              {(section.role || section.company) && (
                <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 mb-3">
                  <div>
                    {section.role    && <span className="font-bold text-slate-900 text-sm">{section.role}</span>}
                    {section.role && section.company && <span className="text-slate-400 text-sm"> · </span>}
                    {section.company && <span className="font-semibold text-slate-700 text-sm">{section.company}</span>}
                  </div>
                  {(section.period || section.location) && (
                    <span className="text-xs text-slate-400 tabular-nums">
                      {[section.period, section.location].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
              )}

              {/* Bullets */}
              <ul className="space-y-1.5">
                {section.bullets.map(bullet => {
                  const isImproving   = bullet.id === improvingBulletId;
                  const isTargeted    = hasDiff && bullet.id === pendingDiff?.fieldPath;
                  const isFocused     = focusedBullet?.id === bullet.id && !isTargeted && !isImproving;
                  const isDimmed      = (hasDiff || improvingBulletId !== null) && !isTargeted && !isImproving && sectionHasTarget;
                  const isHighlighted = isTargeted || isImproving;
                  const isImprovable  = bullet.text.trim().length >= MIN_BULLET_LEN;

                  return (
                    <motion.li key={bullet.id} layout>
                      <div
                        role="button"
                        tabIndex={isImprovable ? 0 : -1}
                        onClick={() => onBulletClick(bullet, section)}
                        onKeyDown={e => e.key === 'Enter' && onBulletClick(bullet, section)}
                        aria-label={isImprovable ? `Improve bullet: ${bullet.text.slice(0, 50)}` : undefined}
                        aria-disabled={!isImprovable}
                        className={`
                          flex items-start gap-2 text-sm leading-relaxed
                          transition-all duration-200 rounded-lg select-none
                          ${isDimmed ? 'opacity-40 pointer-events-none' : ''}
                          ${isHighlighted
                            ? 'bg-amber-50 border border-amber-200 px-3 py-2 -mx-3 cursor-default'
                            : isFocused
                              ? 'bg-brand-50 border border-brand-200 px-3 py-2 -mx-3 cursor-pointer'
                              : isImprovable
                                ? 'px-0 py-0.5 cursor-pointer hover:bg-slate-50 hover:-mx-2 hover:px-2 group'
                                : 'px-0 py-0.5 cursor-default opacity-60'
                          }
                        `}
                      >
                        {/* Bullet dot */}
                        <span className={`mt-2 flex-shrink-0 w-1.5 h-1.5 rounded-full transition-colors
                          ${isHighlighted ? 'bg-amber-500' :
                            isFocused     ? 'bg-brand-500' :
                            'bg-slate-300 group-hover:bg-brand-400'
                          }`}
                        />

                        {/* Bullet text */}
                        <span className={
                          isHighlighted ? 'text-amber-900 font-medium' :
                          isFocused     ? 'text-brand-900 font-medium' :
                          'text-slate-700'
                        }>
                          {bullet.text}
                        </span>

                        {/* Right-side badge */}
                        {isHighlighted && !isImproving && (
                          <span className="ml-auto flex-shrink-0 text-[10px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full self-start mt-0.5">
                            original
                          </span>
                        )}
                        {isImproving && (
                          <span className="ml-auto flex-shrink-0 text-[10px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full self-start mt-0.5 flex items-center gap-1">
                            <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                            </svg>
                            rewriting…
                          </span>
                        )}
                        {isFocused && (
                          <span className="ml-auto flex-shrink-0 text-[10px] font-bold text-brand-600 bg-brand-50 border border-brand-200 px-2 py-0.5 rounded-full self-start mt-0.5 hidden group-[:not(.group)]:flex items-center gap-0.5">
                            focused
                          </span>
                        )}

                        {/* Hover action hint */}
                        {!isHighlighted && !isFocused && isImprovable && (
                          <span className="ml-auto flex-shrink-0 opacity-0 group-hover:opacity-100 text-[10px] font-bold text-brand-600 bg-brand-50 border border-brand-200 px-2 py-0.5 rounded-full self-start mt-0.5 transition-opacity">
                            ✨ improve
                          </span>
                        )}
                      </div>

                      {/* Sandwich diff — renders inline below the targeted bullet */}
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

        {/* Bottom hint when idle */}
        {!hasDiff && improvingBulletId === null && sections.length > 0 && (
          <p className="text-xs text-slate-400 text-center pt-2 select-none">
            Click any bullet to get an instant AI rewrite ✨
          </p>
        )}
      </div>
    </div>
  );
}

// Loading skeleton while hydrating
function ResumeSkeleton() {
  return (
    <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-6 space-y-5 animate-pulse">
      <div className="space-y-2 pb-5 border-b border-slate-100">
        <div className="h-6 w-48 rounded bg-slate-200"/>
        <div className="h-3.5 w-32 rounded bg-slate-100"/>
        <div className="h-3 w-64 rounded bg-slate-100"/>
      </div>
      {[0, 1, 2].map(i => (
        <div key={i} className="space-y-2">
          <div className="h-3.5 w-40 rounded bg-slate-200"/>
          <div className="h-3 w-full rounded bg-slate-100"/>
          <div className="h-3 w-5/6 rounded bg-slate-100"/>
          <div className="h-3 w-3/4 rounded bg-slate-100"/>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MODES: WorkspaceMode[] = ['resume', 'interview', 'cover'];
const isValidMode = (m: string | null): m is WorkspaceMode => VALID_MODES.includes(m as WorkspaceMode);

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

  // ── Local UI state ─────────────────────────────────────────────────────────
  const [isChatFocused,  setIsChatFocused]  = useState(false);
  const [focusedBullet,  setFocusedBullet]  = useState<ResumeBullet | null>(null);
  const [attempted,      setAttempted]      = useState(false);

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
    const modeParam = searchParams.get('mode');
    setWorkspaceMode(isValidMode(modeParam) ? modeParam : 'resume');
  }, [searchParams, setWorkspaceMode]);

  const mode = workspaceMode ?? 'resume';

  // ── Parse resume text ──────────────────────────────────────────────────────
  const parsedSections = useMemo(
    () => (resumeRawText ? parseResumeToSections(resumeRawText) : null),
    [resumeRawText],
  );

  const resumeHeader = useMemo((): ResumeHeader => {
    if (!resumeRawText) return { name: '', title: '', contact: '' };
    const fl = resumeRawText.split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(0, 5);
    return {
      name:    fl[0] ?? '',
      title:   fl[1] ?? activeCvFilename ?? '',
      contact: fl.slice(2, 4).join(' · '),
    };
  }, [resumeRawText, activeCvFilename]);

  const [sections, setSections] = useState<ResumeSection[]>(() => parsedSections ?? []);

  useEffect(() => {
    if (parsedSections && parsedSections.length > 0) setSections(parsedSections);
  }, [parsedSections]);

  // ── Mascot state machine (PRD §4.4) ───────────────────────────────────────
  //
  // Priority (high → low):
  //   1. isLoadingResume / improvingBulletId / chatIsGenerating → processing
  //   2. lastRewriteFailed → warning
  //   3. isChatFocused → listening
  //   4. pendingDiff.scoreImpact ≥ 6 → success
  //   5. else → idle
  const macState: MacState =
    isLoadingResume            ? 'processing' :
    improvingBulletId !== null ? 'processing' :
    chatIsGenerating           ? 'processing' :
    lastRewriteFailed          ? 'warning'    :
    isChatFocused              ? 'listening'  :
    (pendingDiff !== null && pendingDiff.scoreImpact >= 6) ? 'success' :
    'idle';

  // The speech bubble shows the latest Mac chat message if available,
  // otherwise falls back to contextual coaching text.
  const lastMacMsg = [...messages].reverse().find(m => m.role === 'assistant');

  const macSays: string = lastMacMsg
    ? lastMacMsg.content.slice(0, 160)
    : isLoadingResume
      ? 'Loading your resume…'
      : improvingBulletId !== null
        ? 'Rewriting your bullet against the job description…'
        : chatIsGenerating
          ? 'Thinking…'
          : lastRewriteFailed
            ? 'Something went wrong. Try a different bullet or check your connection.'
            : pendingDiff !== null
              ? `Nice — accept to add +${pendingDiff.scoreImpact} ATS points. Reject to try again.`
              : focusedBullet !== null
                ? 'Bullet selected. Click a keyword chip to inject it, or click Improve.'
                : sections.length > 0
                  ? 'Click any bullet to improve it with AI. I\'ll target this exact job.'
                  : 'Loading your resume…';

  // ── AbortController for bullet rewrite ────────────────────────────────────
  const abortRef = useRef<AbortController | null>(null);

  // ── Chat AbortController ───────────────────────────────────────────────────
  const chatAbortRef = useRef<AbortController | null>(null);

  // ── Bullet click ───────────────────────────────────────────────────────────
  const handleBulletClick = useCallback((bullet: ResumeBullet, _section: ResumeSection) => {
    if (!resumeRawText) return;
    if (bullet.text.trim().length < MIN_BULLET_LEN) return;

    // Set focused bullet for keyword injection context
    setFocusedBullet(prev => prev?.id === bullet.id ? null : bullet);

    // If already improving or this is the targeted diff bullet, don't re-fire
    if (bullet.id === improvingBulletId) return;
    if (pendingDiff?.fieldPath === bullet.id) return;

    // Start the rewrite
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

  // ── Keyword chip click — inject via rewrite pipeline ──────────────────────
  // PRD §4.7: Keywords always pass through the rewrite pipeline. Never raw inject.
  const handleKeywordClick = useCallback((keyword: string) => {
    // Prefer the focused bullet; fall back to the first bullet in the first section
    const target = focusedBullet ?? sections[0]?.bullets[0];
    if (!target) return;
    if (target.text.trim().length < MIN_BULLET_LEN) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    // Inject keyword as extra context in the rewrite prompt
    // buildResumeContext excludes the target bullet
    const ctxWithKeyword = `[REQUIRED KEYWORD: ${keyword}] ${buildResumeContext(sections, target.id)}`;
    void improveBullet(
      target.id,
      target.text,
      ctxWithKeyword,
      abortRef.current.signal,
    );
  }, [focusedBullet, sections, improveBullet]);

  // ── Send chat message to Mac ───────────────────────────────────────────────
  const handleSendMessage = useCallback(async (text: string) => {
    // Add user message immediately
    const userMsg: ChatMessage = {
      id:        `u-${Date.now()}`,
      role:      'user',
      content:   text,
      timestamp: new Date(),
    };
    addMessage(userMsg);
    setIsGenerating(true);

    chatAbortRef.current?.abort();
    chatAbortRef.current = new AbortController();

    try {
      const result = await apiCoachMessage(
        {
          message:              text,
          job_description:      activeJobDescription ?? '',
          resume_context:       buildResumeContext(sections, focusedBullet?.id ?? ''),
          focused_bullet:       focusedBullet?.text ?? '',
          conversation_history: messages.slice(-8).map(m => ({
            role:    m.role as 'user' | 'assistant',
            content: m.content,
          })),
        },
        { signal: chatAbortRef.current.signal },
      );

      const assistantMsg: ChatMessage = {
        id:        `a-${Date.now()}`,
        role:      'assistant',
        content:   result.response,
        timestamp: new Date(),
      };
      addMessage(assistantMsg);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const errMsg: ChatMessage = {
        id:        `err-${Date.now()}`,
        role:      'assistant',
        content:   'Connection error. Try again or click a bullet to get an AI rewrite.',
        timestamp: new Date(),
      };
      addMessage(errMsg);
    } finally {
      setIsGenerating(false);
    }
  }, [addMessage, setIsGenerating, activeJobDescription, sections, focusedBullet, messages]);

  // Cleanup on unmount
  useEffect(() => () => {
    abortRef.current?.abort();
    chatAbortRef.current?.abort();
  }, []);

  // ── Coaching panel props ───────────────────────────────────────────────────
  const coachingProps: CoachingPanelProps = {
    macState, macSays,
    atsScore: currentAtsScore,
    diff: pendingDiff,
    missingSkills, matchedSkills, atsGaps,
    messages, chatIsGenerating,
    onSendMessage: handleSendMessage,
    onChatFocusChange: setIsChatFocused,
    onKeywordClick: handleKeywordClick,
    focusedBullet,
  };

  const isHydrating = !attempted || isLoadingResume;

  // ── Render ─────────────────────────────────────────────────────────────────
  //
  // Desktop (md+):
  //   Fixed navbar → flex-row:
  //   │ Resume (flex-1 overflow-y-auto) │ CoachingPanel (w-72/80, h-full) │
  //
  // Mobile (<md):
  //   Full-width resume with pb-[40vh] to clear the drawer.
  //   MobileDrawer fixed at bottom (z-40).

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      <DevNav />
      <WorkspaceNavbar mode={mode} atsScore={currentAtsScore} />

      {/*
        Main layout area below both fixed navbars.
        pt-[97px] = DevNav (~41px) + WorkspaceNavbar (56px).
        Desktop: flex-row side-by-side. Mobile: single column.
      */}
      <div className="flex-1 flex flex-row overflow-hidden pt-[97px]">

        {/* ── Resume panel ──────────────────────────────────────────────────── */}
        {/*
          On mobile: pb-[42vh] keeps content clear of the 40vh drawer.
          On desktop: normal pb-4.
        */}
        <main className="flex-1 overflow-y-auto scrollbar-hidden px-4 py-4
                         pb-[42vh] md:pb-4">
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

        {/* ── Desktop coaching sidebar — hidden on mobile ────────────────────── */}
        {/*
          overflow-hidden (not overflow-y-auto) — CoachingPanel controls its own
          internal scroll via ChatMessages flex-1 + min-h-0.
        */}
        <aside className="hidden md:flex md:flex-col w-72 lg:w-80 flex-shrink-0
                          border-l border-slate-200 bg-white overflow-hidden">
          <CoachingPanel {...coachingProps} />
        </aside>

      </div>

      {/* ── Mobile bottom drawer — hidden on desktop ───────────────────────── */}
      <div className="md:hidden">
        <MobileDrawer {...coachingProps} />
      </div>

    </div>
  );
}
