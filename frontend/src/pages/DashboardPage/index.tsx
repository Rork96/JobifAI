/**
 * DashboardPage — Route: /dashboard  (protected)
 * ─────────────────────────────────────────────────────────────────────────────
 * Hub UI. Two states:
 *   empty   — no resumes yet → "Welcome to the 1%" + CTA
 *   loaded  — resume grid → cards showing title, ATS score, last updated
 *
 * Phase 11.4: Fetches user's resumes from Supabase on mount.
 * Clicking a card routes to /workspace/:id (load from DB).
 * "+ Create New Resume" clears store and routes to / (landing intake).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { useDocumentStore } from '@/store/useDocumentStore';
import { useBillingStore } from '@/store/useBillingStore';
import { getUserResumes, deleteResume, deleteAllUserData } from '@/lib/db';
import type { ResumeRecord } from '@/lib/db';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return 'Unknown date';
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return 'Invalid date';
    const now = new Date();
    const isToday =
      d.getDate()     === now.getDate()     &&
      d.getMonth()    === now.getMonth()    &&
      d.getFullYear() === now.getFullYear();

    if (isToday) {
      const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      return `Today at ${time}`;
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return 'Invalid date';
  }
}

function scoreColor(score: number): string {
  if (score >= 76) return '#16a34a'; // green
  if (score >= 40) return '#d97706'; // amber
  return '#dc2626';                  // red
}

// ── Resume card ───────────────────────────────────────────────────────────────

function ResumeCard({
  resume,
  onClick,
  onDelete,
}: {
  resume: Omit<ResumeRecord, 'content'>;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className="w-full text-left p-5 rounded-2xl bg-white border border-[#e3e0d6] hover:border-[#c96442]/40 hover:shadow-md transition-all duration-150 group"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3
            className="text-sm font-semibold text-[#141413] leading-snug group-hover:text-[#c96442] transition-colors line-clamp-2"
            style={{ fontFamily: 'Georgia, serif' }}
          >
            {resume.title}
          </h3>
          {/* ATS score badge */}
          <span
            className="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full"
            style={{
              color: scoreColor(resume.ats_score),
              background: `${scoreColor(resume.ats_score)}18`,
            }}
          >
            {resume.ats_score}%
          </span>
        </div>
        <p className="text-xs text-[#b0aea5]" style={{ fontFamily: 'system-ui, Arial, sans-serif' }}>
          Updated {formatDate(resume.updated_at)}
        </p>
      </button>
      {/* Delete button — appears on hover */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete resume"
        className="absolute top-3 right-3 p-1.5 rounded-lg text-[#b0aea5] hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all duration-150"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const navigate      = useNavigate();
  const user          = useAuthStore(s => s.user);
  const session       = useAuthStore(s => s.session);
  const isPremium     = useAuthStore(s => s.isPremium);
  const clearDocument = useDocumentStore(s => s.clearDocument);
  const openPaywall   = useBillingStore(s => s.openPaywall);

  const [resumes,    setResumes]    = useState<Omit<ResumeRecord, 'content'>[]>([]);
  const [isLoading,  setIsLoading]  = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Prevents concurrent fetches — reset when user id changes
  const isFetching = useRef(false);

  const initials = user?.email ? user.email.slice(0, 2).toUpperCase() : '??';

  // Fetch resumes keyed on user id. Stable string dep prevents re-runs on
  // token refresh (which rebuilds the user object but keeps the same id).
  useEffect(() => {
    let isMounted = true;
    isFetching.current = false; // reset for new user id

    if (!user?.id || !session) {
      console.log('🏠 [Dashboard] No user/session — skipping fetch, clearing loading.');
      setIsLoading(false);
      return;
    }

    if (isFetching.current) return;
    isFetching.current = true;

    const fetchResumes = async () => {
      console.log('🏠 [Dashboard] fetchResumes START — userId:', user.id);
      setIsLoading(true);
      setFetchError(null);

      // 5-second outer watchdog — safety net in case the DB-layer 4 s timeout
      // itself is somehow bypassed (e.g. Promise.race edge case, runtime quirk).
      // Always resolves to empty-state, never to a limbo or error banner.
      const watchdog = setTimeout(() => {
        if (isMounted) {
          console.error('❌ [Dashboard] 5 s outer watchdog fired — forcing empty state');
          setResumes([]);
          setFetchError(null);
          setIsLoading(false);
          isFetching.current = false;
        }
      }, 5_000);

      try {
        // getUserResumes now always resolves (never throws) within 4 s max.
        let data = await getUserResumes(user.id);
        console.log('🏠 [Dashboard] getUserResumes (1st) — rows:', data.length);

        if (!isMounted) {
          console.log('🏠 [Dashboard] unmounted after 1st fetch — aborting');
          return;
        }

        // Retry once after 800 ms: first load after OAuth redirect can race the
        // JWT propagation, returning 0 rows even though the user has resumes.
        if (data.length === 0) {
          console.log('🏠 [Dashboard] Empty result — retrying after 800 ms');
          await new Promise(r => setTimeout(r, 800));
          if (!isMounted) {
            console.log('🏠 [Dashboard] unmounted during retry wait — aborting');
            return;
          }
          data = await getUserResumes(user.id);
          console.log('🏠 [Dashboard] getUserResumes (2nd) — rows:', data.length);
          if (!isMounted) {
            console.log('🏠 [Dashboard] unmounted after 2nd fetch — aborting');
            return;
          }
        }

        console.log('✅ [Dashboard] Loaded', data.length, 'resume(s)');
        setResumes(data);
        setFetchError(null);
      } catch (err) {
        // getUserResumes never throws, but defensive catch for any future regression
        console.error('❌ [Dashboard] Unexpected error in fetchResumes:', err);
        setResumes([]);
        setFetchError(null);
      } finally {
        clearTimeout(watchdog);
        if (isMounted) {
          setIsLoading(false);
          isFetching.current = false;
        }
      }
    };

    fetchResumes();

    return () => { isMounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleSignOut = () => {
    clearDocument();
    // Fire-and-forget: signOut() calls supabase.auth.signOut() then hard-redirects.
    // We do NOT await — a hanging Supabase call must not freeze the button.
    // The fallback setTimeout guarantees navigation even if signOut() hangs.
    useAuthStore.getState().signOut();
    setTimeout(() => { window.location.href = '/login'; }, 3_000);
  };

  function handleNewResume() {
    clearDocument();
    navigate('/');
  }

  function handleOpenResume(id: string) {
    navigate(`/workspace/${id}`);
  }

  async function handleDeleteResume(id: string, title: string) {
    if (!window.confirm(`Delete "${title}"?\n\nThis cannot be undone.`)) return;
    setDeleteError(null);
    const { error } = await deleteResume(id);
    if (error) {
      setDeleteError(`Failed to delete resume: ${error}`);
      return;
    }
    setResumes(prev => prev.filter(r => r.id !== id));
  }

  async function handleDeleteAllData() {
    if (!user?.id) return;
    if (!window.confirm('Delete ALL your resumes?\n\nThis will permanently erase every resume in your account.')) return;
    if (!window.confirm('Are you absolutely sure? This cannot be undone.')) return;
    setDeleteError(null);
    const { error } = await deleteAllUserData(user.id);
    if (error) {
      setDeleteError(`Failed to delete data: ${error}`);
      return;
    }
    setResumes([]);
  }

  const sortedResumes = Array.isArray(resumes)
    ? [...resumes].sort((a, b) => {
        const dateA = new Date(a?.updated_at || 0).getTime();
        const dateB = new Date(b?.updated_at || 0).getTime();
        return dateB - dateA;
      })
    : [];

  return (
    <div className="min-h-screen bg-[#f5f3ec] flex flex-col">

      {/* ── TopBar ─────────────────────────────────────────────────────────── */}
      <header className="w-full flex items-center justify-between px-6 py-4 border-b border-[#e3e0d6] bg-[#f5f3ec]/90 sticky top-0 z-10">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#c96442] flex items-center justify-center flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <span className="text-sm font-semibold text-[#141413] tracking-tight">JobifAI</span>
        </div>

        {/* User controls */}
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 rounded-full bg-[#c96442]/15 flex items-center justify-center">
              <span className="text-xs font-semibold text-[#c96442]">{initials}</span>
            </div>
            {isPremium && (
              <span
                className="absolute -top-1.5 -right-1.5 text-[9px] font-bold px-1 py-px rounded-full leading-none"
                style={{ background: '#c96442', color: '#fff', letterSpacing: '0.04em' }}
                title="Premium plan active"
              >
                PRO
              </span>
            )}
          </div>
          <span className="text-sm text-[#6b6963] hidden sm:block truncate max-w-[180px]">
            {user?.email}
          </span>

          {/* Upgrade CTA — only shown to free-tier users */}
          {!isPremium && (
            <button
              onClick={() => openPaywall('header_upgrade')}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all duration-150 shrink-0"
              style={{
                background: 'linear-gradient(135deg, #c96442 0%, #e07a52 100%)',
                color: '#fff',
                boxShadow: '0 1px 4px rgba(201,100,66,0.35)',
              }}
            >
              <span aria-hidden="true">✨</span>
              <span className="hidden xs:inline">Upgrade to Pro</span>
              <span className="xs:hidden">Pro</span>
            </button>
          )}

          <button
            onClick={handleSignOut}
            className="text-xs text-[#b0aea5] hover:text-[#6b6963] transition-colors px-2 py-1 rounded-md hover:bg-[#e8e6dc]"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-6 py-10">

        {/* Section header + CTA */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1
              className="text-2xl font-semibold text-[#141413] tracking-tight"
              style={{ fontFamily: 'Georgia, serif' }}
            >
              {sortedResumes.length > 0 ? 'Your Resumes' : 'Welcome to the 1%.'}
            </h1>
            {sortedResumes.length === 0 && !isLoading && (
              <p className="text-sm text-[#6b6963] mt-1">
                I'm Mac, your AI Co-pilot. Let's build a resume that actually gets interviews.
              </p>
            )}
          </div>

          {!isLoading && sortedResumes.length > 0 && (
            <button
              onClick={handleNewResume}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#c96442] hover:bg-[#b85a3a] active:bg-[#a35234] transition-colors text-white font-semibold text-sm shadow-sm shadow-[#c96442]/20"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              New Resume
            </button>
          )}
        </div>

        {/* Content */}
        {isLoading ? (
          /* Contained spinner — flex-col relative to <main>, never overlaps header */
          <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-[#c96442]" />
            <p className="text-sm text-[#87867f]">Loading your resumes…</p>
          </div>
        ) : fetchError ? (
          <div className="rounded-2xl border border-red-300 bg-red-50 p-6 text-center">
            <p className="text-sm font-semibold text-red-600 mb-1">Failed to load resumes</p>
            <p className="text-xs text-red-500 font-mono break-all">{fetchError}</p>
            <p className="text-xs text-red-400 mt-2">Check the browser console for details.</p>
          </div>
        ) : sortedResumes.length === 0 ? (
          // Empty state CTA
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 mb-6 rounded-2xl bg-[#c96442]/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-[#c96442]">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <button
              onClick={handleNewResume}
              className="flex items-center gap-2.5 px-8 py-4 rounded-2xl bg-[#c96442] hover:bg-[#b85a3a] transition-colors text-white font-semibold text-base shadow-lg shadow-[#c96442]/25"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Create New Resume
            </button>
            <p className="mt-5 text-xs text-[#b0aea5]">
              Upload your resume + paste a job description → get your ATS score in seconds
            </p>
          </div>
        ) : (
          // Resume grid — always newest first (sorted above)
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {sortedResumes.map(r => (
              <ResumeCard
                key={r.id}
                resume={r}
                onClick={() => handleOpenResume(r.id)}
                onDelete={() => handleDeleteResume(r.id, r.title)}
              />
            ))
            }
          </div>
        )}

        {/* Delete error banner */}
        {deleteError && (
          <div className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-600 font-mono">
            {deleteError}
          </div>
        )}

        {/* Danger zone — only shown when resumes exist */}
        {!isLoading && sortedResumes.length > 0 && (
          <div className="mt-16 pt-8 border-t border-[#e3e0d6]">
            <p className="text-xs font-semibold text-[#b0aea5] uppercase tracking-wider mb-3">Danger Zone</p>
            <button
              onClick={handleDeleteAllData}
              className="text-xs text-red-400 hover:text-red-600 hover:bg-red-50 px-3 py-1.5 rounded-lg border border-red-200 hover:border-red-300 transition-colors"
            >
              Delete all my data
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
