/**
 * components/document/ResumePDF.tsx — Standard Canadian ATS-Compliant PDF
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURAL BOUNDARY
 * ─────────────────────────────────────────────────────────────────────────────
 * This is a PURE PRESENTER component. It receives `data: Partial<ResumeData>`
 * from the caller (DocumentPreview or a PDFDownloadLink wrapper) and renders
 * a PDF document. It has no knowledge of Zustand, routing, or API calls.
 *
 * Callers pull state from the store themselves:
 *   const resumeData = useAppStore(s => s.resumeData);
 *   <PDFDownloadLink document={<ResumePDF data={resumeData} />} ...>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATE "BORING" DESIGN — WHY IT MATTERS FOR ATS
 * ─────────────────────────────────────────────────────────────────────────────
 * Modern ATS systems (Taleo, Workday, Greenhouse, iCIMS) extract resume text
 * by reading the raw PDF text layer — they do NOT render the visual layout.
 * Anything that looks decorative but breaks the text layer kills the candidacy.
 *
 * Rules enforced here:
 *
 *   ✓  Standard PDF built-in fonts only (Helvetica / Times-Roman).
 *      Custom fonts embed binary blobs and trip ATS binary-content filters.
 *      PDF built-ins are guaranteed in every reader since 1984, zero embedding.
 *
 *   ✓  Hyphenation disabled globally via Font.registerHyphenationCallback.
 *      A hyphenated "Kube-\nnetes" is an ATS keyword miss. No exceptions.
 *
 *   ✓  Single-column layout. Multi-column PDFs are read left-to-right by ATS
 *      parsers, scrambling the content (company name mixes with job title, etc).
 *
 *   ✓  Pure text bullets using Unicode "•" (U+2022) prefix strings.
 *      PDF has no native list primitives; some ATS parsers only handle plain text.
 *
 *   ✓  Skills as a flat comma-separated sentence, not bordered pills or chips.
 *      Pill/chip elements are CSS/HTML conventions with no PDF text equivalent.
 *
 *   ✓  Near-black (#111111) on white (#FFFFFF). Coloured boxes and gradients
 *      cause OCR errors on scanned versions and confuse some ATS optical readers.
 *
 *   ✓  Dates as "MMM YYYY" — unambiguous across DD/MM and MM/DD conventions.
 *
 *   ✓  wrap={false} on experience entries — never splits one job across pages.
 *
 *   ✓  PDF metadata (title, author, subject, keywords) populated for pre-indexing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TYPOGRAPHY (exact spec)
 * ─────────────────────────────────────────────────────────────────────────────
 *   Name:            18pt  Helvetica-Bold    (per Canadian HR standard spec)
 *   Target title:    11pt  Helvetica         (directly below name)
 *   Contact line:    10pt  Helvetica         (City, Prov | Phone | Email | LinkedIn)
 *   Section headers: 12pt  Helvetica-Bold    ALL CAPS + full-width hairline rule
 *   Job title:       11pt  Helvetica-Bold
 *   Company / dates: 10pt  Helvetica / Helvetica-Oblique
 *   Body text:       10pt  Helvetica
 *   Footer:           7pt  Helvetica
 *
 * MARGINS: 1 inch (72pt) on all four sides. LETTER page (8.5 × 11 in).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React                from 'react';
import {
  Document,
  Font,
  Page,
  Text,
  View,
  StyleSheet,
}                           from '@react-pdf/renderer';
import type {
  ResumeData,
  ExperienceEntry,
  EducationEntry,
}                           from '@/types';

// ─── Hyphenation suppression ──────────────────────────────────────────────────
// Registered once at module load (not inside a component — safe for react-pdf).
// Returning the word as a single-element array tells the layout engine:
// "never break this word". Prevents "Kubernetes" → "Kube-\nnetes".
Font.registerHyphenationCallback((word) => [word]);

// ─────────────────────────────────────────────────────────────────────────────
// PROPS
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumePDFProps {
  /** Structured resume data — pulled from useAppStore(s => s.resumeData) by the caller. */
  data: Partial<ResumeData>;

  // ── Optional contact fields ──────────────────────────────────────────────
  // Collected during the interview and passed in by the caller.
  // The contact line is built from whatever is provided; missing items are
  // simply omitted rather than showing "null" or an empty slot.

  /** Full legal name. Falls back to targetTitle, then "Your Name". */
  name?:           string | null;
  /** Authenticated user email (from Supabase auth session). */
  userEmail?:      string | null;
  /** "City, Province" — e.g. "Toronto, ON". */
  city?:           string | null;
  /** Phone number — e.g. "(416) 555-0100". */
  phone?:          string | null;
  /** LinkedIn URL — short form: "linkedin.com/in/username". */
  linkedIn?:       string | null;
  /** Professional certifications — rendered as a comma-separated line. */
  certifications?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "2021-03" → "Mar 2021"
 * Passes through unrecognised strings unchanged (e.g. "Spring 2020").
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

/** "Apr 2023 – Present"  (en-dash is the Canadian date-range standard) */
function dateRange(entry: ExperienceEntry): string {
  const start = formatMonth(entry.startDate ?? '');
  const end   = entry.endDate ? formatMonth(entry.endDate) : 'Present';
  return `${start} \u2013 ${end}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT LINE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the single-line contact string.
 * Items joined with " | " — the Canadian HR field-separator convention.
 * Missing / empty items are silently excluded.
 *
 * Example: "Winnipeg, MB | (204) 555-0100 | jane@example.com | linkedin.com/in/jane"
 */
function buildContactLine(
  city?:     string | null,
  phone?:    string | null,
  email?:    string | null,
  linkedIn?: string | null,
): string {
  return [city, phone, email, linkedIn]
    .filter((v): v is string => Boolean(v?.trim()))
    .join(' | ');
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLESHEET
// All measurements in PDF points (pt). 1 inch = 72 pt.
// ─────────────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({

  // ── Page ───────────────────────────────────────────────────────────────────
  // LETTER (8.5 × 11 in) — Canadian standard.
  // All four paddings = 72pt (1 inch) per spec.
  page: {
    fontFamily:      'Helvetica',
    fontSize:        10,
    lineHeight:      1.45,
    color:           '#111111',
    backgroundColor: '#FFFFFF',
    paddingTop:      72,   // 1 inch
    paddingBottom:   72,   // 1 inch  ← spec requires 1 in on ALL sides
    paddingLeft:     72,   // 1 inch
    paddingRight:    72,   // 1 inch
  },

  // ── Header block ───────────────────────────────────────────────────────────
  header: {
    marginBottom: 14,
  },

  // 18pt Bold — spec-exact. The candidate's name is the single most important
  // element on the page for ATS pre-scoring.
  name: {
    fontSize:     18,               // ← spec: 18pt (not 20pt)
    fontFamily:   'Helvetica-Bold',
    color:        '#000000',
    marginBottom: 3,
  },

  // Target job title — 11pt regular weight, directly below name.
  // Anchors the reader's expectation before they scan the body.
  headerTitle: {
    fontSize:     11,
    color:        '#333333',
    marginBottom: 3,
  },

  // Single-line contact string rendered as one <Text> node.
  // One contiguous string = one parseable data item in the ATS text layer.
  contactLine: {
    fontSize:   10,
    color:      '#444444',
    lineHeight: 1.3,
  },

  // ── Section heading ────────────────────────────────────────────────────────
  // 12pt Bold ALL CAPS + full-width 0.75pt hairline rule.
  // The rule is a zero-height View with backgroundColor — react-pdf's
  // border-bottom equivalent (border-bottom is not a valid PDF style).
  sectionHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    marginBottom:  5,
    marginTop:     12,
  },
  sectionTitle: {
    fontSize:      12,               // spec: 12pt
    fontFamily:    'Helvetica-Bold', // spec: BOLD
    color:         '#000000',
    textTransform: 'uppercase',      // spec: ALL CAPS
    marginRight:   8,
    // No letterSpacing — spaced characters ("K U B E R N E T E S") break ATS keyword matching
  },
  sectionRule: {
    flex:            1,
    height:          0.75,           // hairline — purely visual, not a ghost gap
    backgroundColor: '#CCCCCC',
  },

  // ── Section wrapper ────────────────────────────────────────────────────────
  section: {
    marginBottom: 0,  // spacing handled by sectionHeader marginTop instead
  },

  // ── Professional Summary ───────────────────────────────────────────────────
  summaryText: {
    fontSize:   10,
    lineHeight: 1.55,
    color:      '#111111',
  },

  // ── Work Experience ────────────────────────────────────────────────────────
  expEntry: {
    marginBottom: 9,
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
  // Flex row: fixed-width "•" dot + flex text block.
  // Continuation lines align under the first word of the text, not the dot.
  bullet: {
    flexDirection: 'row',
    marginBottom:  2,
    paddingLeft:   6,
  },
  bulletDot: {
    fontSize:    10,
    color:       '#555555',
    marginRight: 5,
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
  // Plain comma-separated sentence — the spec-required format.
  // No pill badges, no tag clouds, no flex-wrap chip arrays.
  skillsText: {
    fontSize:   10,
    color:      '#111111',
    lineHeight: 1.5,
  },

  // ── Education ──────────────────────────────────────────────────────────────
  eduEntry: {
    marginBottom: 7,
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
  // `fixed` prop renders this at the same absolute position on every page.
  // bottom: 20 sits inside the 72pt bottom margin without overlapping body text.
  footer: {
    position:       'absolute',
    bottom:         20,
    left:           72,
    right:          72,
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
  },
  footerText: {
    fontSize: 7,
    color:    '#CCCCCC',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// Pure functions — no hooks. react-pdf's render tree does not support hooks.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Section heading: 12pt Bold ALL CAPS label + full-width hairline rule.
 */
const SectionHead: React.FC<{ label: string }> = ({ label }) => (
  <View style={S.sectionHeader}>
    <Text style={S.sectionTitle}>{label}</Text>
    <View style={S.sectionRule} />
  </View>
);

/**
 * A single bullet-point line.
 * Fixed-width dot ensures continuation lines align under the text, not the dot.
 */
const Bullet: React.FC<{ text: string }> = ({ text }) => (
  <View style={S.bullet}>
    <Text style={S.bulletDot}>{'\u2022'}</Text>
    <Text style={S.bulletText}>{text}</Text>
  </View>
);

/**
 * One work-experience block.
 *
 * wrap={false} — keeps Title + Company + all bullets together on one page.
 * If the block doesn't fit on the current page, react-pdf starts a new page
 * before it rather than splitting the entry mid-way.
 *
 * Metrics are rendered as regular bullets — same information as coloured badges
 * but fully present in the PDF text layer for ATS parsing.
 */
const ExperienceBlock: React.FC<{ entry: ExperienceEntry }> = ({ entry }) => {
  // Combine responsibilities and metrics into a single bullet list.
  // Metrics are quantified wins — they belong in the same visual stream as
  // responsibilities, not in a separate coloured badge section.
  const allBullets = [
    ...(entry.responsibilities ?? []),
    ...(entry.metrics ?? []),
  ].filter(Boolean);

  return (
    <View style={S.expEntry} wrap={false}>
      <View style={S.expTitleRow}>
        <Text style={S.expTitle}>{entry.title}</Text>
        <Text style={S.expDate}>{dateRange(entry)}</Text>
      </View>
      <Text style={S.expCompany}>{entry.company}</Text>
      {allBullets.map((line, i) => (
        <Bullet key={`b-${i}`} text={line} />
      ))}
    </View>
  );
};

/**
 * One education block.
 * Degree + field on the left, graduation year right-aligned.
 * Honours on a separate italic line when present.
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
    {entry.honours?.trim() ? (
      <Text style={S.eduHonours}>{entry.honours}</Text>
    ) : null}
  </View>
);

// ─────────────────────────────────────────────────────────────────────────────
// ROOT DOCUMENT COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ResumePDF — the pure PDF presenter.
 *
 * Caller is responsible for reading Zustand state and passing it as props:
 *
 *   // Inside a component that has access to the store:
 *   const resumeData = useAppStore(s => s.resumeData);
 *   const user       = useAppStore(s => s.user);
 *
 *   // For react-pdf PDFDownloadLink (renders inside worker thread):
 *   <PDFDownloadLink
 *     document={<ResumePDF data={resumeData} userEmail={user?.email} />}
 *     fileName="resume.pdf"
 *   >
 *     {({ loading }) => loading ? 'Preparing…' : 'Download PDF'}
 *   </PDFDownloadLink>
 *
 *   // For programmatic blob generation (e.g. preview iframe):
 *   const { pdf } = await import('@react-pdf/renderer');
 *   const blob    = await pdf(<ResumePDF data={resumeData} />).toBlob();
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
  const experiences = data.experiences  ?? [];
  const skills      = data.skills       ?? [];
  const education   = data.education    ?? [];
  const certs       = certifications    ?? [];

  // Display name resolution order:
  //   1. `name` prop (explicit override — future "edit name" UI)
  //   2. targetTitle (visible, scannable fallback)
  //   3. Hard fallback — PDF is never rendered with a blank name
  const displayName = name?.trim() || data.targetTitle?.trim() || 'Your Name';

  // Contact line — single plain-text string, items separated by " | "
  const contactLine = buildContactLine(city, phone, userEmail, linkedIn);

  // Skills — comma-separated flat sentence. No pill badges, no flex wrapping.
  const skillsLine  = skills.filter(Boolean).join(', ');

  // Certifications — comma-separated flat sentence.
  const certsLine   = certs.filter(Boolean).join(', ');

  return (
    <Document
      // PDF metadata — used by Acrobat, browser PDF viewers, and some ATS systems
      // for lightweight pre-indexing before the full text extraction pass.
      title={`${displayName} — Resume`}
      author={displayName}
      subject={data.targetTitle ? `${data.targetTitle} Resume` : 'Professional Resume'}
      keywords={skills.slice(0, 10).join(', ')}
      creator="JobifAI (cv.wealthifai.xyz)"
      producer="@react-pdf/renderer"
    >
      <Page size="LETTER" style={S.page}>

        {/* ══ HEADER ══════════════════════════════════════════════════════════
            Name (18pt Bold) → Target Title (11pt) → Contact line (10pt)
            The visual hierarchy mirrors how a recruiter scans the top third. */}
        <View style={S.header}>
          <Text style={S.name}>{displayName}</Text>

          {data.targetTitle?.trim() ? (
            <Text style={S.headerTitle}>{data.targetTitle.trim()}</Text>
          ) : null}

          {contactLine ? (
            <Text style={S.contactLine}>{contactLine}</Text>
          ) : null}
        </View>

        {/* ══ PROFESSIONAL SUMMARY ════════════════════════════════════════════
            2–3 sentence narrative. Rendered only when present — no placeholder. */}
        {data.summary?.trim() ? (
          <View style={S.section}>
            <SectionHead label="Professional Summary" />
            <Text style={S.summaryText}>{data.summary.trim()}</Text>
          </View>
        ) : null}

        {/* ══ WORK EXPERIENCE ═════════════════════════════════════════════════
            Reverse chronological — the AI interview collects entries in order.
            wrap={false} per entry prevents splitting a job block across pages. */}
        {experiences.length > 0 ? (
          <View style={S.section}>
            <SectionHead label="Work Experience" />
            {experiences.map((exp) => (
              <ExperienceBlock key={exp.id} entry={exp} />
            ))}
          </View>
        ) : null}

        {/* ══ EDUCATION ═══════════════════════════════════════════════════════
            Reverse chronological. Degree, field, institution, graduation year. */}
        {education.length > 0 ? (
          <View style={S.section}>
            <SectionHead label="Education" />
            {education.map((edu) => (
              <EducationBlock key={edu.id} entry={edu} />
            ))}
          </View>
        ) : null}

        {/* ══ SKILLS ══════════════════════════════════════════════════════════
            Flat comma-separated sentence — the most ATS-parseable skills format.
            EXCLUSION: no bordered pills, no flex-wrap chips, no tag clouds.
            Those are HTML/CSS concepts with no PDF text-layer equivalent. */}
        {skillsLine ? (
          <View style={S.section}>
            <SectionHead label="Skills" />
            <Text style={S.skillsText}>{skillsLine}</Text>
          </View>
        ) : null}

        {/* ══ CERTIFICATIONS ══════════════════════════════════════════════════
            Only rendered when certifications are provided by the caller.
            Comma-separated — same ATS-safe pattern as skills. */}
        {certsLine ? (
          <View style={S.section}>
            <SectionHead label="Certifications" />
            <Text style={S.certText}>{certsLine}</Text>
          </View>
        ) : null}

        {/* ══ FOOTER ══════════════════════════════════════════════════════════
            `fixed` pins this to the same absolute position on every page.
            7pt light grey — readable but visually subordinate to body content.
            EXCLUSION: no dashed lines, no ghost gaps, no UI decoration. */}
        <View style={S.footer} fixed>
          <Text style={S.footerText}>
            Generated by JobifAI · ATS-Optimised · Canadian HR Standards
          </Text>
          <Text
            style={S.footerText}
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>

      </Page>
    </Document>
  );
};
