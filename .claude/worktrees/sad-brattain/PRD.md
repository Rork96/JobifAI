# JobifAI — Product Requirements Document (v2)

> **Status:** Approved for v2 build
> **Owner:** Head of Product
> **Technical Foundation:** DEVELOPER_HANDBOOK.md (approved)
> **Anti-Pattern:** No forced linear wizard. No disconnected keyword lists. No auth walls before value.

---

## Table of Contents

1. [Product Vision & Core Loop](#1-product-vision--core-loop)
2. [Soft-Gate Onboarding — Route: `/`](#2-soft-gate-onboarding--route-)
3. [Central Hub — Route: `/dashboard`](#3-central-hub--route-dashboard)
4. [Sandwich UI Protocol — Route: `/workspace`](#4-sandwich-ui-protocol--route-workspace)
5. [Hardcore Mentor Mode](#5-hardcore-mentor-mode)
6. [Settings, Privacy & Localization — Route: `/settings`](#6-settings-privacy--localization--route-settings)

---

## 1. Product Vision & Core Loop

### 1.1 Value Proposition

JobifAI is a **surgical career co-pilot**, not a resume builder. The product's single measurable outcome is:

> **Increase the user's ATS pass rate for a specific job, in a single session, without friction.**

The product never asks users to "build" anything from scratch. It takes what they already have (CV + JD) and makes it better — faster than any human reviewer. Success is a number going up on screen before the user reaches for their wallet.

### 1.2 Hub-and-Spoke Architecture

```
          ┌──────────────────────────────────────────────────────┐
          │                   /dashboard  (HUB)                  │
          │                                                      │
          │   ┌──────────┐   ┌──────────────┐   ┌────────────┐  │
          │   │  Resume  │   │   Interview  │   │   Cover    │  │
          │   │   Fix    │   │    Coach     │   │   Letter   │  │
          │   │ /wspace  │   │  /workspace  │   │ /workspace │  │
          │   └──────────┘   └──────────────┘   └────────────┘  │
          │                       SPOKES                         │
          └──────────────────────────────────────────────────────┘
```

**Rule:** The Hub (`/dashboard`) always persists the user's CV + JD context. Spokes (`/workspace`) inherit that context. A user **never re-uploads a document** mid-session. Navigating back to `/dashboard` never resets context — `useDocumentStore` survives route changes.

### 1.3 Core Loop

```
UPLOAD (anon)  →  ATS SCORE (anon)  →  BRUTAL FEEDBACK (anon)
      ↓
[Soft Gate: "Fix Resume" / "Start Interview"]
      ↓
AUTH MODAL (non-blocking, not a new route)
      ↓
/dashboard (HUB — context auto-hydrated from pending store)
      ↓
WORKSPACE (surgical edit / coaching)
      ↓
EXPORT / ITERATE
```

**Critical constraint:** The user sees real, computed value (their ATS score) **before** any auth prompt. The auth gate lives at the moment of intent to act — not before it.

### 1.4 Freemium Limits (server-side authoritative)

| Action | Free Tier | Premium |
|---|---|---|
| ATS Score | Unlimited | Unlimited |
| Magic Rewrite | 3 total | Unlimited |
| Interview Session | 1 total | Unlimited |
| Cover Letter Draft | — | Unlimited |

Frontend counters in `useBillingStore` are display-only. `GET /api/user/me` is the authoritative source. The `check_action_limit` FastAPI dependency is the enforcement gate — it cannot be bypassed by any client-side state.

**BYOK Override:** Users supplying a Gemini API key in `useChatStore.byokApiKey` bypass all server-side quota. The key is never persisted to DB, never sent to Supabase, lives only in the Zustand store for the session lifetime. Persistent BYOK storage is managed in `/settings` (see §6.2).

---

## 2. Soft-Gate Onboarding — Route: `/`

### 2.1 Purpose

Convert an anonymous visitor into an engaged user who has **already received computed value** before creating an account. The `/` route is a functional tool, not a marketing page. The auth wall appears only at the moment the user decides to act on the result they've seen.

### 2.2 Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  NAVBAR:  JobifAI logo  ·  [Sign In]  ·  [Pricing]     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  HERO HEADLINE:  "Does your resume beat the bot?"       │
│  SUB:  "Find out in 10 seconds. No login."              │
│                                                         │
│  ┌───────────────────┐  ┌────────────────────────────┐  │
│  │  DROP YOUR CV     │  │  PASTE THE JOB POSTING     │  │
│  │  PDF · DOCX       │  │                            │  │
│  │                   │  │  [Textarea, 400 char min]  │  │
│  │  [Upload Zone]    │  │                            │  │
│  └───────────────────┘  └────────────────────────────┘  │
│                                                         │
│              [ SCAN MY RESUME ]  ← primary CTA          │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ATS SCORE PANEL  (rendered post-scan, same page)       │
│                                                         │
│    ┌──────────────────────────────────────────────┐     │
│    │  [ Mac mascot — state-driven .webm asset ]   │     │
│    │  [ Score dial: spring animation 0 → N ]      │     │
│    │           Score: 34 / 100                    │     │
│    │    "ATS will reject this resume."            │     │
│    └──────────────────────────────────────────────┘     │
│                                                         │
│  TOP 3 GAPS (fully visible — no blur, no lock):         │
│  • Missing: "TypeScript"  (appears 6× in JD)            │
│  • Missing: "CI/CD pipeline"  (appears 4× in JD)        │
│  • Weak: Experience section has zero quantified impact  │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────────────┐     │
│  │  FIX MY RESUME   │  │  START INTERVIEW PREP    │     │
│  │  [SOFT GATE]     │  │  [SOFT GATE]             │     │
│  └──────────────────┘  └──────────────────────────┘     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Mobile layout (< 768px):** The two-column upload zone (CV drop + JD textarea) collapses to a single-column vertical stack. CV upload zone appears first, JD textarea below. CTA button is full-width. Score panel and gap list remain single-column. Both soft-gate buttons stack vertically, full-width.

### 2.3 Interaction Rules

| Trigger | Behaviour |
|---|---|
| User uploads CV + pastes JD + clicks Scan | `POST /api/ats-score` fires (no auth header required) |
| Scan in flight | Mac mascot switches to `processing.webm` |
| Score < 40 | Dial fills red. Mac switches to `shocked.webm`. Sets `useSessionStore.hardcorePending = true` |
| Score 40–69 | Dial fills amber. Mac switches to `warning.webm` |
| Score ≥ 70 | Dial fills green. Mac switches to `success.webm` |
| "Fix My Resume" click (anon) | Auth modal opens **in place** (no route change). On success → `/dashboard` |
| "Start Interview Prep" click (anon) | Auth modal opens in place. On success → `/dashboard` |
| Auth modal dismissed | Returns to `/` — score still visible, state unchanged |
| "Fix My Resume" click (already authenticated) | Routes directly to `/workspace?mode=resume` |
| Upload zone | Accepts PDF and DOCX. Client-side validation before upload |
| JD textarea | Minimum 400 characters before Scan button activates |
| Page idle (no interaction > 5s, pre-scan) | Mac holds `idle.webm` loop |

### 2.4 Anonymous State Persistence

CV + JD entered on `/` are stored in `useDocumentStore` (Zustand, in-memory). On successful auth, `ProtectedRoute` reads these values and auto-triggers the upload + score sequence on `/dashboard`, so the user arrives with context already loaded.

```typescript
// useDocumentStore — keys written on landing page
interface LandingPagePendingState {
  pendingCvFile:  File | null    // raw File object from <input>
  pendingJdText:  string         // raw JD paste
  atsScore:       number | null  // result from /api/ats-score
  atsGaps:        string[]       // top 3 gaps for display
}
```

### 2.5 API Contract (Public — No Auth)

```
POST /api/ats-score
Body:     { cv_text: string, jd_text: string }
Response: { score: number, gaps: string[], embedding_quality: "ok" | "low" }
Auth:     NONE — public endpoint, no JWT required
```

### 2.6 Score Animation — UX Spec

**Component:** `<AtsScoreDial />` in `shared/ui/AtsScoreDial.tsx`

- **Dial animation:** SVG arc, Framer Motion `useSpring`, 0 → score over 1.2 seconds
- **Mac analysis sequence:** Mac plays `processing.webm` → text ticks "Parsing CV…", "Reading JD…", "Calculating match…" → score reveal → Mac switches to result state asset
- **Score 0–39:** Arc fills red. Label: `"ATS will reject this resume."`
- **Score 40–69:** Arc fills amber. Label: `"Borderline — targeted fixes needed."`
- **Score 70–100:** Arc fills green. Label: `"Strong match."`
- **Auto-Hardcore trigger:** Score < 40 sets `useSessionStore.hardcorePending = true`. On dashboard load, Hardcore Mode activates automatically (see §5).

### 2.7 Mac Mascot — Visual State Machine

Mac is a **visual mascot**, not a text label. He is driven by `.webm` video assets rendered in a `<video>` element with `loop` and `muted`. Asset switching is driven by `useSessionStore.macState`.

**Asset inventory:**

| Asset | File | Triggers |
|---|---|---|
| Idle loop | `idle.webm` | App ready, no active operation |
| Listening | `listening.webm` | User is typing in JD textarea or interview chat input |
| Processing | `processing.webm` | Any in-flight API call (`isLoading = true`) |
| Shocked | `shocked.webm` | ATS score < 40 revealed |
| Success | `success.webm` | ATS score ≥ 70 revealed; diff accepted; interview session ends positively |
| Warning | `warning.webm` | ATS score 40–69 revealed; Hardcore Mode auto-triggered |

**Component spec:**

**FSD location:** `shared/ui/MacMascot.tsx`

```typescript
type MacState = "idle" | "listening" | "processing" | "shocked" | "success" | "warning"

// useSessionStore slice
interface MacMascotState {
  macState: MacState
  setMacState: (state: MacState) => void
}
```

**Transition rules:**
- `processing` is always set immediately on API call start, cleared on response/error
- `processing` overrides any other state while in flight — it is the highest-priority state
- After `shocked` or `success` or `warning`, the mascot holds that state for **3 seconds**, then falls back to `idle`
- `listening` activates on `onFocus` of any user text input; reverts to `idle` on `onBlur`
- Asset switching uses a crossfade via CSS `transition: opacity 0.2s` — never an abrupt cut
- On mobile, the mascot renders at 80px × 80px (vs 160px × 160px on desktop). It is **never hidden** on mobile — it is the primary emotional signal.

---

## 3. Central Hub — Route: `/dashboard`

### 3.1 Purpose

The Dashboard is the **persistent context hub**. It holds the user's CV + JD, displays their current ATS score, and surfaces three primary action cards. It is **never a wizard step**. Users return to it between sessions, between workspace modes, and after upgrades — always landing in a coherent, loaded state.

### 3.2 Access Rules

```typescript
// ProtectedRoute — three-stage guard
1. No JWT present          → redirect to /  (with ?returnTo=/dashboard)
2. JWT valid               → proceed to dashboard mount
3. pendingCvFile non-null  → auto-trigger upload + ATS score on mount
                              (clears pendingCvFile / pendingJdText after success)
```

### 3.3 Page Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  NAVBAR: JobifAI  ·  [Dashboard]  ·  [Account]  ·  [Pricing]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CONTEXT BAR (always visible at top):                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  📄 senior-dev-cv.pdf  ·  🏢 Shopify — Senior Engineer  │   │
│  │  ATS Score: [■■■■□□□□□□] 34        [Change Documents]   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [HARDCORE MENTOR MODE  ○──────]  OFF                           │
│  "Stop being nice to yourself. Brutal gaps only."               │
│                                                                 │
├─────────────────┬───────────────────────┬───────────────────────┤
│                 │                       │                       │
│  ACTION CARD    │  ACTION CARD          │  ACTION CARD          │
│                 │                       │                       │
│  🔧              │  🎤                    │  ✉️                    │
│  Fix My         │  Mock Interview       │  Cover Letter         │
│  Resume         │  Coach                │  Draft                │
│                 │                       │                       │
│  "3 critical    │  "Practice STAR       │  "Tailored to this    │
│   gaps found"   │   questions for       │   JD in 30 seconds"   │
│                 │   this role"          │                       │
│                 │                       │                       │
│  [Open →]       │  [Start →]            │  [Generate →]         │
│                 │  FREE: 1 left         │  Premium only 🔒       │
│                 │                       │                       │
└─────────────────┴───────────────────────┴───────────────────────┤
│                                                                 │
│  RECENT SESSIONS (last 3, collapsible):                         │
│  • Resume Fix  ·  2 rewrites applied  ·  Score: 34→58  ·  2h ago│
│  • Interview   ·  12 turns  ·  "Good energy, weak specifics"    │
└─────────────────────────────────────────────────────────────────┘
```

**Mobile layout (< 768px):** The three-column Action Card grid collapses to a **single-column vertical stack**. Card order: Fix My Resume → Mock Interview → Cover Letter. Context bar wraps onto two lines (filename row, score row). Hardcore toggle remains full-width below the context bar. Recent Sessions section is collapsed by default on mobile.

### 3.4 Mac Mascot on Dashboard

Mac is present on `/dashboard` in the top-right corner of the context bar area, at `idle.webm` by default.

| Dashboard Event | Mac State |
|---|---|
| Dashboard loading (data fetch in flight) | `processing.webm` |
| `pendingCvFile` upload + score in progress | `processing.webm` |
| Score computed < 40 (including auto-hydrated score) | `shocked.webm` → `idle.webm` after 3s |
| Score computed ≥ 70 | `success.webm` → `idle.webm` after 3s |
| Hardcore Mode auto-activated | `warning.webm` → holds until user interacts with banner |
| Idle (all data loaded) | `idle.webm` loop |

### 3.5 Context Bar State Rules

| Store State | Context Bar Renders |
|---|---|
| No CV, no JD | "Upload your CV to get started" + upload button |
| CV only | CV filename + "Add a job posting to unlock scoring" |
| CV + JD | Both filenames + ATS score + `[Change Documents]` |
| CV + JD + `is_premium` | Same layout, score in green if ≥ 70, unlimited badge |

**"Change Documents"** opens a confirmation modal. Confirming resets `useDocumentStore.cvText`, `jdText`, `atsScore`, `atsGaps` and triggers re-upload flow. This is a destructive action and requires explicit user intent.

### 3.6 Action Card States

```typescript
type ActionCardState =
  | "available"       // free uses remain, or user is premium
  | "limit-reached"   // free tier exhausted — shows inline upgrade CTA
  | "premium-only"    // feature locked — teaser copy + lock icon
  | "no-context"      // CV or JD not loaded — disabled, shows what's missing
  | "loading"         // in-flight navigation to workspace
```

Free-tier counter values are read from `useBillingStore`, hydrated from `GET /api/user/me` on dashboard mount. **The server is authoritative.** Frontend counters are display-only — they never gate access, only inform the UI.

### 3.7 Data Loading on Mount

```typescript
// Parallel fetch on /dashboard mount
await Promise.all([
  fetchUserProfile(),      // GET /api/user/me → useBillingStore + useSessionStore
  fetchDocumentContext(),  // GET /api/user/documents → useDocumentStore
  fetchRecentSessions(),   // GET /api/user/sessions → useSessionStore.recentSessions
])

// Sequential: only if landing page left pending state
if (useDocumentStore.getState().pendingCvFile) {
  await uploadAndScore(pendingCvFile, pendingJdText)
  // POST /api/upload-resume + POST /api/ats-score
  // Clears pendingCvFile / pendingJdText on success
}
```

---

## 4. Sandwich UI Protocol — Route: `/workspace`

### 4.1 Mandate

The Sandwich UI is the **non-negotiable** interaction pattern for all resume editing in v2. Any implementation that presents AI suggestions as a disconnected list — sidebar, floating panel, modal, separate tab — is a **v1 regression** and must be rejected at code review.

> **The AI suggestion always appears inline, directly below the bullet it targets. Full stop.**

### 4.2 The Sandwich Model

```
┌─────────────────────────────────────────────────────────┐  ← TOP BREAD
│  AI Suggestion Layer (inline, below targeted bullet)    │
│  ─────────────────────────────────────────────────────  │
│  AFTER:  "Engineered 4 TypeScript microservices,        │
│           reducing deploy time by 40%"                  │
│                                                         │
│  +6 ATS points ↑     [✓ Accept]  [✗ Reject]  [✏ Edit]  │
├─────────────────────────────────────────────────────────┤  ← FILLING
│  BEFORE: "Led development of new features"              │
│  (highlighted in amber — the targeted bullet)           │
├─────────────────────────────────────────────────────────┤  ← BOTTOM BREAD
│  Rest of resume at 40% opacity (context, not focus)     │
└─────────────────────────────────────────────────────────┘
```

The sandwich appears **between** bullets using Framer Motion `layout` animation. Surrounding bullets animate apart to create space. The user never scrolls away from their document to see a suggestion.

### 4.3 Workspace Layout

```
┌─────────────────────────────────────────────────────────────┐
│  NAVBAR  ·  [← Dashboard]  ·  ATS: 34 → [58 preview] ↑    │
├───────────────────────────────┬─────────────────────────────┤
│                               │                             │
│  RESUME PANEL (Base Layer)    │  MAC COACHING PANEL         │
│                               │  ┌─────────────────────┐   │
│  Full structured resume,      │  │  [Mac mascot .webm] │   │
│  rendered as editable         │  │  state-driven asset  │   │
│  section/bullet rows.         │  └─────────────────────┘   │
│                               │                             │
│  ← SandwichDiffInline         │  Contextual coaching copy   │
│    renders here, below        │  anchored to focused        │
│    the targeted <BulletRow/>  │  resume section.            │
│    via Framer Motion layout   │                             │
│                               │  [REWRITE THIS BULLET]      │
│                               │                             │
│                               │  ── KEYWORDS ──────────     │
│                               │  Inline chips only:         │
│                               │  [TypeScript ×6]            │
│                               │  [CI/CD ×4]                 │
│                               │  [Observability ×2]         │
│                               │                             │
│                               │  ← Click to inject via      │
│                               │    rewrite pipeline         │
└───────────────────────────────┴─────────────────────────────┘
```

**Mobile layout (< 768px):** The two-column workspace (Resume Panel + Mac Coaching Panel) collapses to a **single-column vertical stack**:
- Mac mascot renders at 80px as a sticky header element within the coaching panel
- Coaching Panel appears **above** the Resume Panel on mobile (coaching context first, document second)
- `SandwichDiffInline` still renders inline within the resume panel — the pattern is identical on mobile, just full-width
- The coaching panel collapses to a bottom drawer (40vh) with a drag handle; users swipe up to expand, tap resume to shrink
- Keyword chips wrap to multiple rows — no horizontal scroll

### 4.4 Mac Mascot — Workspace State Mapping

Mac is the primary emotional signal in the coaching panel. His state drives coaching panel tone.

| Workspace Event | Mac State |
|---|---|
| Workspace loaded, no active operation | `idle.webm` |
| User typing in JD / chat input | `listening.webm` |
| Any AI API call in flight (rewrite, interview, cover letter) | `processing.webm` |
| Rewrite response received with `scoreImpact` ≥ 6 | `success.webm` → `idle.webm` after 3s |
| Rewrite response received with `scoreImpact` < 4 | `warning.webm` → `idle.webm` after 3s |
| Interview interrupt fired (Hardcore Mode) | `shocked.webm` — holds until interrupt overlay dismissed |
| API error returned | `warning.webm` → `idle.webm` after 3s |
| Session score improves by ≥ 15 points total | `success.webm` — holds for 5s (milestone celebration) |

**Rule:** In Hardcore Mode, `success.webm` is **never played** for individual rewrites — only for a total session score improvement ≥ 20 points. This reinforces the no-praise contract.

### 4.5 Sandwich Diff — Zustand State

```typescript
// useDocumentStore — sandwich state slice
interface SandwichState {
  pendingDiff: {
    fieldPath:    string   // e.g. "experience[1].bullets[2]"
    originalText: string
    proposedText: string
    scoreImpact:  number   // predicted ATS increase (3–8, from API)
  } | null
  acceptDiff:   () => void  // calls PATCH /api/resume/accept-diff, clears pendingDiff
  rejectDiff:   () => void  // clears pendingDiff, no API call
}
```

**State machine:**

```
IDLE
  ↓  [User clicks "Rewrite" or keyword chip, or Mac coaching fires]
PENDING_DIFF  ← SandwichDiffInline renders inline below target bullet
  ↓ [Accept]                  ↓ [Reject]           ↓ [Edit first]
APPLYING                    IDLE                  EDITING
  ↓ PATCH /api/resume/…       pendingDiff = null    textarea opens with proposedText
IDLE                                                ↓ [Accept edited version]
resume updated,                                   APPLYING → IDLE
score recalculates
```

**Constraint:** Maximum one active `pendingDiff` at a time. If a second rewrite is requested while one is pending, show confirmation: "Accept or reject the current suggestion first."

### 4.6 `<SandwichDiffInline />` Component Spec

**FSD location:** `features/resume-edit/ui/SandwichDiffInline.tsx`

```
┌──────────────────────────────────────────────────────────┐
│  BEFORE:  "Led development of new features"               │
├──────────────────────────────────────────────────────────┤
│  AFTER:   "Engineered 4 TypeScript microservices,         │
│            reducing deploy time by 40%"                   │
│                                                          │
│  +6 ATS points ↑                                         │
│                                                          │
│  [✓ Accept]   [✗ Reject]   [✏ Edit first]                │
└──────────────────────────────────────────────────────────┘
```

- Framer Motion `layout` prop on all `<BulletRow />` — siblings animate apart on diff insertion
- `scoreImpact` renders as `+N ATS points` in green — sourced from `RewriteResponse.predicted_score_increase`
- "Edit first" replaces `proposedText` with an inline `<textarea>` — Accept submits the edited version
- "Accept" fires `PATCH /api/resume/accept-diff` then clears `pendingDiff`
- "Reject" clears `pendingDiff` only — no API call, no counter consumed

### 4.7 Missing Keywords — Inline Chips Only

**Explicitly prohibited:** A standalone "Missing Keywords" section, sidebar list, separate tab, or modal showing terms outside document context.

**Required implementation:** Keywords present in the JD but absent from the CV surface as **inline chips inside the Mac Coaching Panel**, always anchored to the currently focused resume section.

```
Coaching Panel — "Experience" section focused:
──────────────────────────────────────────────
"This section is missing terms that appear frequently
 in the job description. Click a keyword to inject it
 into your focused bullet."

[TypeScript ×6]   [CI/CD ×4]   [Observability ×2]
```

**Keyword injection flow:**
1. User clicks a keyword chip
2. Nearest bullet in focused section is selected (highlights in amber)
3. `POST /api/rewrite-section` fires with the keyword as a hard constraint in the prompt
4. Response populates `pendingDiff` → Sandwich renders inline

The keyword is **never injected raw into the document**. It always passes through the rewrite pipeline. This prevents keyword-stuffed, unnatural output.

### 4.8 Workspace Route Params

```
/workspace?mode=resume     → Resume Fix (magic rewrite, sandwich diffs)
/workspace?mode=interview  → Interview Coach (SSE stream, turn-based)
/workspace?mode=cover      → Cover Letter (generation + inline edit)
```

`useSessionStore.workspaceMode` is hydrated from the URL param on mount. Mode controls which action panel renders in the coaching column and which API endpoints are active.

### 4.9 SSE Streaming — Interview Mode

Interview responses stream via SSE. The coaching panel renders tokens progressively. No full-page loading state — partial responses are immediately visible.

```typescript
type InterviewSSEEvent =
  | { type: "token";     data: string }          // append to response
  | { type: "done";      data: null }             // stream complete
  | { type: "interrupt"; data: { reason: string } } // Hardcore Mode only
  | { type: "error";     data: { message: string } }
```

`enforcer.consume()` is called **only after** `type: "done"` — never on error, never on interrupt.

---

## 5. Hardcore Mentor Mode

### 5.1 Purpose

Hardcore Mentor Mode activates a zero-tolerance coaching persona. It is for users who need maximum improvement velocity, not encouragement. The entire coaching UX shifts from supportive to surgical. No softening language. No qualifiers. Only directives.

### 5.2 Activation Triggers

| Trigger | Mechanism |
|---|---|
| Manual toggle on `/dashboard` | User intent — persisted to `profiles.hardcore_mode` via `PATCH /api/user/me` |
| ATS score < 40 on landing page | `useSessionStore.hardcorePending = true` → auto-activates on dashboard mount |
| ATS score drops < 40 after a rewrite cycle | Score watcher in `useDocumentStore` fires auto-activation mid-session |

### 5.3 Dashboard Toggle — UX Spec

```
┌──────────────────────────────────────────────────────────┐
│  HARDCORE MENTOR MODE                         [  ○ OFF ] │
│  "Stop being nice to yourself. Brutal gaps only."        │
└──────────────────────────────────────────────────────────┘
```

- Toggle is always visible on `/dashboard` after first ATS score is computed
- State persists across sessions (stored in `profiles.hardcore_mode`, synced on `GET /api/user/me`)
- Toggle change fires `PATCH /api/user/me` immediately — no save button

### 5.4 Auto-Trigger Banner (ATS < 40)

When `hardcorePending = true` on dashboard mount, show a **non-dismissible** banner before auto-toggling:

```
┌──────────────────────────────────────────────────────────────────┐
│  ⚠️  Your ATS score is 34. This resume will be auto-rejected.    │
│  Hardcore Mentor Mode has been activated automatically.          │
│                                         [Keep it on]  [Turn off] │
└──────────────────────────────────────────────────────────────────┘
```

- "Keep it on" → clears `hardcorePending`, `hardcore_mode` stays `true`
- "Turn off" → clears `hardcorePending`, sets `hardcore_mode = false`, fires `PATCH /api/user/me`
- Banner is removed after either action

### 5.5 Behavioural Changes — Hardcore ON vs OFF

| Element | Standard Mode | Hardcore Mode |
|---|---|---|
| Mac coaching tone | "This bullet could be stronger…" | "This bullet is rejected by ATS. Rewrite it." |
| Mac mascot on individual rewrite accept | `success.webm` | No state change — back to `idle.webm` |
| Mac mascot on score milestone (≥ 20pt gain) | `success.webm` 5s | `success.webm` 5s (only exception) |
| Score dial label (< 40) | "ATS will reject this resume." | "0 recruiters will see this. Fix it now." |
| Gap count label | "3 gaps found" | "3 critical failures" |
| Sandwich diff display | Shows `scoreImpact` + brief explanation | Shows `scoreImpact` only — no explanation |
| Accept / Reject buttons | Both visible | Reject hidden by default. "Show reject" link available |
| Interview coach | Waits for user to finish answer | Interrupts after 4 sentences with no metric (see §5.6) |
| Cover letter tone | Professional, warm | Precise, direct, no filler phrases |

### 5.6 Interview Coach — Interrupt Protocol (Hardcore Only)

In Hardcore Mode, the coach does not wait politely for weak answers to finish.

**Interrupt condition:** User's answer exceeds 4 sentences and contains no specific metric, named outcome, or quantified result.

**Interrupt behaviour:**
1. Backend fires `{ type: "interrupt", data: { reason: "No measurable outcome detected." } }` SSE event
2. Mac switches to `shocked.webm` — holds until overlay dismissed
3. Frontend renders a **blocking overlay** on the chat panel — user cannot type until acknowledged
4. Overlay text: *"Stop. Where's the number? Quantify the outcome before continuing."*
5. User clicks `[Continue with specifics]` to dismiss and resume

`enforcer.consume()` is **not called** on an interrupted turn — the session is incomplete.

### 5.7 API Contract

All workspace AI calls include the Hardcore flag:

```typescript
// Included in every workspace API request body
{ hardcore_mode: boolean }  // from useSessionStore.hardcoreMode
```

Backend routes (`/api/rewrite-section`, `/api/chat/interview`, `/api/cover-letter`) inject the flag into the Gemini system prompt. Two prompt variants per endpoint, selected at the service layer — the route handler passes `hardcore_mode: bool` to the service function.

### 5.8 Persistence Schema

```sql
-- profiles table addition
ALTER TABLE profiles ADD COLUMN hardcore_mode BOOLEAN NOT NULL DEFAULT false;
```

```typescript
// On toggle:
PATCH /api/user/me
Body: { hardcore_mode: boolean }

// On mount:
GET /api/user/me → { ..., hardcore_mode: boolean }
// Hydrates useSessionStore.hardcoreMode
```

---

## 6. Settings, Privacy & Localization — Route: `/settings`

### 6.1 Purpose

`/settings` is the user's control panel for account identity, data sovereignty, API key management, and language preferences. It is a **ProtectedRoute**. Every destructive action requires a confirmation step. No action in this section is reversible without explicit re-confirmation.

### 6.2 BYOK — Bring Your Own Key

The BYOK feature allows users to supply a personal Gemini API key to bypass all server-side quota limits. Key management lives in `/settings`, not scattered across the UI.

**Storage contract:**
- The key is stored **encrypted at rest** in `profiles.byok_api_key_encrypted` (AES-256, server-side encryption via Supabase Vault or equivalent)
- On login, the key is fetched via `GET /api/user/me` and loaded **in-memory only** into `useChatStore.byokApiKey`
- The key is **never** exposed in client-side localStorage, sessionStorage, or any browser-persistent store
- The key is **never** logged, never included in Sentry replays (masked by `maskAllText: true`), never appears in API response payloads beyond the initial fetch

**Settings UI:**

```
┌──────────────────────────────────────────────────────────────┐
│  BRING YOUR OWN GEMINI API KEY                               │
│                                                              │
│  Bypass all usage limits. Your key, your quota.              │
│                                                              │
│  [●●●●●●●●●●●●●●●●●●●  AIza••••••••] [Remove]  [Update]    │
│                                                              │
│  ⚠ Your key is stored encrypted and never shared.           │
│  It is used only for your AI requests.                       │
└──────────────────────────────────────────────────────────────┘
```

**API contract:**

```
PATCH /api/user/settings
Body:     { byok_api_key: string }       // set or update key
Body:     { byok_api_key: null }         // remove key

Response: { byok_configured: boolean }  // never echoes the key back
Auth:     JWT required
```

**Validation:** Backend validates the key makes a live call to `generativelanguage.googleapis.com` before saving. If the key is invalid or quota-exhausted, return `422` with `{ error: "BYOK key validation failed" }`.

### 6.3 Localization — Canada-First, Newcomer-Aware

JobifAI's primary market is **Canada**. The platform must be immediately usable by French-speaking Canadians and by recent immigrants who are non-native English speakers.

#### 6.3.1 Supported Languages

| Language | Coverage | Priority |
|---|---|---|
| English (en-CA) | Full UI + AI coaching + voice input | P0 — launch |
| French (fr-CA) | Full UI + AI coaching + voice input | P0 — launch |
| Ukrainian (uk) | AI coaching responses + voice input | P1 — post-launch |
| Polish (pl) | AI coaching responses + voice input | P1 — post-launch |

**"Full UI"** means: all static copy, navigation labels, error messages, tooltips, onboarding text, and all AI-generated coaching responses.

**"AI coaching responses"** means: Gemini system prompts include a `response_language` field. The model is instructed to respond in the user's selected language. CV and JD content are processed in their original language regardless of the user's UI locale.

**"Voice input"** means: the browser's `SpeechRecognition` API `lang` attribute is set to the user's locale. Supported where the browser supports it (Chrome, Safari on iOS). Graceful fallback to text input where unsupported.

#### 6.3.2 Locale Selection

- Default locale: detected from `navigator.language` on first visit
- Explicit locale: stored in `profiles.locale` (e.g., `"fr-CA"`, `"uk"`)
- Language selector in `/settings` and in the Navbar (globe icon, dropdown)
- Locale change takes effect immediately — no page reload required
- All AI request bodies include `{ locale: string }` — backend passes `response_language` to Gemini

#### 6.3.3 i18n Implementation

**FSD location:** `shared/lib/i18n/`

```
shared/lib/i18n/
  en-CA.json       // base locale (authoritative keys)
  fr-CA.json       // full translation
  uk.json          // partial — coaching responses only
  pl.json          // partial — coaching responses only
  index.ts         // i18next init + locale detection
```

- Library: `i18next` + `react-i18next`
- Missing keys fall back to `en-CA` — never show raw key strings
- All date/number formatting uses `Intl.DateTimeFormat` and `Intl.NumberFormat` with the active locale
- Currency always displays in CAD (`en-CA` → `$4.99`, `fr-CA` → `4,99 $`)

#### 6.3.4 Settings UI — Language

```
┌──────────────────────────────────────────────────────────────┐
│  LANGUAGE & REGION                                           │
│                                                              │
│  UI Language:   [English (Canada)  ▾]                        │
│  AI Responses:  [English (Canada)  ▾]                        │
│                                                              │
│  AI Response language can differ from UI language.          │
│  Useful if you're practising English professionally          │
│  but need coaching explanations in your first language.      │
└──────────────────────────────────────────────────────────────┘
```

`profiles.locale` stores the UI locale. `profiles.ai_locale` stores the AI response language. They are independently configurable — a user can have the UI in English and receive coaching in Ukrainian.

### 6.4 PIPEDA Compliance — Right to be Forgotten

Canada's **Personal Information Protection and Electronic Documents Act (PIPEDA)** grants users the right to request erasure of all personal data. This is not an optional feature — it is a legal requirement.

#### 6.4.1 Delete Account & Data Button

The delete button must be:
- **Highly visible** — not buried in a sub-menu, not grey, not small
- **Red** (`#DC2626` / Tailwind `red-600`) with a destructive icon
- **Labelled explicitly:** "Delete My Account & All Data"
- Located at the **bottom of the `/settings` page**, in a clearly demarcated "Danger Zone" section

```
┌──────────────────────────────────────────────────────────────┐
│  ━━━━━━━━━━━━━━━━  DANGER ZONE  ━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                              │
│  Permanently delete your account and all associated data.   │
│  This action is irreversible. All resumes, sessions, and    │
│  billing history will be erased immediately.                │
│                                                              │
│  [ 🗑  Delete My Account & All Data ]  ← red, prominent     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### 6.4.2 Deletion Confirmation Flow

Clicking the delete button opens a **two-step confirmation modal** — not a simple "are you sure?":

**Step 1:** Display a summary of what will be deleted:
```
This will permanently delete:
• Your profile and account credentials
• X saved resumes
• X interview session transcripts
• X cover letters
• Your billing history and subscription

Type DELETE to confirm:  [________________]
```

**Step 2:** Only after typing `DELETE` exactly does the confirm button activate. Confirm fires `DELETE /api/user/account`.

#### 6.4.3 Backend Deletion RPC

The deletion is handled by a Supabase RPC that uses `CASCADE` to wipe all data atomically. A simple `DELETE FROM profiles WHERE id = $1` is insufficient — related rows across all tables must be purged.

```sql
-- Supabase RPC: delete_user_account(user_id uuid)
CREATE OR REPLACE FUNCTION delete_user_account(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Verify caller is deleting their own account only
  IF auth.uid() != target_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- CASCADE handles: user_data, resumes, chat_history via FK constraints
  DELETE FROM public.profiles WHERE id = target_user_id;

  -- Purge Supabase Auth user (requires service role — called from backend)
  -- backend calls: supabase.auth.admin.deleteUser(target_user_id)
END;
$$;

-- Grant to authenticated only (not anon)
GRANT EXECUTE ON FUNCTION delete_user_account TO authenticated;
REVOKE EXECUTE ON FUNCTION delete_user_account FROM anon;
```

**FK CASCADE requirements:** All tables referencing `profiles.id` must have `ON DELETE CASCADE`:
```sql
-- Required on all child tables
ALTER TABLE public.user_data    ADD CONSTRAINT fk_profile FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.resumes      ADD CONSTRAINT fk_profile FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
-- (verify all tables — run: SELECT * FROM information_schema.referential_constraints WHERE unique_constraint_name LIKE '%profiles%')
```

#### 6.4.4 API Contract

```
DELETE /api/user/account
Body:     { confirmation: "DELETE" }    // must match exactly
Auth:     JWT required (service role on backend for auth.admin.deleteUser)

Response 200: { deleted: true }
Response 400: { error: "Confirmation text did not match" }
Response 401: { error: "Unauthorized" }
```

**Post-deletion flow:**
1. Backend calls Supabase RPC `delete_user_account(user_id)`
2. Backend calls `supabase.auth.admin.deleteUser(user_id)` (service role)
3. Backend returns `200 { deleted: true }`
4. Frontend clears all Zustand stores, removes JWT from memory
5. Frontend redirects to `/` with query param `?deleted=true`
6. Landing page shows one-time banner: "Your account and all data have been permanently deleted."

#### 6.4.5 Stripe Subscription Cancellation

If the user has an active Stripe subscription, deletion must also cancel it:
- Call `stripe.subscriptions.cancel(subscription_id)` before the Supabase RPC
- If Stripe cancellation fails, **abort the deletion** and return `500` — do not leave a partially-deleted account
- Log the failure to Sentry with `level: "fatal"` and `user.id` for manual remediation

### 6.5 Settings Page — Full Layout

```
/settings
──────────────────────────────────────────────────────────────

  PROFILE
  ─────────────────────────────────────────────────────────
  Display Name:  [________________]
  Email:         user@example.com  (managed by Supabase Auth)
  Avatar:        [Upload photo]
  [Save Changes]

  LANGUAGE & REGION
  ─────────────────────────────────────────────────────────
  UI Language:    [English (Canada)  ▾]
  AI Responses:   [English (Canada)  ▾]

  BRING YOUR OWN GEMINI API KEY
  ─────────────────────────────────────────────────────────
  [●●●●●●●●●●●●●●●●●●●  AIza••••••]  [Remove]  [Update]
  ⚠ Stored encrypted. Bypasses all usage limits.

  SUBSCRIPTION
  ─────────────────────────────────────────────────────────
  Plan: Free Tier  ·  3 rewrites remaining
  [Upgrade to Premium]  ·  [Manage Billing →]  (Stripe portal)

  NOTIFICATIONS
  ─────────────────────────────────────────────────────────
  [ ] Email me when my ATS score improves after a session
  [ ] Weekly job search tips (opt-in)

  ━━━━━━━━━━━━━━━━  DANGER ZONE  ━━━━━━━━━━━━━━━━━━━━━━━━
  [ 🗑  Delete My Account & All Data ]
```

**Mobile layout (< 768px):** Single-column, all sections stacked vertically. Danger Zone section pinned to bottom. No horizontal sections.

---

## Appendix A — Route Map

| Route | Auth Required | Page Component | Primary Store Dependencies |
|---|---|---|---|
| `/` | No | `LandingPage` | `useDocumentStore`, `useSessionStore` |
| `/onboarding` | Yes (new user) | `OnboardingPage` | `useDocumentStore`, `useAuthStore` |
| `/dashboard` | Yes | `DashboardPage` | All five stores |
| `/workspace` | Yes | `WorkspacePage` | `useDocumentStore`, `useSessionStore`, `useChatStore` |
| `/settings` | Yes | `SettingsPage` | `useAuthStore`, `useBillingStore`, `useSessionStore` |
| `/paywall` | No | `PaywallPage` | `useBillingStore` |
| `/pricing` | No | `PricingPage` | `useBillingStore` |

## Appendix B — Store ↔ Route Dependency Matrix

```
useAuthStore      → ALL routes (ProtectedRoute JWT guard)
useBillingStore   → /dashboard (action card states), /workspace (consume gate), /paywall, /settings
useDocumentStore  → / (pending upload), /dashboard (context bar), /workspace (resume render, sandwich diffs)
useSessionStore   → /dashboard (hardcore toggle, macState), /workspace (SSE stream, interrupt state, macState), /settings (locale)
useChatStore      → /workspace (interview SSE, BYOK key — in-memory only)
```

## Appendix C — Mac Mascot State Reference

| `macState` | Asset | Duration | Reverts to |
|---|---|---|---|
| `idle` | `idle.webm` | Loop indefinitely | — |
| `listening` | `listening.webm` | While input focused | `idle` on blur |
| `processing` | `processing.webm` | While `isLoading = true` | Previous state on resolve |
| `shocked` | `shocked.webm` | 3s (or until overlay dismissed in Hardcore) | `idle` |
| `success` | `success.webm` | 3s (5s on milestone) | `idle` |
| `warning` | `warning.webm` | 3s (hold during Hardcore banner) | `idle` |

Asset switching uses CSS `opacity` crossfade (200ms). `processing` is highest priority and overrides all other states.

## Appendix D — v1 Regression Prevention Checklist

The following patterns are **explicitly banned** from v2. Any PR introducing them must be rejected:

- [ ] Redirecting to a new route to display a single AI suggestion
- [ ] A "Keywords" tab, sidebar, or panel that lists terms outside document context
- [ ] Auth required before any computed value is shown
- [ ] A linear Step 1 → Step 2 → Step 3 wizard for resume improvement
- [ ] Gemini response rendered in a modal disconnected from the document
- [ ] Re-uploading documents after switching workspace modes
- [ ] Full-page loading spinner during AI calls (use SSE streaming + skeleton rows)
- [ ] Storing the BYOK key in `localStorage`, `sessionStorage`, or Supabase unencrypted
- [ ] Calling `enforcer.consume()` before a confirmed successful Gemini response
- [ ] A standalone "Missing Keywords" list anywhere in the workspace UI
- [ ] Blocking workspace access while `pendingDiff` is non-null (one diff at a time, not a freeze)
- [ ] Hiding the Mac mascot on mobile — he is always visible, always expressing state
- [ ] Hardcoding locale to `en` — locale must flow from `profiles.locale` from first render
- [ ] Deleting user data without CASCADE (partial deletion leaves orphaned rows)
- [ ] Cancelling Stripe subscription after deleting Supabase rows (reverse order — Stripe first)
