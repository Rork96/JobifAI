/**
 * components/document/DocumentPreview.tsx — Live Resume Preview (Canvas)
 * ─────────────────────────────────────────────────────────────────────────────
 * The "Canvas" — a live, formatted preview of the resume being built.
 *
 * VISUAL DESIGN — Graphite / Orange Theme:
 *   • Outer panel:   slate-900  (darkest — the "desk" the document sits on)
 *   • Paper surface: slate-800  (slightly lighter — the document "sheet")
 *   • Accent colour: orange-400 / orange-500 (brand warm tone)
 *   • Text:          slate-100 / slate-300 / slate-400 (off-white hierarchy)
 *
 * The dark theme was chosen because:
 *   1. It contrasts beautifully with the light ChatPanel on the left
 *   2. The orange-on-dark palette feels premium and modern (Figma / Linear vibes)
 *   3. It makes the orange flash animation highly visible when new bullets arrive
 *
 * HIGHLIGHT-FLASH ANIMATION (new data from AI):
 *   When a new experience entry, skill, or education entry arrives via the
 *   validated data_extract → evaluate → commit pipeline, the new item flashes
 *   with a soft orange ring glow that fades out over 1.4 seconds.
 *
 *   Implementation:
 *     1. `seenIdsRef` tracks all item IDs/keys we've already seen (persistent Set)
 *     2. A `useEffect` on `resumeData` detects newly arrived items (not in seenIds)
 *     3. New items are added to `flashingIds` state (triggers re-render)
 *     4. Each item renders a Framer Motion boxShadow animation if its ID is in
 *        `flashingIds` — it's removed from the set after 1.4 s
 *
 * PAYWALL LOGIC:
 *   • The preview is always visible (free) — users can see the value they built
 *   • PDF/markdown EXPORT is the premium gate ($5/24h or monthly)
 *   • At step 'complete', a blur overlay prompts upgrade without hiding the doc
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, Lock, CheckCircle2, Sparkles, Download, Loader2 } from 'lucide-react';
import { useAppStore, selectIsInterviewComplete } from '@/store/useAppStore';
import { BYOK_STORAGE_KEY } from '@/components/paywall/BYOKModal';
import type { ResumeData } from '@/types';

// ── Section-fade preset ───────────────────────────────────────────────────────
/** Each resume section slides in from slightly below when it first appears. */
const sectionVariants = {
  hidden:  { opacity: 0, y: 14 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 280, damping: 24 },
  },
};

// ── Component ─────────────────────────────────────────────────────────────────
export const DocumentPreview: React.FC = () => {

  // ── Store ─────────────────────────────────────────────────────────────────
  const resumeData         = useAppStore((s) => s.resumeData);
  const uploadedResumeText = useAppStore((s) => s.uploadedResumeText);
  const isPremium          = useAppStore((s) => s.isPremium);
  const isComplete         = useAppStore(selectIsInterviewComplete);
  const currentStep        = useAppStore((s) => s.currentStep);

  // BYOK users brought their own Gemini key → treat them as premium (they paid
  // with their API quota, not our Stripe paywall).  Read on each render so the
  // overlay disappears the instant the user enters their key in BYOKModal.
  const hasByokKey  = Boolean(localStorage.getItem(BYOK_STORAGE_KEY));

  // User is "unlocked" if they paid via Stripe OR supplied a BYOK key
  const isUnlocked  = isPremium || hasByokKey;

  // User email from auth (may be null for anonymous BYOK users)
  const userEmail   = useAppStore((s) => s.user?.email);

  // ── PDF Generation ───────────────────────────────────────────────────────
  // State tracks whether a PDF build is in progress (can take 0.5–2 s depending
  // on resume length and device).
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfError,        setPdfError]        = useState('');

  /**
   * Generates the PDF client-side using @react-pdf/renderer and triggers a
   * browser file download.
   *
   * WHY dynamic import?
   *   @react-pdf/renderer adds ~520 kB to the bundle.  Lazy-loading it means
   *   every user who hasn't completed the interview (i.e. the vast majority
   *   of page-loads) never downloads that code.  It's fetched only when the
   *   user clicks "Download PDF".
   */
  const handleDownloadPdf = async () => {
    if (isGeneratingPdf) return;
    setIsGeneratingPdf(true);
    setPdfError('');

    try {
      // Dynamic imports — only loaded when the user actually clicks Download
      const [{ pdf }, { ResumePDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./ResumePDF'),
      ]);

      const doc  = <ResumePDF data={resumeData as ResumeData} userEmail={userEmail} />;
      const blob = await pdf(doc).toBlob();

      // Build a safe filename: "Senior_Dev_JobifAI.pdf"
      const safeName = (resumeData.targetTitle ?? 'resume')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '_');

      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `${safeName}_JobifAI.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (err) {
      console.error('[ResumePDF] generation failed:', err);
      setPdfError('PDF generation failed. Please try again.');
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const hasContent = Object.values(resumeData).some((v) =>
    v !== undefined && v !== '' && (Array.isArray(v) ? v.length > 0 : true),
  );

  // ── Highlight-flash tracking ───────────────────────────────────────────────
  // `seenIdsRef` is a persistent Set of item IDs already animated.
  // We never remove entries from it — once seen, always seen.
  const seenIdsRef  = useRef<Set<string>>(new Set());
  const [flashingIds, setFlashingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fresh: string[] = [];

    for (const exp of resumeData.experiences ?? []) {
      if (!seenIdsRef.current.has(exp.id)) {
        seenIdsRef.current.add(exp.id);
        fresh.push(exp.id);
      }
    }
    for (const edu of resumeData.education ?? []) {
      if (!seenIdsRef.current.has(edu.id)) {
        seenIdsRef.current.add(edu.id);
        fresh.push(edu.id);
      }
    }
    for (const skill of resumeData.skills ?? []) {
      const key = `skill:${skill}`;
      if (!seenIdsRef.current.has(key)) {
        seenIdsRef.current.add(key);
        fresh.push(key);
      }
    }

    if (fresh.length === 0) return;

    // Add fresh items to the flashing set
    setFlashingIds((prev) => {
      const next = new Set(prev);
      fresh.forEach((id) => next.add(id));
      return next;
    });

    // Clear the flash after the animation completes (1.4 s)
    const timer = setTimeout(() => {
      setFlashingIds((prev) => {
        const next = new Set(prev);
        fresh.forEach((id) => next.delete(id));
        return next;
      });
    }, 1400);

    return () => clearTimeout(timer);
  }, [resumeData]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="relative h-full flex flex-col bg-slate-900">

      {/* ── Panel header ─────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-slate-700/60">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-orange-400" />
          <h2 className="text-sm font-semibold text-slate-200">
            Resume Preview
          </h2>
        </div>

        <div className="flex items-center gap-2">
          {isComplete && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2.5 py-0.5"
            >
              <CheckCircle2 className="w-3 h-3" />
              Complete
            </motion.div>
          )}
          {isComplete && !isUnlocked && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-full px-2.5 py-0.5"
            >
              <Lock className="w-3 h-3" />
              Export locked
            </motion.div>
          )}
        </div>
      </div>

      {/* ── Scrollable resume content ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hidden">

        {/* ── Empty state ───────────────────────────────────────────────── */}
        {!hasContent ? (
          uploadedResumeText?.trim() ? (
            /* ── Raw upload preview — Mac is analyzing ─────────────────── */
            <div className="p-4 pb-8">
              <motion.div
                className="bg-slate-800 rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              >
                <div className="h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-400" />
                <div className="p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin" />
                    <span className="text-xs font-semibold text-orange-400 uppercase tracking-wide">
                      Mac is analyzing your resume…
                    </span>
                  </div>
                  <pre className="text-xs text-slate-400 whitespace-pre-wrap break-words leading-relaxed font-mono max-h-[60vh] overflow-y-auto scrollbar-hidden">
                    {uploadedResumeText.slice(0, 4000)}
                    {uploadedResumeText.length > 4000 && '\n\n[…truncated for preview]'}
                  </pre>
                </div>
              </motion.div>
            </div>
          ) : (
            /* ── Default skeleton — no content yet ─────────────────────── */
            <div className="h-full flex flex-col items-center justify-center gap-5 px-8 py-10 text-center">
              <div className="w-full max-w-sm space-y-3">
                {[100, 55, 75, 42, 68, 50].map((w, i) => (
                  <motion.div
                    key={i}
                    className="h-2.5 rounded-full bg-slate-700/80"
                    style={{ width: `${w}%` }}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: [0.4, 0.7, 0.4] }}
                    transition={{
                      opacity: { repeat: Infinity, duration: 1.8, delay: i * 0.1 },
                      x: { duration: 0.3, delay: i * 0.06 },
                    }}
                  />
                ))}
              </div>
              <div className="mt-2">
                <p className="text-sm font-medium text-slate-400">
                  Your resume appears here as you chat
                </p>
                <p className="text-xs text-slate-600 mt-1">
                  Answer Mac's questions to fill it in →
                </p>
              </div>
            </div>
          )
        ) : (
          /* ── Live resume document (the "paper") ──────────────────────── */
          <div className="p-4 pb-8">
            <motion.div
              className="bg-slate-800 rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            >
              {/* Orange top-bar accent — the "header rule" of the document */}
              <div className="h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-400" />

              <div className="p-6 space-y-6">
                <motion.div
                  className="space-y-6"
                  initial="hidden"
                  animate="visible"
                  variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
                >

                  {/* ── Target Title ──────────────────────────────────── */}
                  {resumeData.targetTitle && (
                    <motion.div variants={sectionVariants}>
                      <h1 className="text-xl font-bold text-slate-100 tracking-tight leading-tight">
                        {resumeData.targetTitle}
                      </h1>
                      <div className="mt-2 h-0.5 w-12 bg-gradient-to-r from-orange-500 to-amber-400 rounded-full" />
                    </motion.div>
                  )}

                  {/* ── Professional Summary ──────────────────────────── */}
                  {resumeData.summary && (
                    <motion.section variants={sectionVariants}>
                      <SectionHeading>Professional Summary</SectionHeading>
                      <p className="text-sm text-slate-300 leading-relaxed">
                        {resumeData.summary}
                      </p>
                    </motion.section>
                  )}

                  {/* ── Work Experience ───────────────────────────────── */}
                  {(resumeData.experiences?.length ?? 0) > 0 && (
                    <motion.section variants={sectionVariants}>
                      <SectionHeading>Experience</SectionHeading>
                      <div className="space-y-5">
                        {resumeData.experiences!.map((exp) => {
                          const isFlashing = flashingIds.has(exp.id);
                          return (
                            <motion.div
                              key={exp.id}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{
                                opacity: 1,
                                x: 0,
                                boxShadow: isFlashing
                                  ? [
                                      '0 0 0 2px rgba(251,146,60,0.7), 0 0 16px rgba(251,146,60,0.2)',
                                      '0 0 0 2px rgba(251,146,60,0.3), 0 0 8px rgba(251,146,60,0.1)',
                                      '0 0 0 0px rgba(251,146,60,0)',
                                    ]
                                  : '0 0 0 0px rgba(251,146,60,0)',
                              }}
                              transition={{
                                opacity: { duration: 0.3 },
                                x: { duration: 0.3 },
                                boxShadow: { duration: 1.4, ease: 'easeOut' },
                              }}
                              className="border-l-2 border-orange-500/40 pl-4 rounded-r-lg"
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <p className="text-sm font-semibold text-slate-100">
                                    {exp.title}
                                  </p>
                                  <p className="text-xs font-medium text-orange-400 mt-0.5">
                                    {exp.company}
                                  </p>
                                </div>
                                <p className="text-xs text-slate-500 whitespace-nowrap flex-shrink-0 font-mono">
                                  {exp.startDate} – {exp.endDate ?? 'Present'}
                                </p>
                              </div>

                              {exp.responsibilities.length > 0 && (
                                <ul className="mt-2.5 space-y-1.5">
                                  {exp.responsibilities.map((r, i) => (
                                    <li
                                      key={i}
                                      className="text-sm text-slate-300 flex gap-2"
                                    >
                                      <span className="text-orange-500/70 flex-shrink-0 mt-0.5 select-none">
                                        ›
                                      </span>
                                      <span>{r}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}

                              {exp.metrics.length > 0 && (
                                <div className="mt-2.5 flex flex-wrap gap-1.5">
                                  {exp.metrics.map((m, i) => (
                                    <span
                                      key={i}
                                      className="text-xs bg-emerald-500/12 text-emerald-300 border border-emerald-500/20 rounded-full px-2.5 py-0.5 font-medium"
                                    >
                                      📈 {m}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </motion.div>
                          );
                        })}
                      </div>
                    </motion.section>
                  )}

                  {/* ── Skills ────────────────────────────────────────── */}
                  {(resumeData.skills?.length ?? 0) > 0 && (
                    <motion.section variants={sectionVariants}>
                      <SectionHeading>Skills</SectionHeading>
                      <div className="flex flex-wrap gap-1.5">
                        {resumeData.skills!.map((skill) => {
                          const key = `skill:${skill}`;
                          const isFlashing = flashingIds.has(key);
                          return (
                            <motion.span
                              key={skill}
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{
                                opacity: 1,
                                scale: 1,
                                boxShadow: isFlashing
                                  ? [
                                      '0 0 0 2px rgba(251,146,60,0.6)',
                                      '0 0 0 1px rgba(251,146,60,0.2)',
                                      '0 0 0 0px rgba(251,146,60,0)',
                                    ]
                                  : '0 0 0 0px rgba(251,146,60,0)',
                              }}
                              transition={{
                                opacity: { duration: 0.25 },
                                scale: { type: 'spring', stiffness: 380, damping: 22 },
                                boxShadow: { duration: 1.4, ease: 'easeOut' },
                              }}
                              className="text-xs bg-orange-500/12 text-orange-300 border border-orange-500/20 rounded-full px-3 py-1 font-medium"
                            >
                              {skill}
                            </motion.span>
                          );
                        })}
                      </div>
                    </motion.section>
                  )}

                  {/* ── Education ─────────────────────────────────────── */}
                  {(resumeData.education?.length ?? 0) > 0 && (
                    <motion.section variants={sectionVariants}>
                      <SectionHeading>Education</SectionHeading>
                      <div className="space-y-3">
                        {resumeData.education!.map((edu) => {
                          const isFlashing = flashingIds.has(edu.id);
                          return (
                            <motion.div
                              key={edu.id}
                              animate={{
                                boxShadow: isFlashing
                                  ? [
                                      '0 0 0 2px rgba(251,146,60,0.6)',
                                      '0 0 0 0px rgba(251,146,60,0)',
                                    ]
                                  : '0 0 0 0px rgba(251,146,60,0)',
                              }}
                              transition={{ duration: 1.4, ease: 'easeOut' }}
                              className="flex items-start justify-between gap-4 rounded-lg"
                            >
                              <div>
                                <p className="text-sm font-semibold text-slate-100">
                                  {edu.degree} in {edu.field}
                                </p>
                                <p className="text-xs text-slate-400 mt-0.5">
                                  {edu.institution}
                                  {edu.honours && (
                                    <span className="text-orange-400/80">
                                      {' · '}{edu.honours}
                                    </span>
                                  )}
                                </p>
                              </div>
                              <p className="text-xs text-slate-500 flex-shrink-0 font-mono">
                                {edu.graduationYear}
                              </p>
                            </motion.div>
                          );
                        })}
                      </div>
                    </motion.section>
                  )}

                  {/* ── HR compliance footer ──────────────────────────── */}
                  {hasContent && (
                    <motion.div
                      variants={sectionVariants}
                      className="pt-4 border-t border-dashed border-slate-700"
                    >
                      <p className="text-[10px] text-slate-600 text-center">
                        ✓ Canadian HR standards · Reverse chronological · No discriminatory fields
                      </p>
                    </motion.div>
                  )}

                </motion.div>
              </div>
            </motion.div>
          </div>
        )}
      </div>

      {/* ── PAYWALL OVERLAY ────────────────────────────────────────────────── */}
      <AnimatePresence>
        {isComplete && !isUnlocked && (
          <motion.div
            className="absolute inset-0 flex items-center justify-center z-20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {/* Blurred graphite backdrop */}
            <div className="absolute inset-0 backdrop-blur-md bg-slate-900/60" />

            {/* CTA card */}
            <motion.div
              className="relative z-10 bg-slate-800 border border-slate-700 rounded-3xl shadow-2xl p-8 text-center max-w-xs mx-4"
              initial={{ scale: 0.9, y: 16 }}
              animate={{ scale: 1,   y: 0 }}
              transition={{ type: 'spring', stiffness: 340, damping: 26 }}
            >
              {/* Sparkle icon in gradient square */}
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-orange-500/30">
                <Sparkles className="w-6 h-6 text-white" />
              </div>

              <h3 className="text-lg font-bold text-slate-100 mb-1.5">
                Your resume is ready!
              </h3>
              <p className="text-sm text-slate-400 mb-6">
                Unlock PDF export and ATS optimisation to download your polished resume.
              </p>

              {/* Primary CTA */}
              <button className="w-full bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-semibold py-3 rounded-2xl transition-all shadow-lg shadow-orange-500/25 hover:shadow-orange-500/40 active:scale-[0.98]">
                Unlock · $5 / 24h
              </button>

              <p className="text-xs text-slate-500 mt-3">
                Or{' '}
                <button className="text-orange-400 hover:text-orange-300 font-medium transition-colors">
                  subscribe monthly
                </button>
                {' '}for unlimited exports
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Export bar (unlocked users only) ──────────────────────────────── */}
      <AnimatePresence>
        {isComplete && isUnlocked && (
          <motion.div
            className="flex-shrink-0 px-4 py-3 border-t border-slate-700/60 space-y-2"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
          >
            {/* PDF download button */}
            <button
              onClick={handleDownloadPdf}
              disabled={isGeneratingPdf}
              className={[
                'w-full font-semibold py-3 rounded-2xl transition-all',
                'flex items-center justify-center gap-2 text-sm',
                'shadow-lg shadow-orange-500/25',
                isGeneratingPdf
                  ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                  : 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white hover:shadow-orange-500/40 active:scale-[0.98]',
              ].join(' ')}
            >
              {isGeneratingPdf ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Building PDF…
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Download ATS-Optimised PDF
                </>
              )}
            </button>

            {/* Error message */}
            <AnimatePresence>
              {pdfError && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="text-xs text-red-400 text-center"
                >
                  {pdfError}
                </motion.p>
              )}
            </AnimatePresence>

            {/* Fine-print: what the PDF includes */}
            <p className="text-[10px] text-slate-600 text-center">
              Helvetica · 1-inch margins · ATS text layer · Canadian HR standards
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ARIA live region — screen readers announce when the resume updates */}
      <div aria-live="polite" className="sr-only">
        {currentStep !== 'idle' && `Resume updated — now on step: ${currentStep}`}
      </div>
    </div>
  );
};


// ── Sub-component ──────────────────────────────────────────────────────────────

/** Section heading: small orange uppercase label with a divider line. */
const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-3 mb-3">
    <h3 className="text-[9px] font-bold uppercase tracking-[0.18em] text-orange-400 whitespace-nowrap">
      {children}
    </h3>
    <div className="flex-1 h-px bg-slate-700/70" />
  </div>
);
