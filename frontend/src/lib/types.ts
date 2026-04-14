// ─────────────────────────────────────────────────────────────────────────────
// JobifAI — Core Data Models
// FRONTEND_RULES.md Rule 3: types live here, imported by parser + store + UI.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumeBullet {
  /** Stable unique id — e.g. "exp-0-b2" */
  id: string;
  /** Cleaned bullet text, leading symbols stripped */
  text: string;
  /** true for company/role/date/location header lines inside a section */
  isMeta: boolean;
}

export interface ResumeSection {
  /** Stable unique id — e.g. "s0", "s1" */
  id: string;
  /** Normalised title — e.g. "Summary", "Experience", "Education" */
  title: string;
  /**
   * true ONLY for sections the user can ask the AI to rewrite bullets in.
   * Currently: Summary, Experience, Projects.
   */
  isInteractive: boolean;
  bullets: ResumeBullet[];
}
