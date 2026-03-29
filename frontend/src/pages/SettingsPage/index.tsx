/**
 * SettingsPage — Route: /settings
 * ─────────────────────────────────────────────────────────────────────────────
 * PRD §6 — Settings, Privacy & Localization
 *
 * Required sections (Phase 2 implementation):
 *
 *   §6.1 — BYOK (Bring Your Own Key)
 *     Gemini API key field. Stored in useSessionStore.byokApiKey — NEVER in DB.
 *     Key lives only in Zustand for the session lifetime.
 *     Persistent BYOK storage (encrypted in localStorage) is the UX goal.
 *     When set, bypasses all server-side quota (PRD §1.4).
 *
 *   §6.2 — Language Preferences
 *     User interface language (useSessionStore.userLang)
 *     Resume language (useSessionStore.resumeLang)
 *     Drives AI prompt language and score label copy.
 *
 *   §6.3 — Data Privacy
 *     [Clear my data] → DELETE /api/user/data → clears DB row, Zustand stores
 *     [Delete account] → DELETE /api/user/account (future)
 *
 *   §6.4 — Account / Subscription
 *     Plan status (free / pass / monthly) from useBillingStore
 *     [Manage billing] → Stripe Customer Portal link
 * ─────────────────────────────────────────────────────────────────────────────
 */

export default function SettingsPage() {
  return (
    <main>
      {/* TODO Phase 2: implement full settings per PRD §6 */}
      <h1>SettingsPage — placeholder</h1>
    </main>
  );
}
