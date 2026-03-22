/**
 * components/document/StandardA4Layout.tsx — Interactive HTML Resume Paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure presenter component that renders the resume as an interactive HTML
 * "paper" sheet. This is NOT a PDF component — it uses React hooks freely.
 *
 * Architecture:
 *   • Receives all display data via props (pure presenter pattern)
 *   • Uses useAppStore directly for inline bullet edits (applyDiff pattern)
 *   • Does NOT import @react-pdf/renderer
 *   • Typography mirrors ResumePDF.tsx exactly (1pt ≈ 1.333px at 96dpi)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Edit3, Loader2, Sparkles } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import type { ExperienceEntry, EducationEntry, ResumeData } from '@/types';

// ── Date formatter (mirrors ResumePDF.tsx exactly) ────────────────────────────
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'Present';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = iso.match(/^(\d{4})-(\d{2})$/);
  if (!m) return iso;
  return `${MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`;
}

// ── Props Interface ────────────────────────────────────────────────────────────
export interface StandardA4LayoutProps {
  resumeData:    Partial<ResumeData>;
  ghostKeywords: string[];
  flashingIds:   Set<string>;
  isUnlocked:    boolean;
  userEmail?:    string | null;
  onMagic:       (fieldPath: string, text: string, section: string) => Promise<void>;
  onGhostClick:  (keyword: string) => void;
  onPaywall:     () => void;
}

// ── PaperSectionHead ──────────────────────────────────────────────────────────
const PaperSectionHead: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 mb-2 mt-5 first:mt-0">
    <span className="text-[16px] font-bold uppercase tracking-[0.04em] text-black whitespace-nowrap leading-none">
      {label}
    </span>
    <div className="flex-1 h-[0.75px] bg-gray-300" />
  </div>
);

// ── GhostWord ─────────────────────────────────────────────────────────────────
const GhostWord: React.FC<{ keyword: string; onClick: (k: string) => void }> = ({ keyword, onClick }) => (
  <motion.span
    role="button"
    tabIndex={0}
    className="text-[13px] text-slate-300 border-b border-dashed border-slate-200 cursor-pointer hover:text-slate-400 hover:border-slate-300 transition-colors select-none"
    whileHover={{ scale: 1.03 }}
    whileTap={{ scale: 0.97 }}
    title={`"${keyword}" is missing — click to get coaching on adding it authentically`}
    onClick={() => onClick(keyword)}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(keyword); }}
  >
    {keyword}
  </motion.span>
);

// ── EditableBullet ────────────────────────────────────────────────────────────
interface EditableBulletProps {
  text:        string;
  fieldPath:   string;
  section:     string;
  isUnlocked:  boolean;
  onMagic:     (fieldPath: string, text: string, section: string) => Promise<void>;
  onPaywall:   () => void;
}

const EditableBullet: React.FC<EditableBulletProps> = ({
  text, fieldPath, section, isUnlocked, onMagic, onPaywall,
}) => {
  const [hovered,     setHovered]     = useState(false);
  const [isEditing,   setIsEditing]   = useState(false);
  const [editValue,   setEditValue]   = useState(text);
  const [isMagicking, setIsMagicking] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const applyDiff = useAppStore((s) => s.applyDiff);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (isEditing) {
      const t = setTimeout(() => editRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [isEditing]);

  const commitEdit = useCallback(() => {
    if (editValue.trim() && editValue.trim() !== text) {
      useAppStore.setState((state) => ({
        pendingDiff: {
          fieldPath,
          oldText:                text,
          newText:                editValue.trim(),
          predictedScoreIncrease: 0,
          baselineScore:          state.currentAtsScore,
        },
      }));
      applyDiff();
    }
    setIsEditing(false);
  }, [editValue, text, fieldPath, applyDiff]);

  const handleMagicClick = useCallback(async () => {
    if (!isUnlocked) {
      onPaywall();
      return;
    }
    setIsMagicking(true);
    try {
      await onMagic(fieldPath, text, section);
    } finally {
      setIsMagicking(false);
    }
  }, [isUnlocked, onPaywall, onMagic, fieldPath, text, section]);

  if (isEditing) {
    return (
      <li className="flex gap-2 list-none">
        <span className="text-[13px] text-gray-400 flex-shrink-0 mt-1 select-none">•</span>
        <div className="flex-1 space-y-1.5">
          <textarea
            ref={editRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') setIsEditing(false);
            }}
            rows={2}
            className="w-full text-[13px] text-[#111111] leading-[1.45] bg-gray-50 border border-orange-300/60 rounded px-2 py-1 resize-none outline-none focus:border-orange-400/80 transition-colors"
          />
          <div className="flex gap-1.5">
            <button
              onClick={commitEdit}
              className="text-[10px] font-semibold text-white bg-orange-500 hover:bg-orange-600 rounded px-2.5 py-1 transition-colors"
            >
              Save ⌘↩
            </button>
            <button
              onClick={() => { setIsEditing(false); setEditValue(text); }}
              className="text-[10px] font-medium text-gray-500 hover:text-gray-700 rounded px-2 py-1 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li
      className="flex gap-2 list-none relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="text-[13px] text-gray-400 flex-shrink-0 mt-0 select-none">•</span>
      <span className="text-[13px] text-[#111111] leading-[1.45] flex-1">{text}</span>

      {/* Hover toolbar */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            className="absolute right-0 top-0 flex items-center gap-0 bg-white border border-gray-200 rounded shadow-md z-10"
            initial={{ opacity: 0, scale: 0.85, x: 4 }}
            animate={{ opacity: 1, scale: 1,   x: 0 }}
            exit={{ opacity: 0, scale: 0.85, x: 4 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
          >
            {/* Edit button */}
            <button
              onClick={() => { setIsEditing(true); setEditValue(text); }}
              className="flex items-center gap-1 text-[10px] font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-l px-2 py-1 transition-colors"
              title="Edit this bullet"
            >
              <Edit3 className="w-2.5 h-2.5" />
              Edit
            </button>

            <div className="w-px h-4 bg-gray-200 flex-shrink-0" />

            {/* Magic button */}
            <button
              onClick={handleMagicClick}
              disabled={isMagicking}
              className="flex items-center gap-1 text-[10px] font-medium text-orange-600 hover:text-orange-700 hover:bg-orange-50 rounded-r px-2 py-1 transition-colors disabled:opacity-50"
              title={isUnlocked ? 'AI Magic Rewrite' : 'Unlock to use Magic Rewrite'}
            >
              {isMagicking ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <Sparkles className="w-2.5 h-2.5" />
              )}
              Magic
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
};

// ── PaperExpEntry ─────────────────────────────────────────────────────────────
interface PaperExpEntryProps {
  entry:       ExperienceEntry;
  isFlashing:  boolean;
  isUnlocked:  boolean;
  onMagic:     (fieldPath: string, text: string, section: string) => Promise<void>;
  onPaywall:   () => void;
}

const PaperExpEntry: React.FC<PaperExpEntryProps> = ({
  entry, isFlashing, isUnlocked, onMagic, onPaywall,
}) => {
  const [hovered, setHovered] = useState(false);
  const [sectionMagicking, setSectionMagicking] = useState(false);

  const handleSectionMagic = useCallback(async () => {
    if (!isUnlocked) {
      onPaywall();
      return;
    }
    setSectionMagicking(true);
    try {
      await onMagic(
        `experiences.${entry.id}.responsibilities`,
        entry.responsibilities.join('\n'),
        `${entry.title} at ${entry.company}`,
      );
    } finally {
      setSectionMagicking(false);
    }
  }, [isUnlocked, onPaywall, onMagic, entry]);

  return (
    <motion.div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      animate={{
        boxShadow: isFlashing
          ? [
              '0 0 0 2px rgba(251,146,60,0.7), 0 0 16px rgba(251,146,60,0.2)',
              '0 0 0 2px rgba(251,146,60,0.3), 0 0 8px rgba(251,146,60,0.1)',
              '0 0 0 0px rgba(251,146,60,0)',
            ]
          : '0 0 0 0px rgba(251,146,60,0)',
      }}
      transition={{ boxShadow: { duration: 1.4, ease: 'easeOut' } }}
    >
      {/* Section-level hover toolbar */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            className="absolute top-0 right-0 flex items-center gap-0 bg-white border border-gray-200 rounded shadow-md z-10"
            initial={{ opacity: 0, scale: 0.85, y: -4 }}
            animate={{ opacity: 1, scale: 1,   y: 0 }}
            exit={{ opacity: 0, scale: 0.85, y: -4 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
          >
            {/* Magic Rewrite button */}
            <button
              onClick={handleSectionMagic}
              disabled={sectionMagicking}
              className="flex items-center gap-1 text-[10px] font-medium text-orange-600 hover:text-orange-700 hover:bg-orange-50 rounded-l px-2 py-1 transition-colors disabled:opacity-50"
              title={isUnlocked ? 'Magic Rewrite entire entry' : 'Unlock to use Magic Rewrite'}
            >
              {sectionMagicking ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <Sparkles className="w-2.5 h-2.5" />
              )}
              Magic Rewrite
            </button>

            <div className="w-px h-4 bg-gray-200 flex-shrink-0" />

            {/* Edit button — future feature; shows tooltip */}
            <button
              className="flex items-center gap-1 text-[10px] font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-r px-2 py-1 transition-colors"
              title="Edit individual bullets below"
              onClick={() => {/* Section-level edit is a future feature */}}
            >
              <Edit3 className="w-2.5 h-2.5" />
              Edit
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Entry content */}
      <div className="flex items-baseline justify-between gap-4 mb-0.5">
        <span className="text-[15px] font-bold text-black leading-snug">{entry.title}</span>
        <span className="text-[13px] italic text-gray-500 whitespace-nowrap flex-shrink-0">
          {fmtDate(entry.startDate)} – {fmtDate(entry.endDate)}
        </span>
      </div>
      <p className="text-[13px] text-gray-600 mb-1.5">{entry.company}</p>

      {entry.responsibilities.length > 0 && (
        <ul className="space-y-1 mb-1.5">
          {entry.responsibilities.map((r, i) => (
            <EditableBullet
              key={`${entry.id}-r-${i}`}
              text={r}
              fieldPath={`experiences.${entry.id}.responsibilities.${i}`}
              section={`${entry.title} at ${entry.company}`}
              isUnlocked={isUnlocked}
              onMagic={onMagic}
              onPaywall={onPaywall}
            />
          ))}
        </ul>
      )}

      {entry.metrics.length > 0 && (
        <ul className="space-y-1">
          {entry.metrics.map((m, i) => (
            <li key={`${entry.id}-m-${i}`} className="flex gap-2 list-none">
              <span className="text-[13px] text-gray-400 flex-shrink-0 select-none">•</span>
              <span className="text-[13px] text-[#111111] leading-[1.45]">{m}</span>
            </li>
          ))}
        </ul>
      )}
    </motion.div>
  );
};

// ── StandardA4Layout (main component) ─────────────────────────────────────────
export const StandardA4Layout: React.FC<StandardA4LayoutProps> = ({
  resumeData,
  ghostKeywords,
  flashingIds,
  isUnlocked,
  userEmail,
  onMagic,
  onGhostClick,
  onPaywall,
}) => {
  const experiences = resumeData.experiences ?? [];
  const education   = resumeData.education   ?? [];
  const skills      = resumeData.skills      ?? [];

  // Summary section magic handler
  const [summaryMagicking, setSummaryMagicking] = useState(false);
  const [summaryHovered,   setSummaryHovered]   = useState(false);

  const handleSummaryMagic = useCallback(async () => {
    if (!isUnlocked) {
      onPaywall();
      return;
    }
    if (!resumeData.summary) return;
    setSummaryMagicking(true);
    try {
      await onMagic('summary', resumeData.summary, 'Professional Summary');
    } finally {
      setSummaryMagicking(false);
    }
  }, [isUnlocked, onPaywall, onMagic, resumeData.summary]);

  return (
    <motion.div
      className="bg-white border border-gray-200 shadow-[0_2px_16px_rgba(0,0,0,0.08)] mx-auto w-full max-w-[816px] min-h-[1056px]"
      style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
    >
      {/* Brand accent — visual only, never in PDF */}
      <div className="h-[3px] bg-gradient-to-r from-orange-500 via-orange-400 to-amber-400" />

      {/* 1-inch margins */}
      <div className="px-24 py-16">

        {/* ── HEADER ────────────────────────────────────────────────────────── */}
        <div className="mb-4">
          {resumeData.targetTitle && (
            <h1 className="text-[24px] font-bold text-black leading-tight tracking-tight">
              {resumeData.targetTitle}
            </h1>
          )}
          {userEmail && (
            <p className="text-[13px] text-gray-500 mt-0.5">{userEmail}</p>
          )}
          <div className="h-[0.75px] bg-gray-200 mt-3" />
        </div>

        {/* ── PROFESSIONAL SUMMARY ──────────────────────────────────────────── */}
        {resumeData.summary && (
          <div
            className="relative"
            onMouseEnter={() => setSummaryHovered(true)}
            onMouseLeave={() => setSummaryHovered(false)}
          >
            <PaperSectionHead label="Professional Summary" />
            <p className="text-[13px] text-[#111111] leading-[1.45]">
              {resumeData.summary}
            </p>

            {/* Summary Magic button */}
            <AnimatePresence>
              {summaryHovered && (
                <motion.button
                  className="absolute top-0 right-0 flex items-center gap-1 text-[10px] font-medium text-orange-600 hover:text-orange-700 bg-white hover:bg-orange-50 border border-orange-200 rounded shadow-sm px-2 py-1 transition-colors"
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                  onClick={handleSummaryMagic}
                  disabled={summaryMagicking}
                  title={isUnlocked ? 'AI Magic Rewrite' : 'Unlock to use Magic Rewrite'}
                >
                  {summaryMagicking ? (
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-2.5 h-2.5" />
                  )}
                  Magic
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* ── WORK EXPERIENCE ───────────────────────────────────────────────── */}
        {experiences.length > 0 && (
          <div>
            <PaperSectionHead label="Work Experience" />
            <div className="space-y-5">
              {experiences.map((exp) => (
                <PaperExpEntry
                  key={exp.id}
                  entry={exp}
                  isFlashing={flashingIds.has(exp.id)}
                  isUnlocked={isUnlocked}
                  onMagic={onMagic}
                  onPaywall={onPaywall}
                />
              ))}
            </div>

            {/* Ghost gaps row — below all entries, inside Experience section */}
            {ghostKeywords.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[11px] text-gray-400 italic">Consider adding:</span>
                {ghostKeywords.slice(0, 5).map((kw) => (
                  <GhostWord key={kw} keyword={kw} onClick={onGhostClick} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── EDUCATION ─────────────────────────────────────────────────────── */}
        {education.length > 0 && (
          <div>
            <PaperSectionHead label="Education" />
            <div className="space-y-3">
              {education.map((edu) => (
                <motion.div
                  key={edu.id}
                  animate={{
                    boxShadow: flashingIds.has(edu.id)
                      ? [
                          '0 0 0 2px rgba(251,146,60,0.7), 0 0 16px rgba(251,146,60,0.2)',
                          '0 0 0 2px rgba(251,146,60,0.3), 0 0 8px rgba(251,146,60,0.1)',
                          '0 0 0 0px rgba(251,146,60,0)',
                        ]
                      : '0 0 0 0px rgba(251,146,60,0)',
                  }}
                  transition={{ boxShadow: { duration: 1.4, ease: 'easeOut' } }}
                  className="rounded"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-[13px] font-bold text-black leading-snug">
                      {edu.degree}{edu.field ? ` in ${edu.field}` : ''}
                    </span>
                    <span className="text-[13px] italic text-gray-500 whitespace-nowrap flex-shrink-0">
                      {edu.graduationYear}
                    </span>
                  </div>
                  <p className="text-[13px] text-gray-500">
                    {edu.institution}
                    {edu.honours && (
                      <span className="italic text-gray-400">{' · '}{edu.honours}</span>
                    )}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* ── SKILLS ────────────────────────────────────────────────────────── */}
        {(skills.length > 0 || ghostKeywords.length > 0) && (
          <div>
            <PaperSectionHead label="Skills" />
            <p className="text-[13px] text-[#111111] leading-[1.5]">
              {skills.join(', ')}
              {ghostKeywords.length > 0 && skills.length > 0 && ', '}
              {ghostKeywords.map((kw, i) => (
                <React.Fragment key={kw}>
                  {i > 0 && <span className="text-slate-300">, </span>}
                  <GhostWord keyword={kw} onClick={onGhostClick} />
                </React.Fragment>
              ))}
            </p>
          </div>
        )}

        {/* ── FOOTER ────────────────────────────────────────────────────────── */}
        <div className="mt-12 pt-4 border-t border-dashed border-gray-200">
          <p className="text-[9px] text-gray-400 text-center leading-relaxed">
            Generated by JobifAI · ATS-Optimised · Canadian HR Standards
          </p>
          <p className="text-[9px] text-gray-400 text-center leading-relaxed">
            Helvetica · 1-inch margins · ATS text layer
          </p>
        </div>

      </div>
    </motion.div>
  );
};
