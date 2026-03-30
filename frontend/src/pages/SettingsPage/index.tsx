/**
 * SettingsPage — Route: /settings  (protected)
 * PRD §6 — Settings, Privacy & Localization
 *
 * Sections (vertical stack, single-column on mobile):
 *   §6.1  Profile         — user email, display name (read-only stub)
 *   §6.2  BYOK API Key    — masked key display, Update/Remove (useChatStore)
 *   §6.3  Language        — UI language + AI response language (useSessionStore)
 *   §6.4  Subscription    — plan status, quota counters, Manage Billing stub
 *   §6.5  Notifications   — email toggles (local state)
 *   §6.6  Danger Zone     — PIPEDA delete with two-step confirmation modal
 *
 * Phase 6 wiring points (marked TODO):
 *   - BYOK: persist encrypted key to localStorage (PRD §1.4)
 *   - Language: wire to i18next locale switch
 *   - Subscription: link to Stripe Customer Portal
 *   - Clear data: fire DELETE /api/user/data
 *   - Delete account: fire DELETE /api/user/account → clearAuth() → navigate('/')
 */

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import DevNav from '@/shared/ui/DevNav';
import { useAuthStore } from '@/store/useAuthStore';
import { useSessionStore } from '@/store/useSessionStore';
import { useChatStore } from '@/store/useChatStore';

// ── Constants ─────────────────────────────────────────────────────────────────

const UI_LANGUAGES = [
  { value: 'en', label: '🇬🇧 English' },
  { value: 'fr', label: '🇫🇷 French' },
  { value: 'de', label: '🇩🇪 German' },
  { value: 'es', label: '🇪🇸 Spanish' },
  { value: 'pt', label: '🇧🇷 Portuguese' },
  { value: 'nl', label: '🇳🇱 Dutch' },
  { value: 'pl', label: '🇵🇱 Polish' },
];

const AI_LANGUAGES = [
  { value: 'en',    label: 'English' },
  { value: 'fr',    label: 'French' },
  { value: 'de',    label: 'German' },
  { value: 'es',    label: 'Spanish' },
  { value: 'pt',    label: 'Portuguese' },
  { value: 'nl',    label: 'Dutch' },
  { value: 'pl',    label: 'Polish' },
  { value: 'match', label: 'Match UI Language' },
];

// ── Helper: mask BYOK key ─────────────────────────────────────────────────────

function maskApiKey(key: string): string {
  if (key.length <= 8) return '●'.repeat(key.length);
  return key.slice(0, 4) + '●'.repeat(Math.min(key.length - 8, 18)) + key.slice(-4);
}

// ── Shared section card wrapper ───────────────────────────────────────────────

function Section({
  title,
  description,
  children,
  danger = false,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className={`rounded-2xl border p-5 sm:p-6 ${
      danger
        ? 'bg-red-50 border-red-200'
        : 'bg-white border-slate-200'
    }`}>
      <div className="mb-4">
        <h2 className={`font-bold text-base ${danger ? 'text-red-700' : 'text-slate-900'}`}>
          {title}
        </h2>
        {description && (
          <p className="text-sm text-slate-500 mt-0.5 leading-snug">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Shared select field ───────────────────────────────────────────────────────

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
      <label className="text-sm font-medium text-slate-700 sm:w-44 flex-shrink-0">
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2
                   text-sm text-slate-700 focus:outline-none focus:ring-2
                   focus:ring-brand-400 focus:border-transparent"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ── Toggle row ────────────────────────────────────────────────────────────────

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-700">{label}</p>
        {description && (
          <p className="text-xs text-slate-400 mt-0.5">{description}</p>
        )}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200
          focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2
          ${checked ? 'bg-brand-600' : 'bg-slate-200'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm
          transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

// ── §6.1 Profile ─────────────────────────────────────────────────────────────

function ProfileSection() {
  const user = useAuthStore(s => s.user);
  const isPremium = useAuthStore(s => s.isPremium);

  return (
    <Section title="Profile" description="Your account identity.">
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <span className="text-sm font-medium text-slate-700 sm:w-44 flex-shrink-0">
            Email
          </span>
          <span className="flex-1 rounded-xl border border-slate-100 bg-slate-50
                           px-3 py-2 text-sm text-slate-500 font-mono">
            {user?.email ?? 'Not signed in'}
          </span>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <span className="text-sm font-medium text-slate-700 sm:w-44 flex-shrink-0">
            Plan
          </span>
          <span className={`inline-flex items-center gap-1.5 text-xs font-bold
            px-2.5 py-1 rounded-full w-fit
            ${isPremium
              ? 'bg-brand-100 text-brand-700'
              : 'bg-slate-100 text-slate-600'}`}>
            {isPremium ? '⭐ Premium' : '🆓 Free Tier'}
          </span>
        </div>
      </div>
    </Section>
  );
}

// ── §6.2 BYOK API Key ────────────────────────────────────────────────────────

function ByokSection() {
  const byokApiKey  = useChatStore(s => s.byokApiKey);
  const setByokKey  = useChatStore(s => s.setByokApiKey);

  const [mode,     setMode]     = useState<'view' | 'edit'>('view');
  const [input,    setInput]    = useState('');
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'edit') inputRef.current?.focus();
  }, [mode]);

  const handleSave = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setByokKey(trimmed);
    setInput('');
    setMode('view');
    setRevealed(false);
  };

  const handleRemove = () => {
    setByokKey(null);
    setInput('');
    setMode('view');
    setRevealed(false);
  };

  return (
    <Section
      title="BYOK — Bring Your Own Gemini Key"
      description="Your key is stored in-session only — never sent to our servers or saved to the database. Bypasses all quota limits."
    >
      {/* Quota bypass callout */}
      <div className="mb-4 flex items-start gap-2 rounded-xl bg-brand-50 border border-brand-100 px-3 py-2.5">
        <span className="text-brand-600 mt-0.5 flex-shrink-0">🔑</span>
        <p className="text-xs text-brand-700 leading-relaxed">
          When set, your key is forwarded as a request header and unlocks{' '}
          <strong>unlimited AI requests</strong> at zero cost to us.{' '}
          The key is never persisted to Supabase.
        </p>
      </div>

      <AnimatePresence mode="wait">
        {byokApiKey && mode === 'view' ? (
          <motion.div
            key="view"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="space-y-3"
          >
            {/* Masked key display */}
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-xl border border-green-200 bg-green-50
                              px-3 py-2 text-sm font-mono text-green-800 flex items-center gap-2">
                <span className="flex-shrink-0 text-green-500">✓</span>
                <span className="flex-1 truncate">
                  {revealed ? byokApiKey : maskApiKey(byokApiKey)}
                </span>
              </div>
              <button
                onClick={() => setRevealed(r => !r)}
                className="text-xs font-medium text-slate-400 hover:text-slate-700
                           transition-colors px-2 py-1 rounded-lg hover:bg-slate-100"
                aria-label={revealed ? 'Hide key' : 'Reveal key'}
              >
                {revealed ? '🙈' : '👁'}
              </button>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={() => setMode('edit')}
                className="px-3.5 py-1.5 rounded-lg bg-white border border-slate-200
                           text-slate-700 text-xs font-bold hover:bg-slate-50
                           transition-colors active:scale-[0.97]"
              >
                Update Key
              </button>
              <button
                onClick={handleRemove}
                className="px-3.5 py-1.5 rounded-lg bg-red-50 border border-red-200
                           text-red-600 text-xs font-bold hover:bg-red-100
                           transition-colors active:scale-[0.97]"
              >
                Remove
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="edit"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="space-y-2"
          >
            <input
              ref={inputRef}
              type="password"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="Paste your Gemini API key (AIza…)"
              className="w-full rounded-xl border border-slate-200 bg-white
                         px-3 py-2 text-sm font-mono text-slate-700
                         placeholder:text-slate-400 focus:outline-none
                         focus:ring-2 focus:ring-brand-400"
            />
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={!input.trim()}
                className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700
                           disabled:bg-slate-200 disabled:text-slate-400
                           text-white text-xs font-bold transition-colors active:scale-[0.97]"
              >
                Save Key
              </button>
              {byokApiKey && (
                <button
                  onClick={() => { setMode('view'); setInput(''); }}
                  className="px-3.5 py-1.5 rounded-lg bg-white border border-slate-200
                             text-slate-600 text-xs font-bold hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

// ── §6.3 Language & Region ───────────────────────────────────────────────────

function LanguageSection() {
  const userLang   = useSessionStore(s => s.userLang);
  const resumeLang = useSessionStore(s => s.resumeLang);
  const setUserLang   = useSessionStore(s => s.setUserLang);
  const setResumeLang = useSessionStore(s => s.setResumeLang);

  return (
    <Section
      title="Language & Region"
      description="Controls the UI display language and the language used in all AI-generated resume text."
    >
      <div className="space-y-4">
        <SelectField
          label="UI Language"
          value={userLang}
          onChange={v => {
            // TODO Phase 6: i18next.changeLanguage(v)
            setUserLang(v);
          }}
          options={UI_LANGUAGES}
        />
        <div className="border-t border-slate-100" />
        <SelectField
          label="AI Responses"
          value={resumeLang}
          onChange={v => {
            // TODO Phase 6: pass as Accept-Language header to POST /api/rewrite-section
            setResumeLang(v);
          }}
          options={AI_LANGUAGES}
        />
        <p className="text-xs text-slate-400 leading-relaxed">
          AI Responses controls the language of all rewritten resume bullets and
          cover letter text. Set to <strong>Match UI Language</strong> to keep them in sync.
        </p>
      </div>
    </Section>
  );
}

// ── §6.4 Subscription ────────────────────────────────────────────────────────

function SubscriptionSection() {
  const isPremium      = useAuthStore(s => s.isPremium);
  const freeRewrites   = useAuthStore(s => s.freeRewrites);
  const freeInterviews = useAuthStore(s => s.freeInterviews);

  return (
    <Section title="Subscription" description="Your current plan and usage.">
      <div className="space-y-4">
        {/* Plan badge */}
        <div className="flex items-center justify-between gap-4 rounded-xl
                        bg-slate-50 border border-slate-100 px-4 py-3">
          <div>
            <p className="font-bold text-sm text-slate-900">
              {isPremium ? 'Premium Plan' : 'Free Tier'}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              {isPremium
                ? 'Unlimited AI rewrites and interview sessions.'
                : `${freeRewrites} rewrite${freeRewrites !== 1 ? 's' : ''} · ${freeInterviews} interview session remaining`}
            </p>
          </div>
          <span className={`text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0
            ${isPremium ? 'bg-brand-100 text-brand-700' : 'bg-slate-200 text-slate-600'}`}>
            {isPremium ? 'PREMIUM' : 'FREE'}
          </span>
        </div>

        {/* Upgrade / Manage billing */}
        <div className="flex flex-wrap gap-2">
          {!isPremium && (
            <button
              onClick={() => {
                // TODO Phase 6: useBillingStore.openPaywall('settings-upgrade')
                console.log('openPaywall: settings-upgrade');
              }}
              className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700
                         text-white text-sm font-bold transition-colors
                         active:scale-[0.97] shadow-brand"
            >
              Upgrade to Premium
            </button>
          )}
          <button
            onClick={() => {
              // TODO Phase 6: redirect to Stripe Customer Portal URL
              console.log('Stripe Customer Portal');
            }}
            className="px-4 py-2 rounded-xl bg-white border border-slate-200
                       text-slate-700 text-sm font-bold hover:bg-slate-50
                       transition-colors active:scale-[0.97]"
          >
            Manage Billing ↗
          </button>
        </div>
      </div>
    </Section>
  );
}

// ── §6.5 Notifications ───────────────────────────────────────────────────────

function NotificationsSection() {
  const [emailUpdates,    setEmailUpdates]    = useState(true);
  const [productNews,     setProductNews]     = useState(false);
  const [weeklyDigest,    setWeeklyDigest]    = useState(true);

  return (
    <Section title="Notifications" description="Control which emails we send you.">
      <div className="divide-y divide-slate-100">
        <ToggleRow
          label="Product updates"
          description="New features, major releases, and improvements."
          checked={emailUpdates}
          onChange={setEmailUpdates}
        />
        <ToggleRow
          label="Career tips digest"
          description="Weekly ATS optimisation tips and interview guides."
          checked={weeklyDigest}
          onChange={setWeeklyDigest}
        />
        <ToggleRow
          label="Promotional emails"
          description="Discounts, limited-time offers, and partner content."
          checked={productNews}
          onChange={setProductNews}
        />
      </div>
    </Section>
  );
}

// ── §6.6 Danger Zone + Modal (PIPEDA §6.4) ───────────────────────────────────

function DangerZoneModal({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [confirmInput, setConfirmInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmed = confirmInput === 'DELETE';

  // Focus input when modal opens, reset on close
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      setConfirmInput('');
    }
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          />

          {/* Modal */}
          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1,    y: 0  }}
            exit={{ opacity: 0, scale: 0.94, y: 8 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none"
          >
            <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl pointer-events-auto overflow-hidden">
              {/* Red header */}
              <div className="bg-red-600 px-6 py-5">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">⚠️</span>
                  <div>
                    <h3 className="font-black text-white text-base">
                      Delete Account & All Data
                    </h3>
                    <p className="text-red-200 text-xs mt-0.5">
                      This action is permanent and cannot be undone.
                    </p>
                  </div>
                </div>
              </div>

              {/* Body */}
              <div className="px-6 py-5 space-y-4">
                <p className="text-sm text-slate-600 leading-relaxed">
                  This will <strong>permanently delete</strong>:
                </p>
                <ul className="text-sm text-slate-600 space-y-1.5 pl-4">
                  {[
                    'Your account and login credentials',
                    'All uploaded CVs and job descriptions',
                    'Your full AI conversation history',
                    'Subscription and billing records',
                    'All ATS scores and analysis results',
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2">
                      <span className="text-red-500 mt-0.5 flex-shrink-0">✕</span>
                      {item}
                    </li>
                  ))}
                </ul>

                {/* PIPEDA compliance callout */}
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5">
                  <p className="text-xs text-amber-800 leading-relaxed">
                    <strong>PIPEDA compliance:</strong> Your personal data will be purged
                    from all systems within 30 days per Canadian privacy law.
                    Export your data before proceeding.
                  </p>
                </div>

                {/* Type-to-confirm input */}
                <div className="space-y-2">
                  <label className="text-sm font-semibold text-slate-700">
                    Type <span className="font-mono text-red-600 bg-red-50 px-1.5 py-0.5 rounded">DELETE</span> to confirm:
                  </label>
                  <input
                    ref={inputRef}
                    type="text"
                    value={confirmInput}
                    onChange={e => setConfirmInput(e.target.value)}
                    placeholder="DELETE"
                    autoComplete="off"
                    spellCheck={false}
                    className={`w-full rounded-xl border px-3 py-2 text-sm font-mono
                      focus:outline-none focus:ring-2 transition-colors
                      ${confirmed
                        ? 'border-red-400 bg-red-50 text-red-700 focus:ring-red-400'
                        : 'border-slate-200 bg-white text-slate-700 focus:ring-slate-300'}`}
                  />
                </div>

                {/* Actions */}
                <div className="flex gap-3 pt-1">
                  <button
                    onClick={onClose}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200
                               text-slate-700 text-sm font-bold transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={!confirmed}
                    onClick={onConfirm}
                    className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-bold
                      transition-all duration-150
                      ${confirmed
                        ? 'bg-red-600 hover:bg-red-700 text-white active:scale-[0.98]'
                        : 'bg-slate-100 text-slate-300 cursor-not-allowed'}`}
                  >
                    🗑 Confirm Delete
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function DangerZoneSection() {
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();

  const handleConfirmDelete = () => {
    // TODO Phase 6: DELETE /api/user/account → then clearAuth + navigate
    useAuthStore.getState().clearAuth();
    setModalOpen(false);
    navigate('/');
  };

  return (
    <>
      <Section
        title="⚠️ Danger Zone"
        description="These actions are irreversible. Please read carefully before proceeding."
        danger
      >
        <div className="space-y-4">
          {/* Clear data (softer option) */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3
                          rounded-xl bg-white border border-red-100 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-800">Clear All My Data</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Deletes stored CVs, JDs, and conversation history. Keeps your account.
              </p>
            </div>
            <button
              onClick={() => {
                // TODO Phase 6: DELETE /api/user/data → clearDocument()
                console.log('Clear user data');
              }}
              className="flex-shrink-0 px-4 py-2 rounded-xl bg-white border border-red-300
                         text-red-600 text-sm font-bold hover:bg-red-50
                         transition-colors active:scale-[0.97]"
            >
              Clear Data
            </button>
          </div>

          {/* Delete account (nuclear option) */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3
                          rounded-xl bg-red-100 border border-red-300 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-red-800">Delete My Account & All Data</p>
              <p className="text-xs text-red-600 mt-0.5">
                Permanently deletes your account, all data, and cancels any active subscription.
                This cannot be undone.
              </p>
            </div>
            <button
              onClick={() => setModalOpen(true)}
              className="flex-shrink-0 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700
                         text-white text-sm font-bold transition-colors
                         active:scale-[0.97] shadow-sm"
            >
              🗑 Delete Account
            </button>
          </div>
        </div>
      </Section>

      <DangerZoneModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onConfirm={handleConfirmDelete}
      />
    </>
  );
}

// ── Navbar ─────────────────────────────────────────────────────────────────────

function SettingsNavbar() {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);

  return (
    <nav className="fixed top-0 inset-x-0 z-40 glass border-b border-white/20">
      <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-slate-400 hover:text-slate-700 transition-colors text-sm"
          >
            ← Hub
          </button>
          <span className="text-slate-200">|</span>
          <span className="font-bold text-base tracking-tight text-slate-900">
            Jobif<span className="text-brand-600">AI</span>
          </span>
        </div>
        <span className="text-xs font-bold text-slate-500 bg-slate-100
                         px-2.5 py-1 rounded-full">
          Settings
        </span>
        {user && (
          <span className="hidden sm:block text-xs text-slate-400 font-mono truncate max-w-[160px]">
            {user.email}
          </span>
        )}
      </div>
    </nav>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto scrollbar-hidden bg-bg">
      <DevNav />
      <SettingsNavbar />

      <main className="pt-24 pb-20 px-4 max-w-3xl mx-auto">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
            Settings
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage your account, privacy, and preferences.
          </p>
        </div>

        {/* Vertical section stack */}
        <div className="space-y-4">
          <ProfileSection />
          <ByokSection />
          <LanguageSection />
          <SubscriptionSection />
          <NotificationsSection />
          <DangerZoneSection />
        </div>
      </main>
    </div>
  );
}
