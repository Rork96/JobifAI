/**
 * components/document/ResumePDF.tsx — ATS-Compliant PDF Generator
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates a strictly professional, single-column Canadian résumé PDF using
 * @react-pdf/renderer.  The design philosophy is deliberately "boring" — it
 * must look like it came out of a 1992 HP LaserJet.  That's the point.
 *
 * ATS COMPLIANCE RULES (enforced here):
 * ─────────────────────────────────────────────────────────────────────────────
 *   ✓  Pure text layer — no rasterised images, no bitmapped icons, no SVGs.
 *      Every character in this PDF is selectable and copy-pasteable.
 *
 *   ✓  Standard built-in fonts only — Helvetica, Helvetica-Bold, Helvetica-Oblique.
 *      These are embedded in every PDF reader since 1984 and require zero font
 *      embedding.  Custom fonts add binary blobs and confuse old ATS parsers.
 *
 *   ✓  No word hyphenation — hyphens break keyword matching.  "Kubernetes" split
 *      across a line becomes "Kube-\nnetes" — an ATS miss.  We suppress all
 *      automatic hyphenation via the Document-level hyphenationCallback.
 *
 *   ✓  Single column, left-aligned body — multi-column layouts are parsed
 *      left-to-right in reading order, which scrambles two-column résumés
 *      in many ATS systems (Taleo, Workday, Greenhouse).
 *
 *   ✓  Bullet points as Unicode "•" prefix text — native PDF list elements
 *      (`<ul>`, `<li>`) don't exist in PDF primitives; some ATS parsers only
 *      handle plain text bullets.  The Unicode bullet (U+2022) is universally
 *      safe and renders identically across all PDF viewers.
 *
 *   ✓  No colour except near-black (#111111) on white (#FFFFFF).
 *      Coloured text boxes, gradients, or tinted backgrounds cause OCR errors
 *      on scanned versions and confuse some ATS optical character recognition.
 *
 *   ✓  Dates as "MMM YYYY" (e.g. "Apr 2023") — ISO dates confuse parsers that
 *      expect month names; fully numeric dates (04/2023) are ambiguous between
 *      DD/MM and MM/DD.  Month abbreviation + year is the unambiguous standard.
 *
 *   ✓  wrap={false} on each experience entry — keeps Title + Company + Bullets
 *      together on the same page.  Splitting one job across pages is the #1
 *      layout complaint from Canadian recruiters.
 *
 *   ✓  Skills as a flat comma-separated sentence — bordered pill badges and
 *      tag clouds look pretty but are unparseable by many ATS systems that
 *      look for skills in plain-text lines, not in styled boxes.
 *
 *   ✓  Metrics merged into the main bullet list — coloured achievement "badges"
 *      have no semantic meaning in a PDF text layer.  Plain bullets with strong
 *      action verbs carry the same information and are fully parseable.
 *
 * TYPOGRAPHY (Canadian HR standards):
 *   Name:            20pt  Helvetica-Bold    (left-aligned)
 *   Contact line:    10pt  Helvetica         (City, Prov | Phone | Email | LinkedIn)
 *   Section headers: 12pt  Helvetica-Bold    ALL CAPS + horizontal rule
 *   Job title:       11pt  Helvetica-Bold
 *   Company/dates:   10pt  Helvetica / Helvetica-Oblique
 *   Body text:       10pt  Helvetica         (bullets, summary, education)
 *   Footer:           7pt  Helvetica         (page numbers)
 *
 * USAGE (from DocumentPreview.tsx):
 *   const { pdf }       = await import('@react-pdf/renderer');
 *   const { ResumePDF } = await import('./ResumePDF');
 *   const blob = await pdf(
 *     <ResumePDF data={resumeData as ResumeData} userEmail={email} />
 *   ).toBlob();
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import {
  Document,
  Font,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer';
import type { ResumeData, ExperienceEntry, EducationEntry } from '@/types';

// ─── Hyphenation suppression ──────────────────────────────────────────────────
// In @react-pdf/renderer v3, hyphenation is controlled via Font.registerHyphenationCallback.
// Returning the word as a single-element array tells the engine the word must
// never be split — preventing "Kubernetes" → "Kube-\nnetes" which breaks ATS
// keyword matching.  Registered once at module load time (not inside a component).
Font.registerHyphenationCallback((word) => [word]);

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ResumePDFProps {
  /** The structured resume data from the Zustand store. */
  data: Partial<ResumeData>;

  // ── Contact detail overrides ─────────────────────────────────────────────
  // These are collected by the interview agent but stored separately from
  // the core ResumeData structure.  All optional — the contact line is built
  // from whatever is available and simply omits missing items.

  /** Full legal name.  Falls back to targetTitle if absent. */
  name?:           string | null;
  /** Authenticated user email address (passed from auth session). */
  userEmail?:      string | null;
  /** City and province, e.g. "Winnipeg, MB" or "Toronto, ON". */
  city?:           string | null;
  /** Phone number, e.g. "(204) 555-0100". */
  phone?:          string | null;
  /** LinkedIn profile — short form preferred: "linkedin.com/in/username". */
  linkedIn?:       string | null;
  /** Professional certifications, e.g. ["PMP", "AWS Solutions Architect"]. */
  certifications?: string[];
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Convert ISO month string "2021-03" → "Mar 2021".
 * Falls back to the raw value unchanged if the format is not recognised.
 * This is intentional: if someone types "Spring 2020" it passes through as-is.
 */
function formatMonth(iso: string): string {
  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const m = iso.match(/^(\d{4})-(\d{2})$/);
  if (!m) return iso;
  const label = MONTHS[parseInt(m[2], 10) - 1];
  return label ? `${label} ${m[1]}` : iso;
}

/** Build the "Apr 2023 – Present" date range for one experience entry. */
function dateRange(entry: ExperienceEntry): string {
  const start = formatMonth(entry.startDate);
  const end   = entry.endDate ? formatMonth(entry.endDate) : 'Present';
  return `${start} \u2013 ${end}`;   // en-dash (–) is the Canadian style
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// All measurements are in PDF POINTS (pt).  1 inch = 72 pt.
// StyleSheet.create() validates the object at module load time.

const S = StyleSheet.create({

  // ── Page ───────────────────────────────────────────────────────────────────
  // LETTER (8.5 × 11 in) is the Canadian standard.  A4 is used in Europe.
  // paddingBottom is 0.75 in (54 pt) so the footer has room without eating body.
  page: {
    fontFamily:      'Helvetica',
    fontSize:        10,
    lineHeight:      1.45,
    color:           '#111111',
    backgroundColor: '#FFFFFF',
    paddingTop:      72,           // 1 inch
    paddingBottom:   54,           // 0.75 inch — footer clearance
    paddingLeft:     72,           // 1 inch
    paddingRight:    72,           // 1 inch
  },

  // ── Header block ───────────────────────────────────────────────────────────
  header: {
    marginBottom: 16,
  },

  // 20pt Bold — the name is the largest element on the page, full stop.
  name: {
    fontSize:    20,
    fontFamily:  'Helvetica-Bold',
    color:       '#000000',
    marginBottom: 4,
  },

  // Job title sits directly under the name in regular weight.
  // It is NOT part of the contact line — it anchors the reader's eye.
  headerTitle: {
    fontSize:     11,
    color:        '#333333',
    marginBottom: 4,
  },

  // Single-line contact string: "Winnipeg, MB | (204) 555-0100 | email@example.com"
  // Plain text — no flex tricks, no individual <Text> nodes per item.
  // ATS parsers read this as one contiguous string, which is correct.
  contactLine: {
    fontSize:   10,
    color:      '#444444',
    lineHeight: 1.3,
  },

  // ── Section heading ────────────────────────────────────────────────────────
  // 12pt, Bold, ALL CAPS per Canadian HR convention.
  // The horizontal rule below each heading is a 0.75pt grey line.
  sectionHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    marginBottom:  5,
    marginTop:     2,
  },
  sectionTitle: {
    fontSize:      12,
    fontFamily:    'Helvetica-Bold',
    color:         '#000000',
    textTransform: 'uppercase',
    marginRight:   8,
    // No letter-spacing — some ATS parsers treat letter-spaced text as individual
    // characters ("K U B E R N E T E S") rather than a keyword.
  },
  sectionRule: {
    flex:            1,
    height:          0.75,
    backgroundColor: '#BBBBBB',
  },

  // ── Section wrapper ────────────────────────────────────────────────────────
  section: {
    marginBottom: 12,
  },

  // ── Professional Summary ───────────────────────────────────────────────────
  summaryText: {
    fontSize:   10,
    lineHeight: 1.55,
    color:      '#111111',
  },

  // ── Work Experience ────────────────────────────────────────────────────────
  // wrap={false} on expEntry keeps the entire block on one page.
  // If a single job overflows a page on its own, react-pdf will start it on
  // a fresh page rather than splitting mid-block.
  expEntry: {
    marginBottom: 10,
  },
  expTitleRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    marginBottom:   1,
  },
  expTitle: {
    fontSize:   11,
    fontFamily: 'Helvetica-Bold',
    color:      '#000000',
    flex:       1,
  },
  expDate: {
    fontSize:   10,
    fontFamily: 'Helvetica-Oblique',
    color:      '#555555',
    flexShrink: 0,
    marginLeft: 8,
  },
  expCompany: {
    fontSize:     10,
    color:        '#333333',
    marginBottom: 4,
  },

  // ── Bullet points ──────────────────────────────────────────────────────────
  // Flex row keeps the "•" dot fixed-width and left-aligned even when the text
  // wraps to a second line — the continuation aligns under the first word,
  // not under the bullet character.
  bullet: {
    flexDirection: 'row',
    marginBottom:  2,
    paddingLeft:   6,
  },
  bulletDot: {
    fontSize:    10,
    color:       '#555555',
    marginRight: 6,
    lineHeight:  1.45,
    width:       8,
    flexShrink:  0,
  },
  bulletText: {
    fontSize:   10,
    color:      '#111111',
    lineHeight: 1.45,
    flex:       1,
  },

  // ── Skills ─────────────────────────────────────────────────────────────────
  // Plain comma-separated text — the most ATS-safe approach.
  // Bordered pills, flex-wrap chip arrays, and tag clouds are decorative HTML
  // conventions that have no equivalent in the PDF text layer.
  skillsText: {
    fontSize:   10,
    color:      '#111111',
    lineHeight: 1.5,
  },

  // ── Education ──────────────────────────────────────────────────────────────
  eduEntry: {
    marginBottom: 8,
  },
  eduTitleRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    marginBottom:   1,
  },
  eduDegree: {
    fontSize:   10,
    fontFamily: 'Helvetica-Bold',
    color:      '#000000',
    flex:       1,
  },
  eduYear: {
    fontSize:   10,
    fontFamily: 'Helvetica-Oblique',
    color:      '#555555',
    flexShrink: 0,
    marginLeft: 8,
  },
  eduInstitution: {
    fontSize: 10,
    color:    '#333333',
  },
  eduHonours: {
    fontSize:   10,
    fontFamily: 'Helvetica-Oblique',
    color:      '#555555',
    marginTop:  1,
  },

  // ── Certifications ─────────────────────────────────────────────────────────
  certText: {
    fontSize:   10,
    color:      '#111111',
    lineHeight: 1.5,
  },

  // ── Footer ─────────────────────────────────────────────────────────────────
  // `fixed` prop pins this View to the same position on every page.
  footer: {
    position:       'absolute',
    bottom:         24,
    left:           72,
    right:          72,
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
  },
  footerLeft: {
    fontSize: 7,
    color:    '#CCCCCC',
  },
  footerRight: {
    fontSize: 7,
    color:    '#CCCCCC',
  },
});

// ─── Sub-components ───────────────────────────────────────────────────────────
// Each sub-component is a pure function (no hooks) — safe to call inside the
// react-pdf render tree which does not support the full React hook surface.

/**
 * Section heading: 12pt Bold ALL CAPS label + full-width horizontal rule.
 * The rule is a zero-height View with a background colour — react-pdf's
 * equivalent of `border-bottom` (which is not supported as a style prop).
 */
const SectionHead: React.FC<{ label: string }> = ({ label }) => (
  <View style={S.sectionHeader}>
    <Text style={S.sectionTitle}>{label}</Text>
    <View style={S.sectionRule} />
  </View>
);

/**
 * A single bullet-point line.
 * The "•" dot has a fixed 8pt width so all continuation lines align cleanly.
 * Both dot and text inherit 10pt / 1.45 line-height from their styles.
 */
const Bullet: React.FC<{ text: string }> = ({ text }) => (
  <View style={S.bullet}>
    <Text style={S.bulletDot}>{'\u2022'}</Text>
    <Text style={S.bulletText}>{text}</Text>
  </View>
);

/**
 * One complete work experience block.
 *
 * wrap={false} instructs react-pdf to keep this entire View on one page.
 * If there is not enough room on the current page, the renderer starts a new
 * page before this block rather than splitting it mid-way.
 *
 * Metrics are rendered as regular bullet points — they carry the same
 * information as coloured badges but are fully parseable by ATS text extraction.
 */
const ExperienceBlock: React.FC<{ entry: ExperienceEntry }> = ({ entry }) => (
  <View style={S.expEntry} wrap={false}>
    {/* Title (bold) and date range (italic) on the same line, right-aligned */}
    <View style={S.expTitleRow}>
      <Text style={S.expTitle}>{entry.title}</Text>
      <Text style={S.expDate}>{dateRange(entry)}</Text>
    </View>

    {/* Company on its own line — recruiters read Company before anything else */}
    <Text style={S.expCompany}>{entry.company}</Text>

    {/* Responsibilities — action-verb bullets */}
    {entry.responsibilities.map((r, i) => (
      <Bullet key={`r-${i}`} text={r} />
    ))}

    {/* Quantified metrics — rendered as plain bullets, not coloured badges.
        Keeps them in the text layer and ATS-parseable. */}
    {entry.metrics.map((m, i) => (
      <Bullet key={`m-${i}`} text={m} />
    ))}
  </View>
);

/**
 * One education block.
 * Degree + field on the left, graduation year on the right.
 * Honours (Dean's List, Summa Cum Laude) on a separate italic line.
 */
const EducationBlock: React.FC<{ entry: EducationEntry }> = ({ entry }) => (
  <View style={S.eduEntry} wrap={false}>
    <View style={S.eduTitleRow}>
      <Text style={S.eduDegree}>
        {entry.degree}{entry.field ? `, ${entry.field}` : ''}
      </Text>
      <Text style={S.eduYear}>{entry.graduationYear}</Text>
    </View>
    <Text style={S.eduInstitution}>{entry.institution}</Text>
    {entry.honours ? (
      <Text style={S.eduHonours}>{entry.honours}</Text>
    ) : null}
  </View>
);

// ─── Contact line builder ──────────────────────────────────────────────────────
/**
 * Builds a single plain-text contact line from whatever contact fields
 * are available.  Items are joined with " | " separators.
 *
 * The separator " | " is the Canadian HR standard:
 *   Winnipeg, MB | (204) 555-0100 | jane@example.com | linkedin.com/in/jane
 *
 * We use " | " (pipe with spaces) rather than " · " (interpunct) because
 * some ATS parsers use the pipe as a field delimiter — seeing it in the
 * contact line tells the parser that these are distinct data items.
 */
function buildContactLine(
  city?:      string | null,
  phone?:     string | null,
  email?:     string | null,
  linkedIn?:  string | null,
): string {
  return [city, phone, email, linkedIn]
    .filter((v): v is string => Boolean(v?.trim()))
    .join(' | ');
}

// ─── Main Document ─────────────────────────────────────────────────────────────

/**
 * The root PDF document component.
 *
 * Rendered client-side via:
 *   pdf(<ResumePDF data={resumeData} userEmail={email} />).toBlob()
 *
 * The `data` prop is `Partial<ResumeData>` because the Zustand store
 * initialises with an empty object; every field access uses optional chaining
 * or nullish coalescing to prevent runtime errors on missing fields.
 */
export const ResumePDF: React.FC<ResumePDFProps> = ({
  data,
  name,
  userEmail,
  city,
  phone,
  linkedIn,
  certifications,
}) => {
  const experiences = data.experiences ?? [];
  const skills      = data.skills      ?? [];
  const education   = data.education   ?? [];
  const certs       = certifications   ?? [];

  // Resolve the display name:
  //   1. Explicit `name` prop (from a future "edit name" UI)
  //   2. targetTitle as a reasonable fallback (visible and scannable)
  //   3. Hard fallback "Your Name" so the PDF is never blank
  const displayName = (name?.trim() || data.targetTitle?.trim() || 'Your Name');

  // Build the single-line contact string
  const contactLine = buildContactLine(city, phone, userEmail, linkedIn);

  // Build comma-separated skills string — one plain sentence, fully ATS-parseable
  const skillsLine = skills.join(', ');

  // Build comma-separated certifications string
  const certsLine = certs.join(', ');

  return (
    <Document
      // PDF metadata — used by Acrobat, browsers, and some ATS for pre-indexing
      title={`${displayName} — Resume`}
      author={displayName}
      subject={data.targetTitle ? `${data.targetTitle} Resume` : 'Professional Resume'}
      keywords={skills.slice(0, 10).join(', ')}
      creator="JobifAI (cv.wealthifai.xyz)"
      producer="@react-pdf/renderer"
    >
      <Page size="LETTER" style={S.page}>

        {/* ══ HEADER: Name + Title + Contact ══════════════════════════════ */}
        <View style={S.header}>

          {/* Full name — 20pt Bold, the largest element on the page */}
          <Text style={S.name}>{displayName}</Text>

          {/* Target job title — anchors the reader's expectation immediately */}
          {data.targetTitle ? (
            <Text style={S.headerTitle}>{data.targetTitle}</Text>
          ) : null}

          {/* Single contact line — all items separated by " | " */}
          {contactLine ? (
            <Text style={S.contactLine}>{contactLine}</Text>
          ) : null}

        </View>

        {/* ══ PROFESSIONAL SUMMARY ════════════════════════════════════════ */}
        {data.summary?.trim() ? (
          <View style={S.section}>
            <SectionHead label="Professional Summary" />
            <Text style={S.summaryText}>{data.summary.trim()}</Text>
          </View>
        ) : null}

        {/* ══ WORK EXPERIENCE ═════════════════════════════════════════════ */}
        {experiences.length > 0 ? (
          <View style={S.section}>
            <SectionHead label="Work Experience" />
            {experiences.map((exp) => (
              <ExperienceBlock key={exp.id} entry={exp} />
            ))}
          </View>
        ) : null}

        {/* ══ EDUCATION ═══════════════════════════════════════════════════ */}
        {education.length > 0 ? (
          <View style={S.section}>
            <SectionHead label="Education" />
            {education.map((edu) => (
              <EducationBlock key={edu.id} entry={edu} />
            ))}
          </View>
        ) : null}

        {/* ══ SKILLS ══════════════════════════════════════════════════════ */}
        {/* Comma-separated plain text — the most ATS-safe skills format.
            Bordered pills, chip arrays, and tag clouds are HTML/CSS concepts
            that have no semantic equivalent in a PDF text layer. */}
        {skillsLine ? (
          <View style={S.section}>
            <SectionHead label="Skills" />
            <Text style={S.skillsText}>{skillsLine}</Text>
          </View>
        ) : null}

        {/* ══ CERTIFICATIONS ══════════════════════════════════════════════ */}
        {/* Only rendered when certifications are provided. */}
        {certsLine ? (
          <View style={S.section}>
            <SectionHead label="Certifications" />
            <Text style={S.certText}>{certsLine}</Text>
          </View>
        ) : null}

        {/* ══ FOOTER: attribution + page number ═══════════════════════════ */}
        {/* `fixed` renders this View at the same absolute position on every page */}
        <View style={S.footer} fixed>
          <Text style={S.footerLeft}>
            Generated by JobifAI · ATS-Optimised · Canadian HR Standards
          </Text>
          <Text
            style={S.footerRight}
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>

      </Page>
    </Document>
  );
};
