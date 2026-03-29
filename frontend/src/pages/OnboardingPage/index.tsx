/**
 * OnboardingPage — Route: /onboarding
 * ─────────────────────────────────────────────────────────────────────────────
 * Post-auth context capture placeholder.
 *
 * The primary onboarding experience (CV + JD upload → ATS score) lives on the
 * landing page (/) and is intentionally anonymous-first (PRD §2).
 *
 * This route is reserved for:
 *   - Post-auth profile setup (display name, target role preferences)
 *   - Re-onboarding after account deletion
 *   - A/B test variant that requires a dedicated onboarding route
 *
 * Currently: users flow from / → auth modal → /dashboard directly.
 * ProtectedRoute redirects here will require an explicit useNavigate call.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export default function OnboardingPage() {
  return (
    <main>
      {/* TODO Phase 2: implement onboarding flow if needed */}
      <h1>OnboardingPage — placeholder</h1>
    </main>
  );
}
