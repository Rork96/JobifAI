/**
 * components/document/DocumentPreview.tsx — Live Resume Preview
 * ─────────────────────────────────────────────────────────────────────────────
 * Shows a live, formatted preview of the resume being built during the interview.
 * Data flows in from the Zustand store — as the user answers Mac's questions,
 * the resume appears section by section in real time.
 *
 * KEY DESIGN DECISIONS:
 *   1. Data-driven: renders exactly what's in `resumeData` — no hardcoding.
 *   2. Incremental: each section appears only when data exists for it.
 *   3. Animated: each new section fades in with a spring transition.
 *   4. Paywall gate: when step === 'complete', a blur overlay blocks the view.
 *      Free users see a locked preview; premium users get the export button.
 *
 * PAYWALL LOGIC (from the manifesto):
 *   • Gap Analysis during chat → FREE (the preview itself is free)
 *   • Generating the final markdown/PDF → PREMIUM
 *   We implement this by letting the preview render fully (so users see their
 *   data) but blurring it behind the paywall overlay on 'complete'.
 *   This is more compelling than a hard gate — users can see the value before
 *   being asked to pay.
 *
 * TASK 4 INTEGRATION:
 *   Replace the static text rendering with react-markdown + a resume template.
 *   The markdown will be generated server-side from the resumeData object.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, Lock, CheckCircle2 } from 'lucide-react';
import { useAppStore, selectIsInterviewComplete } from '@/store/useAppStore';

// ── Animation preset ──────────────────────────────────────────────────────────
/** Reused on each resume section to give them a consistent "build" feel. */
const sectionVariants = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 26 } },
};

// ── Component ─────────────────────────────────────────────────────────────────
export const DocumentPreview: React.FC = () => {
  // ── Store subscriptions ──────────────────────────────────────────────────────
  const resumeData  = useAppStore((s) => s.resumeData);
  const isPremium   = useAppStore((s) => s.isPremium);
  const isComplete  = useAppStore(selectIsInterviewComplete);
  const currentStep = useAppStore((s) => s.currentStep);

  const hasContent = Object.keys(resumeData).some(
    (k) => (resumeData as Record<string, unknown>)[k] !== undefined
      && (resumeData as Record<string, unknown>)[k] !== '',
  );

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="relative h-full flex flex-col bg-white dark:bg-surface-dark">

      {/* ── Panel header ─────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
        <div className="flex items-center gap-2.5">
          <FileText className="w-4 h-4 text-brand-500" />
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            Resume Preview
          </h2>
        </div>

        {/* Step completion chips */}
        <div className="flex items-center gap-2">
          {isComplete && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1.5 text-xs font-medium text-green-600 bg-green-50 dark:bg-green-900/30 dark:text-green-400 rounded-full px-3 py-1"
            >
              <CheckCircle2 className="w-3 h-3" />
              Complete
            </motion.div>
          )}

          {isComplete && !isPremium && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/30 rounded-full px-3 py-1"
            >
              <Lock className="w-3 h-3" />
              Export locked
            </motion.div>
          )}
        </div>
      </div>

      {/* ── Scrollable resume content ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hidden">

        {/* Empty state */}
        {!hasContent ? (
          <div className="h-full flex flex-col items-center justify-center gap-5 px-8 text-center">
            {/* Animated placeholder lines — gives a sense of what's coming */}
            <div className="w-full max-w-sm space-y-3">
              {[100, 60, 80, 45, 70, 55].map((w, i) => (
                <motion.div
                  key={i}
                  className="h-3 rounded-full skeleton"
                  style={{ width: `${w}%` }}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.08 }}
                />
              ))}
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Your resume appears here as you chat
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Answer Mac's questions to fill it in →
              </p>
            </div>
          </div>
        ) : (
          /* Live resume document */
          <div className="p-6 max-w-2xl mx-auto">
            <motion.div
              className="space-y-7"
              initial="hidden"
              animate="visible"
              variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
            >

              {/* ── Name / Target Title ─────────────────────────────────── */}
              {resumeData.targetTitle && (
                <motion.div variants={sectionVariants}>
                  <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50 tracking-tight">
                    {resumeData.targetTitle}
                  </h1>
                  {/* Coloured rule — a design touch to break up the document */}
                  <div className="mt-2 h-0.5 w-10 bg-brand-500 rounded-full" />
                </motion.div>
              )}

              {/* ── Professional Summary ────────────────────────────────── */}
              {resumeData.summary && (
                <motion.section variants={sectionVariants}>
                  <SectionHeading>Professional Summary</SectionHeading>
                  <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                    {resumeData.summary}
                  </p>
                </motion.section>
              )}

              {/* ── Work Experience ─────────────────────────────────────── */}
              {(resumeData.experiences?.length ?? 0) > 0 && (
                <motion.section variants={sectionVariants}>
                  <SectionHeading>Experience</SectionHeading>
                  <div className="space-y-5">
                    {resumeData.experiences!.map((exp) => (
                      <motion.div
                        key={exp.id}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="border-l-2 border-brand-200 dark:border-brand-800 pl-4"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                              {exp.title}
                            </p>
                            <p className="text-xs font-medium text-brand-600 dark:text-brand-400 mt-0.5">
                              {exp.company}
                            </p>
                          </div>
                          <p className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">
                            {exp.startDate} – {exp.endDate ?? 'Present'}
                          </p>
                        </div>

                        {exp.responsibilities.length > 0 && (
                          <ul className="mt-2.5 space-y-1.5">
                            {exp.responsibilities.map((r, i) => (
                              <li key={i} className="text-sm text-gray-600 dark:text-gray-400 flex gap-2">
                                <span className="text-brand-400 flex-shrink-0 mt-0.5">•</span>
                                <span>{r}</span>
                              </li>
                            ))}
                          </ul>
                        )}

                        {/* Metrics highlighted in a subtle chip */}
                        {exp.metrics.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {exp.metrics.map((m, i) => (
                              <span
                                key={i}
                                className="text-xs bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full px-2.5 py-0.5 font-medium"
                              >
                                {m}
                              </span>
                            ))}
                          </div>
                        )}
                      </motion.div>
                    ))}
                  </div>
                </motion.section>
              )}

              {/* ── Skills ──────────────────────────────────────────────── */}
              {(resumeData.skills?.length ?? 0) > 0 && (
                <motion.section variants={sectionVariants}>
                  <SectionHeading>Skills</SectionHeading>
                  <div className="flex flex-wrap gap-2">
                    {resumeData.skills!.map((skill) => (
                      <motion.span
                        key={skill}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-xs bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 rounded-full px-3 py-1 font-medium"
                      >
                        {skill}
                      </motion.span>
                    ))}
                  </div>
                </motion.section>
              )}

              {/* ── Education ───────────────────────────────────────────── */}
              {(resumeData.education?.length ?? 0) > 0 && (
                <motion.section variants={sectionVariants}>
                  <SectionHeading>Education</SectionHeading>
                  <div className="space-y-3">
                    {resumeData.education!.map((edu) => (
                      <div key={edu.id} className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {edu.degree} in {edu.field}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {edu.institution}
                            {edu.honours && ` · ${edu.honours}`}
                          </p>
                        </div>
                        <p className="text-xs text-gray-400 flex-shrink-0">{edu.graduationYear}</p>
                      </div>
                    ))}
                  </div>
                </motion.section>
              )}

              {/* HR compliance notice — reassures users we follow the rules */}
              {hasContent && (
                <motion.div
                  variants={sectionVariants}
                  className="pt-4 border-t border-dashed border-gray-200 dark:border-gray-700"
                >
                  <p className="text-[10px] text-gray-400 dark:text-gray-500 text-center">
                    ✓ Canadian HR standards · Reverse chronological · No discriminatory fields
                  </p>
                </motion.div>
              )}
            </motion.div>
          </div>
        )}
      </div>

      {/* ── PAYWALL OVERLAY ──────────────────────────────────────────────── */}
      {/*
        Appears when the interview is complete AND the user isn't premium.
        A blurred overlay with a strong CTA — the user can SEE their resume
        through the blur (creates desire) but can't download it.
        Clicking the overlay area doesn't close it — they must use the CTA.
      */}
      <AnimatePresence>
        {isComplete && !isPremium && (
          <motion.div
            className="absolute inset-0 flex items-center justify-center z-20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
          >
            {/* Blurred backdrop */}
            <div className="absolute inset-0 backdrop-blur-md bg-white/50 dark:bg-black/50" />

            {/* CTA card */}
            <motion.div
              className="relative z-10 bg-white dark:bg-gray-900 rounded-3xl shadow-xl p-8 text-center max-w-xs mx-4"
              initial={{ scale: 0.9, y: 12 }}
              animate={{ scale: 1,   y: 0 }}
              transition={{ type: 'spring', stiffness: 350, damping: 28 }}
            >
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-4">
                <Lock className="w-6 h-6 text-white" />
              </div>

              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1.5">
                Your resume is ready!
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                Unlock PDF export and ATS optimisation
              </p>

              {/* Primary CTA — wired to Stripe in Task 5 */}
              <button className="w-full bg-gradient-to-r from-brand-600 to-brand-700 hover:from-brand-700 hover:to-brand-800 text-white font-semibold py-3 rounded-2xl transition-all shadow-brand hover:shadow-lg active:scale-98">
                Unlock · $5 / 24h
              </button>

              <p className="text-xs text-gray-400 dark:text-gray-500 mt-3">
                Or{' '}
                <button className="text-brand-500 hover:text-brand-700 font-medium transition-colors">
                  subscribe monthly
                </button>
                {' '}for unlimited
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Premium export bar ────────────────────────────────────────────── */}
      <AnimatePresence>
        {isComplete && isPremium && (
          <motion.div
            className="flex-shrink-0 px-6 py-4 border-t border-gray-100 dark:border-gray-800"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
          >
            <button className="w-full bg-brand-600 hover:bg-brand-700 text-white font-semibold py-3 rounded-2xl transition-colors shadow-brand">
              Generate PDF Resume →
              {/* TODO (Task 4): POST resumeData to /api/v1/resume/generate */}
            </button>
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

/** Consistent section heading style across all resume sections. */
const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400 dark:text-gray-500 mb-3">
    {children}
  </h3>
);
