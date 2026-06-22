/**
 * WorkspacePage — Phase 4: Interaction Layer
 * FRONTEND_RULES.md Rule 1: dumb renderer + action dispatcher.
 *   - No business logic, no API calls, no parsing.
 *   - All state lives in useDocumentStore.
 *   - Components only render state and dispatch actions.
 *
 * Design: Claude (Anthropic) warm parchment system — DESIGN.md
 */

import React, { useRef, useState, useCallback, useEffect, Fragment } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDocumentStore } from '@/store/useDocumentStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useBillingStore } from '@/store/useBillingStore';
import { useChatStore } from '@/store/useChatStore';
import { saveResume, getResumeById } from '@/lib/db';
import SandwichDiffInline from '@/components/document/SandwichDiffInline';
import PrintTemplate from '@/components/document/PrintTemplate';
import InlineEdit from '@/components/ui/InlineEdit';
import { generateRewrite, generateChatResponse } from '@/lib/api';
import { scrollToElement } from '@/lib/scrollUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (pure — no side effects)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a mascot message string into React nodes.
 * Supported tokens:
 *   `word`       → slate grey pill badge  (backtick-wrapped keyword)
 *   [Key: word]  → slate grey pill badge  (legacy format, kept for safety)
 *   **text**     → bold span
 *   everything else → plain text
 */
function renderMessageContent(content: string): React.ReactNode {
  // Group 1: backtick code span  `word`
  // Group 2: legacy [Key: word]
  // Group 3: bold **text**
  const TOKEN = /`([^`]+)`|\[Key:\s*([^\]]+)\]|\*\*([^*]+)\*\*/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = TOKEN.exec(content)) !== null) {
    if (m.index > last) {
      nodes.push(content.slice(last, m.index));
    }
    if (m[1] !== undefined || m[2] !== undefined) {
      // Keyword pill — backtick or legacy [Key: ...] format
      const label = (m[1] ?? m[2]).trim();
      nodes.push(
        <span
          key={m.index}
          style={{
            display: 'inline-block',
            background: '#e8e6dc',
            color: '#5e5d59',
            borderRadius: 999,
            fontSize: '0.7rem',
            fontWeight: 600,
            padding: '1px 7px',
            margin: '0 2px',
            verticalAlign: 'middle',
            lineHeight: 1.6,
          }}
        >
          {label}
        </span>,
      );
    } else if (m[3] !== undefined) {
      // Bold
      nodes.push(<strong key={m.index}>{m[3]}</strong>);
    }
    last = m.index + m[0].length;
  }

  if (last < content.length) nodes.push(content.slice(last));
  return nodes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function WorkspacePage() {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();

  // ── Render telemetry — remove once WSOD is confirmed fixed ───────────────

  // ── Store reads ────────────────────────────────────────────────────────────
  // Arrays are normalised to [] at the selector boundary so downstream code
  // (dep arrays, .map, .length) never sees null/undefined — not even transiently.
  const resumeSections  = useDocumentStore(s => s.resumeSections  ?? []);
  const candidateName   = useDocumentStore(s => s.candidateName   ?? '');
  const contactInfo     = useDocumentStore(s => s.contactInfo     ?? []);
  const activeBulletId  = useDocumentStore(s => s.activeBulletId);
  const chatMessages    = useDocumentStore(s => s.chatMessages    ?? []);
  const atsScore        = useDocumentStore(s => s.atsScore);
  const missingKeywords = useDocumentStore(s => s.missingKeywords ?? []);
  const weakBullets     = useDocumentStore(s => s.weakBullets     ?? []);

  // ── Store actions (dispatchers only — Rule 1) ─────────────────────────────
  const setActiveBullet        = useDocumentStore(s => s.setActiveBullet);
  const updateCandidateName    = useDocumentStore(s => s.updateCandidateName);
  const updateContactInfo      = useDocumentStore(s => s.updateContactInfo);
  const updateBulletText       = useDocumentStore(s => s.updateBulletText);
  const addChatMessage  = useDocumentStore(s => s.addChatMessage);
  const acceptRewrite   = useDocumentStore(s => s.acceptRewrite);
  const rejectRewrite   = useDocumentStore(s => s.rejectRewrite);
  const pendingRewrite  = useDocumentStore(s => s.pendingRewrite);
  const loadFromContent   = useDocumentStore(s => s.loadFromContent);
  const activeResumeId    = useDocumentStore(s => s.activeResumeId);
  const jobDescription    = useDocumentStore(s => s.jobDescription);
  const setActiveResumeId = useDocumentStore(s => s.setActiveResumeId);
  const saveStatus        = useDocumentStore(s => s.saveStatus);
  const setSaveStatus     = useDocumentStore(s => s.setSaveStatus);

  const user        = useAuthStore(s => s.user);
  const isPremium   = useAuthStore(s => s.isPremium);
  const freeRewrites = useAuthStore(s => s.freeRewrites);
  const openPaywall = useBillingStore(s => s.openPaywall);
  // BYOK users have entered their own Gemini key — they bypass all quota limits.
  const byokApiKey  = useChatStore(s => s.byokApiKey);

  // ── Local UI state ─────────────────────────────────────────────────────────
  const [chatInput, setChatInput] = useState('');
  // True while getResumeById is in-flight on a hard refresh to /workspace/:id.
  // Prevents rendering "No document loaded" before the DB fetch completes.
  const [isLoadingResume, setIsLoadingResume] = useState(!!routeId);

  const documentRef        = useRef<HTMLDivElement>(null);
  const autoSaveTimer      = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Prevents concurrent initial-save + auto-save from both INSERTing new rows
  const isSavingInitial    = useRef(false);
  // Ensures Mac greets exactly once per workspace session
  const hasGreeted         = useRef(false);

  // ── Mount: load resume from DB if navigated to /workspace/:id ─────────────
  useEffect(() => {
    if (!routeId) return;
    setIsLoadingResume(true);
    getResumeById(routeId).then(({ data, error }) => {
      if (error || !data) {
        // Resume was deleted or doesn't exist — redirect gracefully
        console.warn('[Workspace] Resume not found, redirecting to dashboard:', routeId, error);
        navigate('/dashboard', { replace: true });
        return;
      }
      // Guard 3: null-coalesce content — DB JSONB column can be null for new rows
      loadFromContent(data.id, data.content ?? {}, data.ats_score);
      setIsLoadingResume(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  // ── Shared save helper ────────────────────────────────────────────────────
  const persistNow = useCallback(async () => {
    if (!user) return;
    const store = useDocumentStore.getState();
    if (store.resumeSections.length === 0 || !store.candidateName) {
      console.warn('⚠️ [Workspace] Save aborted: Document is empty.');
      return;
    }
    // Don't race with the initial INSERT — wait until it's done
    if (!store.activeResumeId && isSavingInitial.current) return;

    setSaveStatus('saving');
    const title = store.candidateName && store.candidateName !== 'Unknown'
      ? `${store.candidateName}'s Resume`
      : 'Untitled Resume';
    const content = {
      sections:       store.resumeSections,
      candidateName:  store.candidateName,
      contactInfo:    store.contactInfo,
      jobDescription: store.jobDescription ?? '',
      chatHistory:    store.chatMessages,
    };
    const id = await saveResume(user?.id ?? '', store.activeResumeId, title, content, store.atsScore ?? 0);
    if (!id || id === 'undefined') {
      console.error('❌ [Workspace] persistNow: saveResume returned invalid ID:', id);
      setSaveStatus('error');
      return;
    }
    setSaveStatus('saved');
    if (!store.activeResumeId) {
      setActiveResumeId(id);
      navigate(`/workspace/${id}`, { replace: true });
    }
  }, [user, setSaveStatus, setActiveResumeId, navigate]);

  // ── Initial save — reactive wait for both store data AND auth to be ready.
  // Deps include user?.id, resumeSections.length, and activeResumeId so the
  // effect re-evaluates on every state change until all conditions are met.
  // Once saveResume returns an id and activeResumeId is set, the activeResumeId
  // guard short-circuits all future runs.
  useEffect(() => {
    // Skip if we're loading an existing resume or one was already saved this session
    if (routeId || activeResumeId) return;

    // No parsed data yet — nothing to save
    if ((resumeSections?.length ?? 0) === 0 || !candidateName) {
      console.warn('⚠️ [Workspace] Save aborted: Document is empty.');
      return;
    }

    // Auth not hydrated yet — wait for next render
    if (!user?.id) return;

    const store = useDocumentStore.getState();
    const title = store.candidateName && store.candidateName !== 'Unknown'
      ? `${store.candidateName}'s Resume`
      : 'Untitled Resume';

    isSavingInitial.current = true;
    setSaveStatus('saving');

    const performInitialSave = async () => {
      const newId = await saveResume(user?.id ?? '', null, title, {
        sections:       store.resumeSections,
        candidateName:  store.candidateName,
        contactInfo:    store.contactInfo,
        jobDescription: store.jobDescription ?? '',
        chatHistory:    store.chatMessages,
      }, store.atsScore ?? 0);

      isSavingInitial.current = false;

      if (!newId || newId === 'undefined') {
        console.error('❌ [Workspace] saveResume returned invalid ID:', newId, '— aborting navigation. Check FK constraint / profile row.');
        setSaveStatus('error');
        return; // DO NOT navigate — avoids /workspace/undefined
      }

      // Set ID immediately to block any concurrent persistNow from INSERTing
      useDocumentStore.getState().setActiveResumeId(newId);
      setSaveStatus('saved');
      window.history.replaceState(null, '', `/workspace/${newId}`);
      navigate(`/workspace/${newId}`, { replace: true });
    };

    performInitialSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, resumeSections?.length ?? 0, routeId, activeResumeId]);

  // ── Mac's greeting ────────────────────────────────────────────────────────
  // Fires when sections are ready AND chat is empty (new resume or no history).
  // 3s fallback covers the DB-load path where sections arrive asynchronously.
  useEffect(() => {
    if ((resumeSections?.length ?? 0) === 0 || hasGreeted.current) return;
    const store = useDocumentStore.getState();
    // Don't greet if this is a loaded resume that already has chat history
    if ((store.chatMessages?.length ?? 0) > 0) { hasGreeted.current = true; return; }
    hasGreeted.current = true;
    addChatMessage(
      'mascot',
      "Hey! I'm Mac. I've analyzed your resume and it's a solid start. " +
      "I've highlighted the weakest spots — let's fix them together to beat those ATS bots!"
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeSections?.length ?? 0]);

  // 3s fallback: covers the case where sections load after the initial effect
  useEffect(() => {
    const t = setTimeout(() => {
      const store = useDocumentStore.getState();
      if (store.resumeSections.length > 0 && !hasGreeted.current && store.chatMessages.length === 0) {
        hasGreeted.current = true;
        store.addChatMessage(
          'mascot',
          "Hey! I'm Mac. I've analyzed your resume and it's a solid start. " +
          "I've highlighted the weakest spots — let's fix them together to beat those ATS bots!"
        );
      }
    }, 3000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Debounced auto-save (2 s after each content change, including chat) ─────
  useEffect(() => {
    if (!user?.id || (resumeSections?.length ?? 0) === 0) return;

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => { persistNow(); }, 2000);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeSections, candidateName, contactInfo, chatMessages, user]);

  // ── Bullet click handler ──────────────────────────────────────────────────
  // Clicking the already-active bullet deselects it (toggle off → general chat).
  // Clicking a new bullet selects it and tells Mac the focus shifted.
  const handleBulletClick = useCallback((bulletId: string) => {
    const { activeBulletId: previous, weakBullets: weak } = useDocumentStore.getState();

    if (previous === bulletId) {
      // Toggle off — return to General Coaching mode
      setActiveBullet(null);
      return;
    }

    setActiveBullet(bulletId);
    // Suggestion is now surfaced in the Live Context banner above the input,
    // not pushed into chat history — no addChatMessage here.
  }, [setActiveBullet]);

  // ── Chat submit ───────────────────────────────────────────────────────────
  // Two paths:
  //   • Bullet selected  → Surgeon agent (generateRewrite) — proposes a diff
  //   • No bullet        → Mentor agent  (generateChatResponse) — general advice
  //
  // Quota enforcement rules (in priority order):
  //   1. Premium users  → unlimited, no check needed.
  //   2. BYOK users     → own Gemini key, bypass all server-side quota.
  //   3. Free users     → must have freeRewrites > 0; hard-block + paywall otherwise.
  //
  // Credit is decremented OPTIMISTICALLY on dispatch (not on success) so:
  //   - The counter updates immediately after the button press (snappy UX).
  //   - Users cannot exploit "fire + navigate away before success" retry loops.
  //   - Server remains authoritative; the frontend value is display-only.
  const handleChatSubmit = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;

    // ── Quota gate ──────────────────────────────────────────────────────────
    // Read fresh state snapshots — don't close over stale selector values.
    const { isPremium: premium, freeRewrites: credits } = useAuthStore.getState();
    const bk = useChatStore.getState().byokApiKey;

    if (!premium && !bk && credits <= 0) {
      // Hard block: no API call is made, paywall opens immediately.
      addChatMessage(
        'mascot',
        "You've used all your free AI actions. Upgrade to Pro for unlimited rewrites and coaching! 🚀",
      );
      useBillingStore.getState().openPaywall('limit_reached');
      return;
    }

    addChatMessage('user', text);
    setChatInput('');
    addChatMessage('mascot', 'Working on it… Give me a second.');

    // Decrement credit immediately on dispatch (only for non-premium, non-BYOK users).
    if (!premium && !bk) {
      useAuthStore.getState().decrementFreeRewrites();
    }

    const store          = useDocumentStore.getState();
    const jobDescription = store.jobDescription;

    // ── Resume context: serialise the full document for Mac ─────────────────
    // Mac reads the real resume on every call — no amnesia, no hallucination.
    // Serialised as compact JSON; backend truncates to 5–6 k chars as needed.
    // candidateName + atsScore included so Mac can reference them by name.
    const resumeContext = JSON.stringify({
      candidateName:   store.candidateName,
      atsScore:        store.atsScore,
      missingKeywords: store.missingKeywords,
      sections:        store.resumeSections,
    });

    if (activeBulletId) {
      // ── Surgeon path — rewrite the selected bullet ──────────────────────
      const bulletId = activeBulletId;
      const originalBullet = store.resumeSections
        .flatMap(s => s.bullets)
        .find(b => b.id === bulletId)?.text ?? '';

      generateRewrite(originalBullet, jobDescription, text, resumeContext)
        .then((results) => {
          if (results.proposedText && results.proposedText.trim() !== '') {
            store.setPendingRewrite(bulletId, results.proposedText);
          } else {
            store.setPendingRewrite(bulletId, null);
          }
          addChatMessage('mascot', results.coachMessage);
        })
        .catch(() => {
          addChatMessage('mascot', 'Could not generate a rewrite. Please try again.');
        });
    } else {
      // ── Mentor path — general career coaching ───────────────────────────
      generateChatResponse(text, jobDescription, store.atsScore, store.missingKeywords, resumeContext)
        .then((results) => {
          addChatMessage('mascot', results.coachMessage);
        })
        .catch(() => {
          addChatMessage('mascot', 'Could not reach the coach right now. Please try again.');
        });
    }
  }, [chatInput, activeBulletId, addChatMessage]);

  // ── PDF export ────────────────────────────────────────────────────────────
  // PDF export is a paid feature ("No PDF export" on the free tier per PaywallModal copy).
  // Gate: premium users and BYOK users can export freely.
  // Free users are sent to the paywall with source tag 'pdf_export'.
  // Sets document.title before window.print() so the browser uses it as the
  // default filename in the Save As dialog (e.g. "Pavlo_Tsyhanash_Resume").
  const handleExport = useCallback(() => {
    // ── Premium / BYOK gate ─────────────────────────────────────────────────
    const { isPremium: premium } = useAuthStore.getState();
    const bk = useChatStore.getState().byokApiKey;

    if (!premium && !bk) {
      useBillingStore.getState().openPaywall('pdf_export');
      return;
    }

    const { candidateName } = useDocumentStore.getState();
    const slug = (candidateName && candidateName !== 'Unknown' ? candidateName : 'Candidate')
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 40);

    const filename      = `${slug}_Resume`;
    const originalTitle = document.title;
    document.title      = filename;

    window.print();

    setTimeout(() => { document.title = originalTitle; }, 1_000);
  }, []);

  // ── Render telemetry ─────────────────────────────────────────────────────
  console.log(
    '🖥️ [Workspace] Rendering.',
    'routeId:', routeId ?? '(none)',
    '| isLoadingResume:', isLoadingResume,
    '| sections:', resumeSections?.length ?? 0,
    '| activeResumeId:', activeResumeId ?? '(none)',
    '| user:', user?.id ?? '(no user)',
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Loading state — DB fetch in-flight on hard refresh to /workspace/:id
  // ─────────────────────────────────────────────────────────────────────────
  if (isLoadingResume) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#f5f4ed]">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-7 w-7 border-t-2 border-b-2 border-[#c96442]" />
          <p className="text-[#87867f] text-sm font-medium" style={{ fontFamily: 'system-ui, Arial, sans-serif' }}>
            Loading resume…
          </p>
          {/* Debug: if spinner stays forever, routeId fetch is hanging */}
          <p className="text-xs text-[#b0aea5]">ID: {routeId}</p>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Empty state — no resume loaded and not currently fetching
  // ─────────────────────────────────────────────────────────────────────────
  if ((resumeSections?.length ?? 0) === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#f5f4ed] gap-5">
        <div className="w-14 h-14 rounded-2xl bg-[#c96442]/10 flex items-center justify-center">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" className="text-[#c96442]">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div className="text-center">
          <p
            className="text-lg font-medium text-[#141413] mb-1"
            style={{ fontFamily: 'Georgia, serif' }}
          >
            No resume loaded
          </p>
          <p className="text-sm text-[#87867f]" style={{ fontFamily: 'system-ui, Arial, sans-serif' }}>
            Go back to the dashboard to open or create a resume.
          </p>
        </div>
        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#141413] hover:bg-[#c96442] transition-colors text-white text-sm font-semibold"
          style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
        >
          ← Back to Dashboard
        </button>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main layout — left: document panel, right: chat panel
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
    <div className="workspace-layout h-screen min-h-screen flex flex-row overflow-hidden bg-[#f5f4ed]">

      {/* ── Document panel ─────────────────────────────────────────────────── */}
      <div className="resume-document-panel flex-1 overflow-y-auto border-r border-[#e8e6dc]">

        {/* ── Toolbar (screen only — hidden when printing) ─────────────────── */}
        <div
          className="no-print sticky top-0 z-10 flex items-center justify-between px-6 py-2.5"
          style={{ background: 'rgba(245,244,237,0.92)', backdropFilter: 'blur(8px)', borderBottom: '1px solid #e8e6dc' }}
        >
          {/* ← Back to Dashboard */}
          <button
            onClick={() => navigate('/dashboard')}
            className="flex items-center gap-1.5 text-xs text-[#87867f] hover:text-[#141413] transition-colors"
            style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Dashboard
          </button>

          {/* ── Centre cluster: save status + upgrade CTA ───────────────────── */}
          <div className="flex items-center gap-3">
            <span
              className={[
                'text-xs transition-all duration-300',
                saveStatus === 'saving' ? 'text-stone-400 animate-pulse' : '',
                saveStatus === 'saved'  ? 'text-emerald-600' : '',
                saveStatus === 'error'  ? 'text-red-500' : '',
                saveStatus === 'idle'   ? 'opacity-0' : '',
              ].join(' ')}
              style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
            >
              {saveStatus === 'saving' && '☁ Saving…'}
              {saveStatus === 'saved'  && '✓ Saved'}
              {saveStatus === 'error'  && '✕ Save failed'}
            </span>

            {/* ── Free-tier credit counter ─────────────────────────────────────
               Shows remaining AI actions to create urgency without surprise.
               Hidden for premium users and BYOK users (they have unlimited).  */}
            {!isPremium && !byokApiKey && (
              <span
                className={[
                  'text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full border',
                  freeRewrites <= 1
                    ? 'bg-red-50 border-red-200 text-red-600'
                    : freeRewrites <= 2
                      ? 'bg-amber-50 border-amber-200 text-amber-700'
                      : 'bg-[#e8e6dc] border-[#e3e0d6] text-[#87867f]',
                ].join(' ')}
                title={`${freeRewrites} free AI action${freeRewrites !== 1 ? 's' : ''} remaining`}
              >
                ⚡ {freeRewrites}/3
              </span>
            )}

            {/* Upgrade CTA — free users only */}
            {!isPremium && (
              <button
                onClick={() => openPaywall('workspace_upgrade')}
                className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-all duration-150 shrink-0"
                style={{
                  background: 'linear-gradient(135deg, #c96442 0%, #e07a52 100%)',
                  color: '#fff',
                  boxShadow: '0 1px 4px rgba(201,100,66,0.30)',
                }}
              >
                <span aria-hidden="true">✨</span> Upgrade
              </button>
            )}
          </div>

          <button
            onClick={handleExport}
            title={!isPremium && !byokApiKey ? 'PDF export requires Pro or BYOK — click to upgrade' : 'Export as PDF'}
            className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-1.5 rounded-full transition-all duration-150"
            style={{
              background: !isPremium && !byokApiKey ? '#e8e6dc' : '#141413',
              color: !isPremium && !byokApiKey ? '#87867f' : '#faf9f5',
              border: 'none',
              cursor: 'pointer',
              letterSpacing: '0.01em',
              fontFamily: 'system-ui, Arial, sans-serif',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = '#c96442';
              e.currentTarget.style.color = '#faf9f5';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = !isPremium && !byokApiKey ? '#e8e6dc' : '#141413';
              e.currentTarget.style.color = !isPremium && !byokApiKey ? '#87867f' : '#faf9f5';
            }}
          >
            {!isPremium && !byokApiKey ? '🔒 Export PDF' : '↓ Export PDF'}
          </button>
        </div>

        <div
          ref={documentRef}
          className="resume-document-content max-w-2xl mx-auto py-12 px-8"
        >
          {/* ── Document header: name + contact info ────────────────────────── */}
          {(candidateName || contactInfo.length > 0) && (
            <div className="text-center mb-10">
              {/* Candidate name — click to edit inline */}
              <InlineEdit
                value={candidateName !== 'Unknown' ? candidateName : ''}
                onSave={updateCandidateName}
                trigger="click"
                placeholder="Your Name"
                className="text-[#141413] text-2xl font-medium"
                style={{ fontFamily: 'Georgia, serif' }}
              />
              {/* Contact info — each item individually editable */}
              {(contactInfo?.length ?? 0) > 0 && (
                <p
                  className="text-[#87867f] text-sm mt-1"
                  style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
                >
                  {(contactInfo ?? []).map((item, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span style={{ color: '#c8c6be' }}> · </span>}
                      <InlineEdit
                        value={item}
                        onSave={(v) => updateContactInfo(i, v)}
                        trigger="click"
                      />
                    </Fragment>
                  ))}
                </p>
              )}
            </div>
          )}
          {resumeSections
            .filter(s => s.title !== 'Contact')
            .map(section => {

            return (
              <div key={section.id} className="resume-section mb-8">
                <>
                    {/* ── Section title — overline style per DESIGN.md ── */}
                    <h2
                      className="text-[0.625rem] font-semibold tracking-[0.5px] uppercase text-[#87867f] border-b border-[#e8e6dc] pb-2 mb-3"
                      style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
                    >
                      {section.title}
                    </h2>

                    {/* ── Bullets ── */}
                    <ul className="space-y-1">
                      {section.bullets.map(bullet => {
                        const isClickable = section.isInteractive && !bullet.isMeta;
                        const isActive    = bullet.id === activeBulletId;

                        /* Meta row — company / date / location — pencil-editable */
                        if (bullet.isMeta) {
                          return (
                            <li
                              key={bullet.id}
                              className="text-[#87867f] text-sm mt-3 first:mt-0 leading-snug"
                              style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
                            >
                              <InlineEdit
                                value={bullet.text}
                                onSave={(v) => updateBulletText(bullet.id, v)}
                                trigger="button"
                              />
                            </li>
                          );
                        }

                        /* Interactive bullet — clickable, AI-rewritable */
                        if (isClickable) {
                          const hasPending = pendingRewrite?.bulletId === bullet.id;
                          const isWeak     = weakBullets.some(w => w.id === bullet.id);
                          return (
                            <Fragment key={bullet.id}>
                              <li
                                id={bullet.id}
                                onClick={() => handleBulletClick(bullet.id)}
                                className={[
                                  // `resume-bullet-interactive` → @media print strips all AI colours
                                  'resume-bullet-interactive',
                                  'flex gap-2 text-sm leading-relaxed cursor-pointer rounded-lg px-2 -mx-2 py-0.5',
                                  'transition-all duration-150 select-none',
                                  isActive
                                    ? 'text-[#141413] bg-[#c96442]/8'
                                    : isWeak
                                      ? 'text-[#4d4c48] bg-amber-50/70 hover:bg-amber-50 hover:text-[#141413]'
                                      : 'text-[#4d4c48] hover:bg-[#e8e6dc]/60 hover:text-[#141413]',
                                ].join(' ')}
                                style={{
                                  fontFamily: 'system-ui, Arial, sans-serif',
                                  borderRadius: 8,
                                  boxShadow: isActive
                                    ? 'inset 0 0 0 1px #c96442'
                                    : isWeak
                                      ? 'inset 0 0 0 1px #f59e0b'
                                      : undefined,
                                }}
                              >
                                {/* resume-bullet-marker → always grey dot in print */}
                                <span
                                  className="resume-bullet-marker mt-0.5 shrink-0 text-xs transition-colors"
                                  style={{
                                    color: isActive ? '#c96442' : isWeak ? '#f59e0b' : '#b0aea5',
                                  }}
                                >
                                  {isWeak && !isActive ? '⚠' : '•'}
                                </span>
                                {/* resume-bullet-text — pencil trigger avoids conflict with <li> onClick */}
                                <span className="resume-bullet-text flex-1 min-w-0">
                                  <InlineEdit
                                    value={bullet.text}
                                    onSave={(v) => updateBulletText(bullet.id, v)}
                                    trigger="button"
                                  />
                                </span>
                              </li>
                              {hasPending && (
                                <SandwichDiffInline
                                  oldText={bullet.text}
                                  newText={pendingRewrite!.proposedText}
                                  onAccept={acceptRewrite}
                                  onReject={rejectRewrite}
                                />
                              )}
                            </Fragment>
                          );
                        }

                        /* Static bullet — Education, Certifications, etc. — pencil-editable */
                        return (
                          <li
                            key={bullet.id}
                            className="flex gap-2 text-[#5e5d59] text-sm leading-relaxed"
                            style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
                          >
                            <span className="mt-0.5 shrink-0 text-xs text-[#b0aea5]">•</span>
                            <span className="flex-1 min-w-0">
                              <InlineEdit
                                value={bullet.text}
                                onSave={(v) => updateBulletText(bullet.id, v)}
                                trigger="button"
                              />
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                </>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Chat panel (screen only — hidden when printing) ─────────────────── */}
      <div className="no-print w-[22rem] flex flex-col bg-[#faf9f5]" style={{ borderLeft: '1px solid #e8e6dc' }}>

        {/* Header */}
        <div className="px-5 py-4 shrink-0" style={{ borderBottom: '1px solid #e8e6dc' }}>
          <div className="flex items-center justify-between gap-2">
            <p
              className="text-base font-medium text-[#141413]"
              style={{ fontFamily: 'Georgia, serif' }}
            >
              Mac · AI Coach
            </p>
            {/* BYOK indicator — shown when a personal Gemini key is active */}
            {byokApiKey && (
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 shrink-0"
                title="Your own Gemini API key is active — unlimited usage"
              >
                🔑 BYOK
              </span>
            )}
          </div>
          {activeBulletId ? (
            <p
              className="text-xs mt-0.5 truncate"
              style={{ fontFamily: 'system-ui, Arial, sans-serif', color: '#c96442' }}
            >
              {(() => {
                // Prefer the evaluator's semantic label (e.g. "Acme Corp Role")
                const weak = weakBullets.find(w => w.id === activeBulletId);
                if (weak?.label) return `Editing: ${weak.label}`;
                // Fallback: first 28 chars of raw bullet text
                const text = resumeSections
                  .flatMap(s => s.bullets)
                  .find(b => b.id === activeBulletId)?.text ?? '';
                const snippet = text.length > 28 ? text.slice(0, 28).trimEnd() + '…' : text;
                return `Editing: "${snippet}"`;
              })()}
            </p>
          ) : (
            <p
              className="text-xs text-[#87867f] mt-0.5"
              style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
            >
              General Career Coaching — click a bullet to edit it
            </p>
          )}
        </div>

        {/* ── Credit counter bar ─────────────────────────────────────────────────
             Visible only for free non-BYOK users. Shows remaining AI actions
             with colour-coded urgency: neutral → amber (≤2) → red (≤1).
             Tapping "Upgrade" from here tags the paywall source 'credit_bar'.   */}
        {!isPremium && !byokApiKey && (
          <div
            className="px-4 py-2 flex items-center justify-between gap-2 shrink-0"
            style={{
              background: freeRewrites <= 1
                ? 'rgba(239,68,68,0.04)'
                : freeRewrites <= 2
                  ? 'rgba(245,158,11,0.05)'
                  : 'rgba(232,230,220,0.40)',
              borderBottom: '1px solid #e8e6dc',
            }}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-sm" aria-hidden="true">⚡</span>
              <span
                className={[
                  'text-[11px] font-semibold truncate',
                  freeRewrites <= 1  ? 'text-red-600'    :
                  freeRewrites <= 2  ? 'text-amber-700'  :
                                       'text-[#87867f]',
                ].join(' ')}
                style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
              >
                {freeRewrites > 0
                  ? `${freeRewrites} free AI action${freeRewrites !== 1 ? 's' : ''} left`
                  : 'No free actions left'}
              </span>
            </div>
            <button
              onClick={() => openPaywall('credit_bar')}
              className={[
                'text-[10px] font-bold px-2.5 py-1 rounded-lg whitespace-nowrap shrink-0',
                'transition-all duration-150',
                freeRewrites <= 1
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'bg-[#c96442]/10 text-[#c96442] hover:bg-[#c96442] hover:text-white',
              ].join(' ')}
              style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
            >
              Upgrade ✨
            </button>
          </div>
        )}

        {/* Message list */}
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
          {chatMessages.length === 0 ? (
            <p
              className="text-xs text-[#b0aea5] text-center mt-8"
              style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
            >
              No messages yet.
            </p>
          ) : (
            chatMessages.map(msg => (
              <div
                key={msg.id}
                className={
                  msg.role === 'mascot'
                    ? 'flex w-full gap-2 items-end justify-start mb-4'
                    : 'flex w-full gap-2 items-end justify-end mb-4 flex-row-reverse'
                }
              >
                {/* Mac avatar — mascot only */}
                {msg.role === 'mascot' && (
                  <div className="shrink-0 w-8 h-8 rounded-full bg-orange-500 text-white flex items-center justify-center font-bold text-sm">
                    M
                  </div>
                )}

                <div className="flex flex-col gap-2 max-w-[85%]">
                  {/* Message bubble */}
                  <div
                    className={[
                      'text-sm px-3 py-2.5 leading-relaxed',
                      msg.role === 'mascot'
                        ? 'bg-[#f5f4ed] text-[#4d4c48] border border-[#e8e6dc]'
                        : 'bg-stone-200 text-stone-800',
                    ].join(' ')}
                    style={{
                      fontFamily: 'system-ui, Arial, sans-serif',
                      borderRadius: msg.role === 'mascot' ? '4px 12px 12px 12px' : '12px 4px 12px 12px',
                    }}
                  >
                    {msg.role === 'mascot'
                      ? renderMessageContent(msg.content)
                      : msg.content}
                  </div>

                  {/* Jump-to-bullet action buttons */}
                  {msg.actions && msg.actions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-1">
                      {msg.actions.map(action => (
                        <button
                          key={action.bulletId}
                          onClick={() => {
                            setActiveBullet(action.bulletId);
                            setTimeout(() => scrollToElement(action.bulletId), 100);
                          }}
                          className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all duration-150"
                          style={{
                            background: '#fff8f5',
                            color: '#c96442',
                            border: '1px solid #f5c9b8',
                            cursor: 'pointer',
                            fontFamily: 'system-ui, Arial, sans-serif',
                          }}
                          onMouseEnter={e => {
                            e.currentTarget.style.background = '#c96442';
                            e.currentTarget.style.color = '#fff';
                            e.currentTarget.style.borderColor = '#c96442';
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background = '#fff8f5';
                            e.currentTarget.style.color = '#c96442';
                            e.currentTarget.style.borderColor = '#f5c9b8';
                          }}
                        >
                          ↓ {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Live Context Banner ───────────────────────────────────────────
             Derives the evaluator's suggestion for the active bullet and
             displays it inline above the input — no chat history entry.
             Disappears automatically when the bullet is deselected.        */}
        {(() => {
          const activeSuggestion = activeBulletId
            ? weakBullets.find(w => w.id === activeBulletId)?.suggestion ?? null
            : null;

          return activeSuggestion ? (
            <div
              className="mx-4 mb-0 mt-0 text-sm leading-snug"
              style={{
                background: '#fffbeb',
                borderLeft: '3px solid #f59e0b',
                borderRadius: '0 6px 6px 0',
                padding: '8px 10px 8px 10px',
                color: '#78350f',
                fontFamily: 'system-ui, Arial, sans-serif',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 7,
              }}
            >
              <span style={{ fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>💡</span>
              <div>
                <p style={{ fontWeight: 600, marginBottom: 2, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#b45309' }}>
                  Mac's Suggestion
                </p>
                <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.45 }}>{activeSuggestion}</p>
              </div>
            </div>
          ) : null;
        })()}

        {/* Input — border-top acts as the visual separator above the banner too */}
        <div className="px-4 pt-3 pb-4 shrink-0" style={{ borderTop: '1px solid #e8e6dc' }}>
          {/* ── Hard-block overlay when credits = 0 (free + no BYOK) ──────────
               The input stays visible so users can see what they'd type, but
               the form is fully disabled and clicking anywhere opens the paywall. */}
          {!isPremium && !byokApiKey && freeRewrites <= 0 ? (
            <button
              type="button"
              onClick={() => openPaywall('input_locked')}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-[#c96442]/40 bg-[#c96442]/[0.04] transition-all hover:bg-[#c96442]/[0.07]"
              style={{ fontFamily: 'system-ui, Arial, sans-serif' }}
            >
              <span className="text-[#c96442] text-base">🔒</span>
              <span className="text-xs font-semibold text-[#c96442]">Upgrade to unlock AI actions</span>
            </button>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleChatSubmit(); }}
                placeholder={
                  activeBulletId
                    ? 'Tell Mac how to improve this bullet…'
                    : 'Ask Mac anything about your resume…'
                }
                className="flex-1 px-3 py-2 text-sm outline-none transition-colors"
                style={{
                  fontFamily: 'system-ui, Arial, sans-serif',
                  borderRadius: 12,
                  border: '1px solid #e8e6dc',
                  background: '#ffffff',
                  color: '#141413',
                  cursor: 'text',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = '#3898ec'; }}
                onBlur={e => { e.currentTarget.style.borderColor = '#e8e6dc'; }}
              />
              <button
                onClick={handleChatSubmit}
                disabled={!chatInput.trim()}
                className="px-3 py-2 text-sm font-semibold transition-colors"
                style={{
                  borderRadius: 12,
                  background: chatInput.trim() ? '#c96442' : '#e8e6dc',
                  color: chatInput.trim() ? '#faf9f5' : '#b0aea5',
                  cursor: chatInput.trim() ? 'pointer' : 'not-allowed',
                  boxShadow: chatInput.trim()
                    ? '#c96442 0px 0px 0px 0px, #c96442 0px 0px 0px 1px'
                    : 'none',
                }}
              >
                ↑
              </button>
            </div>
          )}
        </div>

      </div>

    </div>

    {/*
     * PrintTemplate — sibling to .workspace-layout, NOT a child.
     * When @media print hides .workspace-layout, this element is unaffected
     * and takes the full page. Hidden on screen via @media screen in index.css.
     */}
    <PrintTemplate />

    </>
  );
}
