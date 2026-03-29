/**
 * LandingPage — Route: /
 * ─────────────────────────────────────────────────────────────────────────────
 * PRD §2 — Soft-Gate Onboarding
 *
 * Purpose: Convert anonymous visitors into engaged users who have already
 * received computed value (their ATS score) before creating an account.
 *
 * Anti-patterns (DO NOT implement these):
 *   ✗ Auth wall before showing the tool
 *   ✗ Marketing copy as the primary content
 *   ✗ Keyword list or tips without a score
 *
 * Required UI sections (Phase 2 implementation):
 *   1. Navbar: logo + [Sign In] + [Pricing]
 *   2. Hero: "Does your resume beat the bot?" + sub "Find out in 10s. No login."
 *   3. Two-column upload zone: CV drop (PDF/DOCX) + JD textarea (400 char min)
 *   4. Primary CTA: [SCAN MY RESUME]
 *   5. ATS Score Panel (post-scan, same page): MacMascot + score dial + top 3 gaps
 *   6. Soft-gate CTAs: [FIX MY RESUME] [START INTERVIEW PREP]
 *      → opens AuthModal in-place (no route change) if anon
 *      → routes to /workspace?mode=resume|interview if already authed
 *
 * State written to stores on this page:
 *   useDocumentStore.pendingCvFile  — raw File from <input>
 *   useDocumentStore.pendingJdText  — raw JD paste
 *   useDocumentStore.atsScore       — result from POST /api/ats-score
 *   useDocumentStore.atsGaps        — top 3 gaps for display
 *   useSessionStore.hardcorePending — set true when score < 40 (PRD §2.6)
 *   useSessionStore.macState        — driven by score range (PRD §2.7)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export default function LandingPage() {
  return (
    <main>
      {/* TODO Phase 2: implement full landing page per PRD §2 */}
      <h1>LandingPage — placeholder</h1>
    </main>
  );
}
