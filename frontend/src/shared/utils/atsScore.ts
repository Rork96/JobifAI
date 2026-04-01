/**
 * shared/utils/atsScore.ts — Client-side ATS keyword overlap score
 * ─────────────────────────────────────────────────────────────────────────────
 * Computes a 0–100 score based on what fraction of meaningful JD keywords
 * appear in the resume text. This is a fast, local estimate used for live
 * feedback in the workspace — the authoritative score comes from the backend's
 * /api/ats-score endpoint (cosine-similarity, semantic embedding).
 *
 * Algorithm:
 *   1. Extract unique keywords from the job description (length > 3, not a
 *      stop word, alpha-numeric only).
 *   2. Count how many appear in the resume text (case-insensitive).
 *   3. score = (matches / total_jd_keywords) × 100, clamped 0–100.
 *
 * Use case: DashboardPage and WorkspacePage can show a live preview score
 * while the backend call is in flight, giving the user immediate feedback
 * when they accept a diff.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const STOP_WORDS = new Set([
  'the','and','for','are','with','have','that','this','from','not','but',
  'was','were','been','will','your','their','about','which','when','what',
  'also','into','more','than','they','some','other','such','only','each',
  'both','its','our','you','who','may','can','all','any','has','had',
  'one','two','three','four','five','very','just','over','under','most',
  'well','able','here','how','its','new','use','used','using','work',
]);

/**
 * Extract meaningful keyword tokens from a text string.
 * Returns a de-duplicated array of lowercase tokens.
 */
function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s+#]/g, ' ')   // keep + and # (e.g. C++, C#)
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));

  return [...new Set(tokens)];
}

/**
 * Calculate a simple keyword-overlap ATS score.
 *
 * @param resumeText     Plain text of the resume (from /api/upload-resume)
 * @param jobDescription Plain text of the job posting
 * @returns              Integer 0–100
 */
export function calculateAtsScore(resumeText: string, jobDescription: string): number {
  if (!resumeText?.trim() || !jobDescription?.trim()) return 0;

  const jdKeywords = extractKeywords(jobDescription);
  if (jdKeywords.length === 0) return 0;

  const resumeLower = resumeText.toLowerCase();

  let matches = 0;
  for (const kw of jdKeywords) {
    if (resumeLower.includes(kw)) matches++;
  }

  return Math.round(Math.min(100, (matches / jdKeywords.length) * 100));
}

/**
 * Return a list of JD keywords NOT found in the resume.
 * Used for the missing-keywords chip list in the coaching panel.
 */
export function getMissingKeywords(resumeText: string, jobDescription: string): string[] {
  if (!resumeText?.trim() || !jobDescription?.trim()) return [];

  const jdKeywords = extractKeywords(jobDescription);
  const resumeLower = resumeText.toLowerCase();

  return jdKeywords
    .filter(kw => !resumeLower.includes(kw))
    .slice(0, 12);   // cap at 12 for the UI
}
