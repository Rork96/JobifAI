# JobifAI — Developer Handbook

> **Radical Candor Mode active.** This document is the binding technical contract for JobifAI.  
> Last synthesized: 2026-03-26. Supersedes all prior fragmented docs.  
> If you ship code that violates it, you are creating debt for yourself. No exceptions.

---

## Table of Contents

1. [Monorepo Layout](#1-monorepo-layout)
2. [Local Development & Quick-Start Runbook](#2-local-development--quick-start-runbook)
3. [Frontend Architecture — Feature-Sliced Design](#3-frontend-architecture--feature-sliced-design)
4. [State Management — Zustand Domain Slices](#4-state-management--zustand-domain-slices)
5. [Backend Architecture — Service Layer](#5-backend-architecture--service-layer)
6. [Authentication Contract](#6-authentication-contract)
7. [AI Pipeline](#7-ai-pipeline)
8. [Scaling & Maintenance Strategy (The Forever Plan)](#8-scaling--maintenance-strategy-the-forever-plan)
9. [App Store & Cross-Platform Strategy](#9-app-store--cross-platform-strategy)
10. [Paranoia Protocol (Observability & Recovery)](#10-paranoia-protocol-observability--recovery)
11. [Infrastructure & One-Click Deployment](#11-infrastructure--one-click-deployment)
12. [Local Mobile Testing — Tailscale Protocol](#12-local-mobile-testing--tailscale-protocol)

---

## 1. Monorepo Layout

```
jobifai/
│
├── frontend/                     React 18 + Vite + TypeScript + Tailwind + Framer Motion
│   └── src/
│       ├── app/                  Bootstrap: main.tsx, App.tsx, router/ProtectedRoute.tsx
│       ├── pages/                Route shells: Landing, Onboarding, Dashboard, Workspace, Paywall
│       ├── widgets/              Assembled blocks: TopBar, ResumeEditor, ChatSidebar, MacMascot
│       ├── features/             Vertical slices: auth, ai-coaching, document-editor,
│       │                         ats-scoring, billing, onboarding
│       ├── entities/             Domain types: resume, user, chat, analysis
│       ├── shared/               Zero-business-logic: ui, lib, config, utils
│       ├── store/                useAppStore.ts (~1 600 lines — decomposition in §4)
│       ├── hooks/                useAuth · useAutoSave · useSpeechRecognition
│       ├── layouts/              MainLayout · WorkspaceLayout
│       └── types/                index.ts · speech.d.ts
│
├── backend/                      FastAPI 0.111.0 + Python 3.11 + Uvicorn
│   ├── main.py                   App factory, CORS, timing middleware, /health
│   ├── config.py                 Pydantic BaseSettings singleton (lru_cache)
│   ├── routers/                  8 router files → 16 endpoints (see §5)
│   ├── services/                 Business logic layer (target state — see §5)
│   ├── repositories/             DB access layer (target state — see §5)
│   └── dependencies/             auth.py · limits.py
│
├── supabase/
│   └── migrations/
│       ├── 20240322000000_user_data.sql          Session table + RLS + updated_at trigger
│       └── 20240323000000_freemium_limits.sql    Profiles table + quota counters + decrement RPC
│
├── docker-compose.yml            ARM64 / Raspberry Pi 5 — single source of truth for infra
├── .env.example                  All required secrets with placeholders
├── backend-architecture.md       Backend technical reference
└── DEVELOPER_HANDBOOK.md         ← you are here
```

**Ports**

| Service | Port | Notes |
|---|---|---|
| Vite dev | 5173 | `npm run dev` |
| Vite preview | 4173 | `npm run preview` |
| FastAPI / uvicorn | 8000 | Docker or bare `uvicorn` |
| node-exporter | 9100 | Localhost-only — metrics |
| Supabase | 443 | Hosted cloud; Nginx proxy on Pi (TODO) |

**Rule:** Never import from `backend/` in `frontend/` or vice versa. They communicate over HTTP only.

---

## 2. Local Development & Quick-Start Runbook

### 2.1 Start Dev Environment

```bash
# Terminal 1 — Frontend
cd frontend
npm install
npm run dev
# → http://localhost:5173

# Terminal 2 — Backend (bare uvicorn, fastest iteration)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000

# Terminal 3 — Optional: Docker for Pi parity
docker compose up --build
```

### 2.2 Required `.env` Variables

Copy `.env.example` → `.env`. **Never commit `.env`.**  
All backend variables are validated at startup by Pydantic `BaseSettings` — a missing required variable causes an immediate `ValidationError` crash. Fail-fast by design.

| Variable | Required | Source | Description |
|---|---|---|---|
| `SUPABASE_URL` | ✅ | Supabase → Settings → API | Project URL (`https://xxx.supabase.co`) |
| `SUPABASE_KEY` | ✅ | Supabase → Settings → API → `service_role` | **Service role** key — bypasses RLS; backend only |
| `SUPABASE_JWT_SECRET` | ✅ | Supabase → Settings → API → JWT Secret | Symmetric HS256 signing secret — Strategy A auth |
| `SUPABASE_ANON_KEY` | frontend only | Supabase → Settings → API → `anon` | Public key — React client only, never in backend |
| `GEMINI_API_KEY` | ✅ | Google AI Studio | Gemini 2.5 Flash + text-embedding-004 |
| `STRIPE_SECRET_KEY` | ✅ | Stripe Dashboard | `sk_live_xxx` or `sk_test_xxx` |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Stripe Dashboard → Webhooks | `whsec_xxx` — HMAC-SHA256 verification |
| `STRIPE_PRICE_PASS_ID` | optional | Stripe Dashboard → Products | Pre-created Price ID for $4.99 24-hr pass |
| `STRIPE_PRICE_MONTHLY_ID` | optional | Stripe Dashboard → Products | Pre-created Price ID for $14.99/mo subscription |
| `CORS_ORIGINS` | optional | — | Comma-separated; defaults to `localhost:5173` |
| `DEV_TAILSCALE_ORIGIN` | dev only | `tailscale ip -4` | `http://100.x.x.x:5173` — mobile testing (§12) |
| `ENVIRONMENT` | optional | — | `dev` or `production`; controls docs, CORS |

```bash
# Minimal .env for local dev
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_KEY=eyJ...          # service_role key
SUPABASE_JWT_SECRET=<jwt-secret-from-supabase-settings>
SUPABASE_ANON_KEY=eyJ...     # anon key (frontend only)
GEMINI_API_KEY=AIza...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PASS_ID=price_...
STRIPE_PRICE_MONTHLY_ID=price_...
ENVIRONMENT=dev
```

### 2.3 Apply DB Migrations (First Time or After Pull)

Run sequentially in Supabase Dashboard → SQL Editor → New query. Both scripts are idempotent — safe to re-run.

```
☐ Paste supabase/migrations/20240322000000_user_data.sql → Run
  Creates: public.user_data (id, resume_data jsonb, analysis_result jsonb,
           chat_history jsonb, is_premium bool, updated_at timestamptz)
  + RLS policies (read/insert/update/delete own)
  + updated_at trigger

☐ Paste supabase/migrations/20240323000000_freemium_limits.sql → Run
  Creates: public.profiles (id, email, stripe_customer_id, is_premium,
           premium_plan, free_rewrites_left, free_interviews_left, created_at, updated_at)
  + CHECK constraints (free_*_left >= 0)
  + decrement_free_limit() RPC (SECURITY DEFINER, service-role only)
  + RLS policies

☐ Verify public.resumes table exists.
  ⚠️  No migration file found for this table — router exists but table may be missing.
  Action: run supabase/migrations/20240324000000_resumes.sql if it exists,
  otherwise create it manually or delete the router.
```

### 2.4 Diagnostic Checks

```bash
# Verify which JWT algorithm Supabase is using
# Grab a live token from browser DevTools → Application → Local Storage → sb-*-auth-token
# Paste to jwt.io → check header `alg` field
# If alg = "ES256" → confirm §6 fix is applied before going to production

# Test JWKS connectivity from inside Docker
docker exec jobifai-backend \
  curl -s "${SUPABASE_URL}/auth/v1/.well-known/jwks.json" | python3 -m json.tool
# Expected: JSON object with `keys` array
# If 404 or timeout → Strategy C is always active → all requests pay 50–150 ms auth overhead

# Verify backend health
curl http://localhost:8000/health
# Expected: {"status":"ok","service":"jobifai-api","version":"0.1.0","environment":"dev"}

# Verify CORS preflight (Tailscale mobile testing)
curl -v \
  -H "Origin: http://100.64.0.12:5173" \
  -H "Access-Control-Request-Method: POST" \
  -X OPTIONS http://localhost:8000/api/chat/interview
# Expected: HTTP 200 + Access-Control-Allow-Origin header
```

---

## 3. Frontend Architecture — Feature-Sliced Design

### 3.1 Why FSD

The flat `components/auth/`, `components/chat/`, `components/document/` structure violates the Acyclic Dependency Principle. `ChatPanel` imports from `DocumentPreview`. `OnboardingFlow` imports from `PaywallModal`. These cross-feature imports create a ball of mud — changing one component cascades unpredictably.

FSD enforces a **strict unidirectional import rule**:

```
app → pages → widgets → features → entities → shared
```

Upper layers may import from lower layers. Lower layers may never import from upper layers. Violations are caught by `eslint-plugin-boundaries` at CI time.

### 3.2 Target Directory Structure

```
frontend/src/
│
├── app/
│   ├── main.tsx                  ReactDOM.createRoot + BrowserRouter + Sentry.init
│   ├── App.tsx                   Route tree + AnimatePresence + auth-driven navigation
│   ├── router/
│   │   └── ProtectedRoute.tsx    Three-stage guard: loading → 401 → missing context
│   └── providers/
│       └── StoreProvider.tsx
│
├── pages/                        Route-level shells — NO business logic
│   ├── LandingPage/index.tsx
│   ├── OnboardingPage/index.tsx
│   ├── DashboardPage/index.tsx
│   ├── WorkspacePage/index.tsx
│   └── PaywallPage/index.tsx
│
├── widgets/                      Assembled blocks with wiring — NO API calls
│   ├── TopBar/
│   ├── ResumeEditor/             DocumentPreview · StandardA4Layout
│   ├── ChatSidebar/              ChatPanel
│   └── MacMascot/
│
├── features/                     Self-contained vertical slices
│   ├── auth/
│   │   ├── ui/                   AuthModal · AuthPage
│   │   ├── model/useAuth.ts      onAuthStateChange, syncProfileToStore
│   │   ├── api/authApi.ts        signIn · signOut · signInWithApple (§9)
│   │   └── index.ts
│   ├── ai-coaching/
│   │   ├── ui/                   MessageBubble · ChatInput
│   │   ├── model/useChatStore.ts messages · interviewStep · isGenerating
│   │   ├── api/interviewApi.ts   streamInterviewTurn() — SSE fetch
│   │   └── index.ts
│   ├── document-editor/
│   │   ├── ui/                   EditableBullet · SandwichDiffInline · PaperExpEntry
│   │   ├── model/useDocumentStore.ts  resumeData · pendingDiff · applyDiff
│   │   ├── api/                  rewriteApi.ts · evaluateApi.ts
│   │   └── index.ts
│   ├── ats-scoring/
│   │   ├── ui/                   AtsScoreRing · SkillGapChecklist
│   │   ├── model/useAtsStore.ts
│   │   ├── api/                  atsScoreApi.ts · analyzeApi.ts
│   │   └── index.ts
│   ├── billing/
│   │   ├── ui/                   PaywallModal · PaywallInterceptor · BYOKModal · PremiumWrapper
│   │   ├── model/useBillingStore.ts
│   │   ├── api/checkoutApi.ts
│   │   └── index.ts
│   └── onboarding/
│       ├── ui/OnboardingFlow.tsx
│       ├── model/useOnboardingStore.ts
│       ├── api/                  uploadApi.ts · jobApi.ts
│       └── index.ts
│
├── entities/                     Domain objects — types + pure factories only
│   ├── resume/                   ResumeData · ExperienceEntry · EducationEntry
│   ├── user/                     User · AIActionType
│   ├── chat/                     ChatMessage
│   └── analysis/                 ATSAnalysisResponse · ContextualMatch · DiffProposal
│
└── shared/                       Zero-business-logic
    ├── ui/                       Button · Badge · Card · SessionSpinner
    ├── lib/
    │   ├── supabase.ts           createClient singleton
    │   └── apiClient.ts          fetch wrapper with auth header + 401/402 handling
    ├── config/
    │   ├── i18n.ts               LANGUAGE_LABELS · HR_CONSTRAINTS
    │   └── constants.ts          PATH_POSITION · API_BASE_URL
    └── utils/
        ├── audio.ts
        └── cn.ts
```

### 3.3 Import Rule Enforcement

Add to `frontend/.eslintrc.json`:

```json
{
  "plugins": ["boundaries"],
  "settings": {
    "boundaries/elements": [
      { "type": "app",      "pattern": "src/app/*"      },
      { "type": "pages",    "pattern": "src/pages/*"    },
      { "type": "widgets",  "pattern": "src/widgets/*"  },
      { "type": "features", "pattern": "src/features/*" },
      { "type": "entities", "pattern": "src/entities/*" },
      { "type": "shared",   "pattern": "src/shared/*"   }
    ]
  },
  "rules": {
    "boundaries/element-types": ["error", {
      "default": "disallow",
      "rules": [
        { "from": "app",      "allow": ["pages","widgets","features","entities","shared"] },
        { "from": "pages",    "allow": ["widgets","features","entities","shared"] },
        { "from": "widgets",  "allow": ["features","entities","shared"] },
        { "from": "features", "allow": ["entities","shared"] },
        { "from": "entities", "allow": ["shared"] },
        { "from": "shared",   "allow": [] }
      ]
    }]
  }
}
```

**Cross-feature imports are banned.** `features/ai-coaching` cannot import from `features/document-editor`. Shared data belongs in `entities/` or `shared/`.

### 3.4 `shared/lib/apiClient.ts` — Auth Error Contract

Every authenticated fetch must go through this wrapper. Never call `fetch()` directly in feature API files.

```typescript
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) { useAuthStore.getState().clearAuth(); throw new AuthError(); }
  if (res.status === 402) { useBillingStore.getState().openPaywall(); throw new PaywallError(); }
  if (!res.ok) throw new ApiError(res.status, await res.json());
  return res.json() as T;
}
```

**Rule:** 401 always triggers `clearAuth()`. 402 always triggers `openPaywall()`. These are handled here, never in individual feature API files.

---

## 4. State Management — Zustand Domain Slices

### 4.1 The Problem with the Current Monolith

`store/useAppStore.ts` is ~1 600 lines. It contains auth logic, billing guards, interview state machine, document mutation, ATS scoring, and language settings in a single file.

**Consequences:**
- Every component re-renders on every unrelated state mutation. During SSE streaming (~20 tokens/second), `ChatPanel`, `DocumentPreview`, and `MacMascot` all re-render per token — even components that have nothing to do with the message stream.
- Merge conflicts on every PR because everyone touches the same file.
- Impossible to unit-test document editing without spinning up auth + billing + interview state.

**Immediate mitigation (before full split — apply now):**

```typescript
// BEFORE (re-renders on any store change):
const messages = useAppStore(s => s.messages);
const skillGaps = useAppStore(s => s.skillGaps);

// AFTER (only re-renders when array reference changes):
import { useShallow } from 'zustand/react/shallow';
const messages  = useAppStore(useShallow(s => s.messages));
const skillGaps = useAppStore(useShallow(s => s.skillGaps));
```

Apply `useShallow` to every array and object selector in: `ChatPanel.tsx`, `DocumentPreview.tsx`, `StandardA4Layout.tsx`, `Dashboard.tsx`.

### 4.2 Target: Five Independent Stores

```mermaid
graph TD
    A[useAuthStore] -->|isPremium| B[useBillingStore]
    A -->|user.id| C[useSessionStore]
    C -->|appMode| D[useChatStore]
    C -->|appMode| E[useDocumentStore]
    B -->|isPaywallOpen| D
    D -->|data_extract payload| E
```

#### Store 1: `useAuthStore` — `features/auth/model/useAuthStore.ts`
**Owns:** Session identity, premium status, freemium quota counters, sync.
```
user · isPremium · isAuthLoading · freeRewrites · freeInterviews
isSaving · lastSyncedAt · syncError
setUser · setIsPremium · canUseAI · applyPromoCode
decrementFreeRewrites · decrementFreeInterviews
syncToSupabase · clearCloudData · clearAuth
```

#### Store 2: `useBillingStore` — `features/billing/model/useBillingStore.ts`
**Owns:** Paywall modal, auth modal, checkout state. Reads `canUseAI()` from `useAuthStore` — never duplicates quota logic.
```
isPaywallOpen · paywallContext · isAuthModalOpen · authModalContext · isCheckingOut
openPaywall · closePaywall · openAuthModal · closeAuthModal · startCheckout
```

#### Store 3: `useSessionStore` — `features/onboarding/model/useSessionStore.ts`
**Owns:** App mode, lifecycle status, onboarding path, language preferences.
```
appMode · appStatus · onboardingMode · uploadedResumeText · jobDescription
userLang · resumeLang · isHardcoreMode
transitionTo(status)          ← THE ONLY WAY to change appStatus
setOnboardingMode · setAppMode · clearApplicationContext
setUserLang · setResumeLang · toggleHardcoreMode
```

#### Store 4: `useChatStore` — `features/ai-coaching/model/useChatStore.ts`
**Owns:** Chat messages, interview step machine, SSE streaming state.
```
messages · interviewStep · isGenerating · streamError
addMessage · setMessages · advanceStep · setIsGenerating · clearConversation
```

#### Store 5: `useDocumentStore` — `features/document-editor/model/useDocumentStore.ts`
**Owns:** Live resume document, diff proposals, ATS score.
```
resumeData · pendingDiff · currentAtsScore · realAtsScore
skillGaps · matchedSkills · missingSkills · analysisResult · isAnalyzing · analysisError
updateResumeData · setPendingDiff · applyDiff · rejectDiff · bumpAtsScore
setAnalysisResult · clearDocument
```

### 4.3 Migration Sequence

Execute in order. At each phase, the old `useAppStore` remains alive. New components read the new store; legacy components still read the old one. A temporary adapter hook keeps them in sync during the transition window.

```
Phase 1 (1 day):   Extract useDocumentStore — lowest coupling, no auth deps.
Phase 2 (1 day):   Extract useChatStore.
Phase 3 (1 day):   Extract useBillingStore.
Phase 4 (2 days):  Extract useSessionStore.
Phase 5 (1 day):   Extract useAuthStore (most depended-upon — do last).
Phase 6 (1 day):   Delete useAppStore.ts. Fix all TypeScript errors. Full smoke-test run.
```

**Gate:** All five Playwright smoke tests (§10.3) must pass before and after each phase. If a test fails after extraction, do not merge. The contract is real.

---

## 5. Backend Architecture — Service Layer

### 5.1 Pinned Dependency Versions

**Framework & Runtime**

| Component | Package | Pinned Version |
|---|---|---|
| Web framework | FastAPI | 0.111.0 |
| ASGI server | uvicorn | 0.29.0 |
| Python target | CPython | 3.11 (Docker) |
| Request validation | Pydantic v2 | 2.7.1 |
| Settings management | pydantic-settings | via pydantic |
| JWT validation | PyJWT | 2.12.1 |
| Asymmetric crypto | cryptography | 42.0.8 |
| HTTP client | httpx | latest |

**External Services**

| Service | SDK | Pinned Version |
|---|---|---|
| Supabase (DB + Auth) | supabase-py | 2.4.6 |
| Google Gemini AI | google-generativeai | 0.8.3 |
| Stripe billing | stripe | 9.11.0 |

**Document Parsing**

| Format | Library | Pinned Version |
|---|---|---|
| PDF | PyMuPDF (fitz) | 1.24.2 |
| DOCX | python-docx | 1.1.2 |
| TXT | stdlib + chardet | — |

### 5.2 Current Problem

Routers contain business logic. `payments.py` creates a Supabase client inline on every webhook delivery. `user.py` contains JWT validation, Supabase query logic, AND HTTP response shaping — three responsibilities in one file. Result: cannot unit-test the premium-granting logic without an HTTP stack.

### 5.3 Target Layered Architecture

```mermaid
graph TD
    subgraph "HTTP Layer"
        A[FastAPI Router] -->|validated Pydantic models| B[Service Layer]
    end
    subgraph "Service Layer"
        B --> C[Repository Layer]
        B --> D[External Clients]
    end
    subgraph "Repository Layer"
        C -->|SQL / RPC| E[(Supabase PostgreSQL)]
    end
    subgraph "External Clients"
        D --> F[Gemini SDK]
        D --> G[Stripe SDK]
    end
```

**Rule:** Routers call Services. Services call Repositories or External Clients. Repositories call the DB. No cross-layer skipping.

### 5.4 Target Directory Structure

```
backend/
├── main.py                          App factory ONLY — mounts routers, middleware
├── config.py                        Pydantic BaseSettings (lru_cache singleton)
│
├── routers/                         HTTP boundary — thin controllers (~20 lines each)
│   ├── interview.py                 POST /api/chat/interview
│   ├── evaluate.py                  POST /api/evaluate-edit · /api/ats-score · /api/rewrite-section
│   ├── upload.py                    POST /api/upload-resume
│   ├── job.py                       POST /api/parse-job
│   ├── resumes.py                   POST /api/resumes · GET /api/resumes/{id}
│   ├── payments.py                  POST /api/checkout · POST /api/webhooks/stripe
│   ├── polish.py                    POST /api/resume/final-polish
│   └── user.py                      POST /api/user/save-progress · GET load · DELETE clear
│
├── services/                        Business logic — no HTTP, no DB
│   ├── ai/
│   │   ├── client.py                GeminiClient factory, model config constants
│   │   ├── interview_service.py     stream_interview_turn() → AsyncIterator[SSEEvent]
│   │   ├── rewrite_service.py       rewrite_section() · evaluate_edit()
│   │   ├── polish_service.py        final_polish_resume() + ID integrity check
│   │   └── embeddings_service.py    calculate_ats_score() — cosine similarity
│   ├── billing/
│   │   ├── stripe_service.py        create_checkout_session()
│   │   └── entitlement_service.py   grant_premium(email) · check_premium(user_id)
│   ├── resume/
│   │   └── parser_service.py        parse_pdf() · parse_docx() · parse_txt()
│   └── user/
│       └── progress_service.py      save_progress() · load_progress() · clear_data()
│
├── repositories/                    Data access — only Supabase calls
│   ├── base.py                      get_service_client() singleton (lru_cache)
│   ├── profiles_repo.py             get_profile() · update_premium() · decrement_limit()
│   ├── user_data_repo.py            upsert_user_data() · load_user_data() · delete_user_data()
│   └── resumes_repo.py              insert_resume() · get_resume_by_id()
│
└── dependencies/
    ├── auth.py                      get_authenticated_user_id — JWT waterfall (§6)
    └── limits.py                    check_action_limit() factory · LimitContext
```

### 5.5 Router Thinning — Before / After

**BEFORE** (`payments.py` — 180 lines of mixed concerns):
```python
@router.post("/checkout")
async def create_checkout_session(body, settings):
    stripe.api_key = settings.stripe_secret_key   # ← infra in router
    price_id = settings.stripe_price_pass_id       # ← config lookup in router
    session = stripe.checkout.Session.create(...)  # ← external call in router
    return CheckoutResponse(url=session.url, ...)
```

**AFTER** (`routers/payments.py` — ~20 lines):
```python
@router.post("/checkout", response_model=CheckoutResponse)
async def create_checkout_session(
    body: CheckoutRequest,
    settings: Settings = Depends(get_settings),
) -> CheckoutResponse:
    return await stripe_service.create_checkout_session(
        plan=body.plan, user_email=body.user_email,
        success_url=body.success_url, cancel_url=body.cancel_url,
        settings=settings,
    )
```

### 5.6 API Endpoint Reference

| Method | Path | Auth | Rate Gate | Notes |
|---|---|---|---|---|
| GET | `/health` | None | None | `{status:"ok", version, environment}` |
| POST | `/api/upload-resume` | None | None | PDF/DOCX/TXT ≤5 MB; never written to disk; returns `{resume_data, plain_text}` |
| POST | `/api/parse-job` | None | None | URL scrape or raw text; always HTTP 200 with `success` flag |
| POST | `/api/analyze` | None | None | ATS scoring + Mac greeting; returns `ATSAnalysisResponse` |
| POST | `/api/evaluate-edit` | None | None | Gemini temp=0.0; fail-open → `{approved:true}` on error |
| POST | `/api/ats-score` | None | None | text-embedding-004 cosine similarity; fail-safe → `{score:0}` on error |
| POST | `/api/rewrite-section` | None | None | Returns `{old_text, new_text, predicted_score_increase[3-8]}` for Sandwich diff UI |
| POST | `/api/chat/interview` | ✅ JWT | `interview` | SSE stream; BYOK; mid-session pivot injection |
| POST | `/api/resume/final-polish` | ✅ JWT | `rewrite` | Gemini temp=0.3; section ID integrity check; HTTP 422 on ID mismatch |
| POST | `/api/user/save-progress` | ✅ JWT | None | UPSERT `user_data`; `id` always from JWT |
| GET | `/api/user/load-progress` | ✅ JWT | None | Returns full `user_data` row |
| DELETE | `/api/user/clear-data` | ✅ JWT | None | Deletes `user_data` row |
| POST | `/api/resumes` | ✅ JWT | None | HTTP 201; `user_id` always from JWT |
| GET | `/api/resumes/{id}` | ✅ JWT | None | 404 if resume belongs to different user |
| POST | `/api/checkout` | None | None | Stripe Checkout Session; returns `{url, session_id}` |
| POST | `/api/webhooks/stripe` | HMAC-SHA256 | None | Signature verified before any processing; always HTTP 200 |

⚠️ **Revenue leak — `POST /api/user/decrement-limit` is missing.** The `decrement_free_limit()` RPC exists in Postgres. The `LimitContext.consume()` method calls it correctly. But there is no HTTP endpoint exposing the decrement. Free-tier users are not having their quotas consumed server-side — they could exhaust the frontend counter and refresh to get unlimited AI access. **This is P0. Add the endpoint.**

### 5.7 Database Schema

**`public.profiles`** — who the user IS (identity, tier, billing, quotas)

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid PK | — | FK → `auth.users(id)` CASCADE |
| `email` | text | null | Mirrors auth email; used by Stripe webhook lookup |
| `is_premium` | boolean | `false` | **Source of truth for tier** |
| `premium_plan` | text | null | `'pass'` \| `'monthly'` |
| `stripe_customer_id` | text | null | Set on first purchase |
| `free_rewrites_left` | integer | `3` | CHECK ≥ 0 |
| `free_interviews_left` | integer | `1` | CHECK ≥ 0 |
| `created_at` | timestamptz | `now()` | Immutable |
| `updated_at` | timestamptz | `now()` | Auto-bumped by trigger |

**`public.user_data`** — what the user has BUILT (draft, history, score)

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid PK | — | FK → `auth.users(id)` CASCADE |
| `resume_data` | jsonb | `{}` | Full Zustand `ResumeData` |
| `analysis_result` | jsonb | null | `ATSAnalysisResponse`; null until first run |
| `chat_history` | jsonb | `[]` | `[{role, content}]` |
| `is_premium` | boolean | `false` | **Denormalized mirror** of `profiles.is_premium` only for fast hydration reads |
| `updated_at` | timestamptz | `now()` | Auto-bumped |

> ⚠️ **`user_data.is_premium` consistency risk.** Only the Stripe webhook updates this. A missed webhook creates divergence. Frontend must always treat `profiles.is_premium` as authoritative.

**`public.resumes`** — named resume snapshots

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` | — |
| `user_id` | uuid | — | FK → `auth.users(id)`; always from JWT |
| `job_title` | text | null | Denormalized for listing |
| `content_json` | jsonb | `{}` | Full resume snapshot |
| `current_ats_score` | integer | null | 0–100 |
| `job_description` | text | null | JD this resume was tailored to |
| `created_at` | timestamptz | `now()` | Immutable |
| `updated_at` | timestamptz | `now()` | — |

⚠️ **No migration file found for `public.resumes`.** The `POST /api/resumes` router exists. Either the table was created manually (not version-controlled) or the router stubs will 500 in production. Add `supabase/migrations/20240324000000_resumes.sql` or delete the router.

**RPC: `decrement_free_limit(user_id UUID, limit_col TEXT) RETURNS INTEGER`**
1. Validates `limit_col` against allowlist `{'free_rewrites_left', 'free_interviews_left'}` — SQL injection prevention.
2. Atomic `UPDATE profiles SET {limit_col} = {limit_col} - 1 WHERE id = user_id RETURNING {limit_col}`.
3. CHECK constraint fires on race condition — caught and logged, never re-raised.
4. REVOKED from `authenticated` and `anon` roles — service role key only.

### 5.8 Freemium Limit Enforcement — `dependencies/limits.py`

`check_action_limit(action_type)` is a FastAPI dependency factory. It:
1. Authenticates the user via `get_authenticated_user_id` sub-dependency.
2. Fetches `profiles` using the service-role key (bypasses RLS).
3. Premium fast path: returns `LimitContext(is_premium=True, remaining=-1)` immediately.
4. Free-tier gate: if counter ≤ 0 → HTTP 402 `{code: "LIMIT_EXHAUSTED", action, message, upgrade_url}`.
5. Returns `LimitContext` with `consume()` method.

`LimitContext.consume()` — call exactly once, **after** a successful Gemini response, only when `byok_api_key` is absent. Calls `decrement_free_limit` RPC. All exceptions caught and logged at WARNING — the user already received their answer.

**Fail-open policy:** If the profiles query fails (DB blip, network error), the request is allowed through. An attacker exploiting this gets a few free AI calls — far less harmful than a global outage. The CHECK constraint is the hard floor.

### 5.9 Stripe Webhook — HMAC-SHA256 Verification

The webhook endpoint is the most security-sensitive route in the backend. Without signature verification, an attacker can send a fake `checkout.session.completed` event and grant themselves unlimited free access.

**How Stripe signs events:**
1. Stripe computes: `HMAC-SHA256(STRIPE_WEBHOOK_SECRET, timestamp + "." + raw_payload)`
2. Sets `Stripe-Signature` header: `t=<unix_timestamp>,v1=<hex_signature>`
3. Backend re-computes the same signature and compares using constant-time equality.
4. Events older than 300 seconds are rejected (replay attack prevention).

**Why `request.body()` must be used — never `body: dict`:**  
FastAPI's JSON body parsing decodes and re-encodes the payload, potentially altering byte ordering and breaking the HMAC. The raw bytes Stripe signed must be preserved exactly.

```python
# routers/payments.py — CORRECT
@router.post("/api/webhooks/stripe")
async def stripe_webhook(request: Request, ...) -> dict:
    payload = await request.body()           # raw bytes — never request.json()
    event = stripe.Webhook.construct_event(
        payload=payload,
        sig_header=stripe_signature,
        secret=settings.stripe_webhook_secret,
    )
    # construct_event raises SignatureVerificationError on any mismatch
```

**Error policy:** Return `HTTP 200 {"received": false}` on ALL errors — never 5xx. A 5xx causes Stripe to retry the event repeatedly, flooding logs. The payment is captured on Stripe's side; reconcile via the Stripe dashboard.

**Gemini model table:**

| Endpoint | Model | Temperature | Purpose |
|---|---|---|---|
| `/api/chat/interview` | `gemini-2.5-flash` | 0.7 | Conversational coaching, SSE streaming |
| `/api/evaluate-edit` | `gemini-2.5-flash` | 0.0 | Deterministic quality gate |
| `/api/rewrite-section` | `gemini-2.5-flash` | default | ATS-optimised bullet rewriting |
| `/api/resume/final-polish` | `gemini-2.5-flash` | 0.3 | Full-resume polish |
| `/api/ats-score` | `text-embedding-004` | n/a | Cosine similarity scoring |

---

## 6. Authentication Contract

### 6.1 JWT Validation — Three-Strategy Waterfall

`get_authenticated_user_id` in `dependencies/auth.py` peeks at the JWT `alg` header and dispatches to one of three strategies. The dependency raises `HTTP 401` if all three fail.

```
Token arrives via Authorization: Bearer <token>
         │
         ▼
peek header → alg = ?
         │
         ├─ "HS256" ──────────────────────────── Strategy A (fastest)
         │   pyjwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"])
         │   Speed: ~0.1 ms  |  Network: zero
         │   Supabase JWT Secret ≠ service role key.
         │   Get from: Supabase → Settings → API → JWT Secret
         │   Fails hard — wrong sig = forged token, no fallback
         │
         ├─ "RS256" or "ES256" ───────────────── Strategy B  ← MOST Supabase projects
         │   Tier 1: _asymmetric_key_cache[kid]
         │           Speed: <1 µs  |  Network: zero after warm
         │   Tier 2: PyJWKClient (lru_cache, 1 h TTL)
         │           Fetches: {SUPABASE_URL}/auth/v1/.well-known/jwks.json
         │           Speed: ~2 ms on JWKS hit  |  Network: once per restart
         │   pyjwt.decode(token, signing_key.key, algorithms=["RS256","ES256"])
         │   Falls through to C only if JWKS endpoint unreachable
         │
         └─ anything else ─────────────────────── Strategy C  (slowest)
             supabase.auth.get_user(token) — API round-trip
             Speed: 50–150 ms PER REQUEST
             lru_cache(maxsize=1) Supabase client reused across requests
```

### 6.2 🔴 P0 — The ES256 Gap

**What's happening:** Supabase projects created after mid-2024 increasingly default to **ES256** (ECDSA P-256). The original code has `if alg == "RS256":` — an exact-match guard. An ES256 token falls straight to Strategy C and pays 50–150 ms on every request.

**Why Strategy A doesn't catch it:** `SUPABASE_JWT_SECRET` is a symmetric HS256 secret. ES256 is asymmetric — verifying it with the HS256 secret will always raise `InvalidAlgorithmError`.

**Packages required:** Already installed — PyJWT 2.12.1 + cryptography 42.0.8. No new packages needed.

**The exact three-line fix in `dependencies/auth.py` (or `routers/user.py`):**

```python
# ── Line ~230 — algorithm routing ────────────────────────────────────────────
# BEFORE:
if alg == "RS256":
# AFTER — handle both RSA and EC asymmetric algorithms via JWKS:
if alg in ("RS256", "ES256"):

# ── Tier 1 cache hit decode ───────────────────────────────────────────────────
# BEFORE:
payload = pyjwt.decode(token, cached_key, algorithms=["RS256"], audience="authenticated")
# AFTER:
payload = pyjwt.decode(token, cached_key, algorithms=["RS256", "ES256"], audience="authenticated")

# ── Tier 2 JWKS fetch decode ─────────────────────────────────────────────────
# BEFORE:
payload = pyjwt.decode(token, signing_key.key, algorithms=["RS256"], audience="authenticated")
# AFTER:
payload = pyjwt.decode(token, signing_key.key, algorithms=["RS256", "ES256"], audience="authenticated")

# ── Cache variable rename (optional but clarifying) ───────────────────────────
# BEFORE:
_rs256_key_cache: dict[str, Any] = {}
# AFTER:
_asymmetric_key_cache: dict[str, Any] = {}   # covers RS256 + ES256
```

**Why it works:** `PyJWKClient.get_signing_key_from_jwt()` returns whichever key matches the `kid` in the token header — it handles RSA and EC key types transparently. Adding `"ES256"` to the algorithms list tells PyJWT to accept either algorithm; the actual algorithm is still validated against the token header, so there is no security downgrade.

**Expected improvement after fix:**  
Auth overhead: `150 ms + 10 ms (Pi)` → `~0.2 ms + 10 ms`. A **15× latency reduction** before the AI pipeline starts.

### 6.3 Frontend JWT Contract

```typescript
// Every authenticated request uses shared/lib/apiClient.ts
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;
// token is always sent as: Authorization: Bearer <token>
```

`useAuth.ts` dual-path initialization:
- **Path A:** `supabase.auth.getSession()` — reads localStorage directly; always fires; does not depend on Supabase event system.
- **Path B:** `onAuthStateChange()` — covers `INITIAL_SESSION`, `SIGNED_IN`, `TOKEN_REFRESHED`, `SIGNED_OUT`.
- **Dedup:** `syncComplete` flag — whichever path fires first with a live session wins; second path skips `syncProfileToStore`.
- **3-second safety timer:** Unblocks the app if both paths fail (misconfigured SDK, network down, CSP block).

```
Events handled:
  getSession()     → syncProfileToStore + setIsAuthLoading(false)  [primary]
  INITIAL_SESSION  → syncProfileToStore + setIsAuthLoading(false)  [backup]
  SIGNED_IN        → syncProfileToStore + setIsAuthLoading(false)  [new login]
  TOKEN_REFRESHED  → syncProfileToStore (loadSavedProgress guard skips if data exists)
  SIGNED_OUT       → clearAuth()
```

---

## 7. AI Pipeline

### 7.1 Interview SSE Flow

```mermaid
sequenceDiagram
    participant UI as ChatPanel
    participant API as POST /api/chat/interview
    participant LG as check_action_limit
    participant SVC as interview_service
    participant GEM as Gemini 2.5 Flash

    UI->>API: {messages, resume_data, job_description, settings, byok_api_key?}
    API->>LG: check quota (interviews_left > 0 OR is_premium)
    LG-->>API: LimitContext OR HTTP 402
    API->>SVC: stream_interview_turn(...)
    SVC->>GEM: generate_content_async(stream=True)
    loop SSE stream
        GEM-->>SVC: token chunk
        SVC-->>UI: data: {"type":"token","content":"..."}
    end
    SVC-->>UI: data: {"type":"data_extract","payload":{fieldPath,oldText,newText,...}}
    Note over UI: ChatPanel fires POST /api/evaluate-edit concurrently
    SVC-->>UI: data: {"type":"done"}
    API->>LG: enforcer.consume() [only if !byok AND stream succeeded]
```

### 7.2 Fail Contracts

| Scenario | Behaviour |
|---|---|
| Gemini error mid-stream | Emit `{"type":"error"}` event. Do NOT call `consume()`. User may retry. |
| `check_action_limit` fails | HTTP 402 before stream starts. No tokens emitted. |
| `consume()` throws | Log at WARNING. Do not fail the response. User already received their answer. |
| BYOK key supplied | Gemini initialised with user's key. `consume()` is always skipped. |

### 7.3 Mid-Session Pivot Injection

When `settings_changed=True` in the request body, a synthetic exchange is injected into conversation history before the Gemini call:

```python
[
    {"role": "user",      "content": "Please switch to {language}, {tone} mode."},
    {"role": "assistant", "content": "Understood. Switching now."},
]
```

This forces Gemini to apply the new language/persona immediately without confusing it with an abrupt instruction mid-conversation.

### 7.4 Sandwich Diff — Data Flow

```
POST /api/rewrite-section
  → { old_text, new_text, predicted_score_increase: int[3-8] }
  → useDocumentStore.setPendingDiff({ fieldPath, oldText, newText, predictedScoreIncrease, baselineScore })
  → SandwichWorkspace renders amber banner
  → EditableBullet renders SandwichDiffInline inline below targeted bullet
  → User clicks Accept → applyDiff() writes newText to resumeData → bumpAtsScore(delta)
  → User clicks Reject → rejectDiff() clears pendingDiff
```

`fieldPath` encoding:
- `'summary'` → `resumeData.summary`
- `'targetTitle'` → `resumeData.targetTitle`
- `'experiences.{expId}.responsibilities.{idx}'` → specific bullet

### 7.5 BYOK Easter Egg

Clicking the `PaywallModal` title 3× within 1.5 seconds opens `BYOKModal`. User pastes their Gemini API key. Key is stored in `useChatStore` only — never persisted to Supabase or sent to the backend except as the `byok_api_key` field in interview requests. `enforcer.consume()` is always skipped for BYOK users.

---

## 8. Scaling & Maintenance Strategy (The Forever Plan)

### 8.1 Bottleneck Priority Matrix

Address in order. Do not start P1 while a P0 is open.

| Priority | Task | Impact | Effort |
|---|---|---|---|
| 🔴 P0 | ES256 JWT fix (§6.2) | 15× auth latency improvement; every endpoint affected | 5 min |
| 🔴 P0 | Add `POST /api/user/decrement-limit` endpoint | Closes revenue leak — free-tier quotas not being consumed | 30 min |
| 🟠 P1 | `useShallow` on all store array/object selectors | Eliminates streaming re-render churn; enables true 60 fps | 45 min |
| 🟠 P1 | `src/lib/logger.ts` + replace 68 `console.log` calls | Clean prod build; removes PII (auth tokens, user IDs) from console | 1 h |
| 🟡 P2 | TopBar `.glass-dark` variant in workspace zone | Visual consistency; `.glass` (white) over `.midnight` (dark) is jarring | 20 min |
| 🟡 P2 | `public.resumes` migration file | Unblocks multi-resume feature; router stubs 500 without it | 20 min |
| 🟡 P2 | Execute §4.3 Zustand store split | Eliminates merge conflicts; enables isolated testing | 1 week |
| 🟢 P3 | `app.state` Supabase/Stripe singleton in `main.py` | Eliminates per-request client instantiation; minor perf | 1 h |
| 🟢 P3 | Nginx config for Pi | Production TLS termination; required before public launch | 2 h |

### 8.2 Dead Wood Inventory

**🔴 Revenue leak — missing decrement endpoint**  
`decrement_free_limit()` RPC is battle-hardened in SQL. `canUseAI()` in the frontend works correctly. No HTTP endpoint exposes the decrement. Free-tier users can reset their local counter by refreshing and continue using AI features indefinitely. Add the endpoint.

**🟡 `console.log` pollution — 68 occurrences**

| File | Count | Risk |
|---|---|---|
| `store/useAppStore.ts` | 34 | Synchronous I/O on every state mutation during 20 fps SSE streaming |
| `hooks/useAuth.ts` | 28 | **Logs auth tokens and user IDs** — PII in the browser console in production |
| `hooks/useAutoSave.ts` | 2 | Low |
| `components/onboarding/OnboardingFlow.tsx` | 2 | Low |
| `components/document/DocumentPreview.tsx` | 2 | Low |

Create `src/shared/lib/logger.ts`:
```typescript
const isDev = import.meta.env.DEV;
export const logger = {
  debug: (...args: unknown[]) => isDev && console.debug('[JIF]', ...args),
  warn:  (...args: unknown[]) => console.warn('[JIF]', ...args),
  error: (...args: unknown[]) => console.error('[JIF]', ...args),
};
```
Replace all `console.log` calls with `logger.debug`. Vite's tree-shaker eliminates dead branches in the production bundle.

**🟡 `backend/main.py` unresolved TODOs**
```python
# Line 80: TODO (Task 4): initialise Supabase client and attach to app.state
# Line 81: TODO (Task 5): register Stripe webhook secret
```
The Supabase client and Stripe secret are constructed per-request inside routers. Not broken, but creates unnecessary object instantiation overhead on every request. Move to `app.state` in the lifespan hook.

**🟡 `DEBUG startup: SUPABASE_KEY` print in `main.py`**  
Leaks key prefix to any log aggregator. Remove after auth is confirmed stable in production.

**🟢 `user_data.is_premium` denormalization risk**  
Only the Stripe webhook updates this column. A missed webhook creates divergence with `profiles.is_premium`. The frontend already treats `profiles.is_premium` as authoritative — this is documented and acceptable as a fast-hydration shortcut. Risk is minor as long as the Stripe webhook is reliable.

**🟢 No unused components or legacy CSS detected.**  
All 16 components are referenced in the routing tree. `index.css` is the only stylesheet. Zero `.scss` files. Zero `any` TypeScript annotations in production code — maintain this.

### 8.3 Pi Resource Management

**Docker resource limits** — enforce or the Pi will OOM-kill uvicorn with no log entry:

```yaml
# docker-compose.yml
deploy:
  resources:
    limits:
      memory: 512M      # Hard cap. Peak load (2 Gemini streams + PyMuPDF) = ~380 MB RSS.
      cpus: "2.0"       # Leave 2 cores for OS + Nginx
    reservations:
      memory: 128M

logging:
  driver: "json-file"
  options:
    max-size: "10m"     # Rotate at 10 MB
    max-file: "5"       # Max 50 MB of Docker logs on disk
```

Memory budget (Pi 5, 8 GB SKU):
```
OS + kernel + daemons:    ~400 MB
jobifai-backend (limit):   512 MB
nginx:                      64 MB
node-exporter:              32 MB
Docker daemon overhead:    ~150 MB
Filesystem cache:          ~200 MB
──────────────────────────────────
Reserved:                ~1,358 MB
Headroom:                ~2,700 MB
```

If `docker compose ps` shows `Exited (137)` (OOM-killed): reduce `--workers` in Dockerfile CMD from `2` to `1`. Cuts idle RSS from ~180 MB to ~110 MB.

**Swap monitoring cron** (`/etc/cron.d/jobifai-health`):
```cron
*/5 * * * * root /usr/local/bin/jobifai-health-check.sh >> /var/log/jobifai-health.log 2>&1
```

```bash
#!/bin/bash
SWAP_USED=$(free -m | awk '/^Swap:/{print $3}')
DISK_USED=$(df / | awk 'NR==2{print $5}' | tr -d '%')
echo "$(date -Is) swap=${SWAP_USED}MB disk=${DISK_USED}%"
[ "$SWAP_USED" -gt 200 ] && docker restart jobifai-backend
[ "$DISK_USED" -gt 85 ] && docker image prune -f && journalctl --vacuum-size=100M
```

### 8.4 Zero-Downtime Migrations — Four-Phase Protocol

Never combine Phase 1 and Phase 4 in one migration file. Never skip phases.

```
Phase 1 — ADD (deploy):    ALTER TABLE profiles ADD COLUMN premium_tier TEXT;
                            ← old code ignores it; no downtime
Phase 2 — BACKFILL:        UPDATE profiles SET premium_tier = CASE WHEN ...
Phase 3 — CUTOVER (deploy): new code writes new column; both columns exist
Phase 4 — DROP (deploy):   ALTER TABLE profiles DROP COLUMN premium_plan;
                            ← only after Phase 3 has been stable for ≥1 deployment
```

**Pre-migration checklist:**
```
□ Migration reviewed for column drops (4-phase applied?)
□ Migration reviewed for NOT NULL additions (backfill complete?)
□ RPC allowlist updated if column names changed?
□ Old code not yet deployed to prod?
□ Supabase backup taken (Dashboard → Database → Backups → Create now)?
□ Migration tested on local Supabase CLI with seed data?
```

**Migration file naming convention:**
```
supabase/migrations/
  YYYYMMDDHHMMSS_<description>.sql   ← timestamp prefix, immutable after apply
```

### 8.5 Observability Roadmap

```
Now (current):         Python stdlib logging + Docker json-file rotation
                       grep /var/log/jobifai/api.log

Next (>100 DAU):       structlog JSON logs → Grafana Loki via promtail sidecar

Later (>1000 DAU):     OpenTelemetry traces → Tempo
                       Alert: p95 latency > 3 s on /api/chat/interview

Pi-specific (add now): prom/node-exporter:latest on 127.0.0.1:9100
                       Dashboard: CPU temp, memory pressure, swap, disk I/O
                       Alert: CPU temp > 70°C (throttling threshold for Pi 5 Cortex-A76)
```

### 8.6 Post-Release Checklist

Run after every production deployment. Do not merge the next PR until all items are green.

```
INFRASTRUCTURE
□ GET /health → {"status":"ok"} with new version string
□ docker stats: memory < 300 MB, CPU < 30% at rest
□ free -m: swap < 50 MB
□ df -h /: disk < 70%

FUNCTIONAL SMOKE TEST
□ Upload PDF → structured JSON returned, no 500
□ Paste job URL → description parsed
□ ATS score returned in 0–100 range
□ Interview SSE → at least one token event, stream closes with "done"
□ Rewrite endpoint → diff payload with old_text/new_text
□ Save progress → 200 OK; data persists across hard refresh

BILLING
□ Stripe test checkout session creates (STRIPE_SECRET_KEY valid)
□ Webhook endpoint returns {"received":true} on Stripe dashboard test ping

AUTH
□ Sign-in flow completes; JWT received; load-progress returns data
□ Expired token returns 401, not 500
□ JWKS connectivity: curl {SUPABASE_URL}/auth/v1/.well-known/jwks.json → keys array

LOGS
□ No ERROR-level entries in docker logs for past 10 minutes
□ No unhandled exception tracebacks visible
□ Log rotation active: ls -lh /var/log/jobifai/ → files < 10 MB each
```

---

## 9. App Store & Cross-Platform Strategy

### 9.1 UI Agnosticism — FSD Enables Free React Native Port

```mermaid
graph TD
    subgraph "Platform-Specific — must rewrite"
        W[widgets/] --> P[pages/] --> A[app/]
    end
    subgraph "Platform-Agnostic — port as-is"
        F[features/ — model + api]
        E[entities/]
        S[shared/lib + shared/config]
    end
    W --> F --> E --> S
```

**Green layer (zero changes for React Native):**
- All 5 Zustand stores — no DOM imports
- All `*Api.ts` files — plain `fetch()`, works via `react-native-fetch-api`
- All `entities/*/types.ts` — pure TypeScript
- `shared/lib/supabase.ts` — `@supabase/supabase-js` has RN build target
- `shared/config/`, `shared/utils/` — zero DOM dependencies

**Red layer (must rewrite):**
- `widgets/` — `<div>` → `<View>`, Tailwind → StyleSheet
- `pages/` — React Router → React Navigation
- `app/` — `AppRegistry` replaces `ReactDOM.createRoot`
- Framer Motion → `react-native-reanimated`
- Lucide icons → `react-native-vector-icons`

**Blocker check:** If any Zustand action imports a React component, that is a layering violation that blocks the port. `eslint-plugin-boundaries` catches it.

### 9.2 Apple App Store Compliance — Non-Negotiable

#### Sign in with Apple — App Store Rule 4.8

Any app offering third-party sign-in must offer SIWA with equal prominence. Current `useAuth.ts` has Google OAuth and magic link. SIWA is missing. Binary rejection criterion.

```typescript
// features/auth/api/authApi.ts — ADD THIS
export async function signInWithApple(): Promise<void> {
  await supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      scopes: 'name email',
    },
  });
}
```

Implementation checklist:
```
□ Enable Apple provider: Supabase Dashboard → Auth → Providers → Apple
  (Requires Apple Developer account, Services ID, .p8 private key)
□ Add signInWithApple() to features/auth/api/authApi.ts
□ Render Apple button ABOVE Google button in AuthModal.tsx
□ Apple button spec: background #000000, white Apple glyph, text "Sign in with Apple",
  min height 44pt, no modifications
□ For React Native: use @invertase/react-native-apple-authentication
  (OAuth redirect not permitted on iOS; native StoreKit credential flow required)
□ No backend changes: JWT waterfall already handles ES256 (Apple signs with ES256 via
  https://appleid.apple.com/auth/keys); Supabase proxies this transparently
```

#### Apple In-App Purchases — App Store Rule 3.1.1

Digital goods sold inside an iOS app **must use Apple IAP**. Stripe cannot process in-app payments for digital subscriptions on iOS. Continued violation after warning → permanent developer account termination.

| Product | Web | iOS |
|---|---|---|
| 24-Hour Pass ($4.99) | Stripe `POST /api/checkout` | Apple IAP non-consumable |
| Monthly Pro ($14.99) | Stripe `POST /api/checkout` | Apple IAP auto-renewable subscription |
| BYOK | No payment | Exempt |

**Required new endpoint:** `POST /api/iap/verify-apple`
- Body: `{ receipt_data: string }` — StoreKit 2 signed transaction payload
- Auth: ✅ JWT required; `user_id` always from JWT
- Logic: POST to `https://buy.itunes.apple.com/verifyReceipt`, verify `status == 0` and `bundle_id == "xyz.wealthifai.cv"`, call `entitlement_service.grant_premium()`
- New service: `services/billing/apple_iap_service.py`

**Server-to-server Apple notifications:** Register `POST /api/webhooks/apple` in App Store Connect (v2 notifications). Handle `DID_RENEW` → `is_premium = true`; `EXPIRED`/`REVOKE` → `is_premium = false`.

Stripe remains active for web. Do not remove it.

---

## 10. Paranoia Protocol (Observability & Recovery)

### 10.1 SD Card Survival — Automated Daily Backups

The Raspberry Pi SD card fails within 6–18 months under continuous Docker write load. A failure without off-site backups = total, permanent data loss for every user.

**`/usr/local/bin/jobifai-backup.sh`:**
```bash
#!/bin/bash
set -euo pipefail
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/var/backups/jobifai"
LOG="/var/log/jobifai-backup.log"
mkdir -p "$BACKUP_DIR"

# 1. Database dump (SUPABASE_DB_URL: postgresql://postgres:[pw]@db.[ref].supabase.co:5432/postgres)
pg_dump "$SUPABASE_DB_URL" --no-owner --no-acl --format=plain \
  | gzip -9 > "${BACKUP_DIR}/db_${TIMESTAMP}.sql.gz"

# 2. .env encrypted backup (BACKUP_ENCRYPT_KEY: openssl rand -hex 32, store off-Pi)
openssl enc -aes-256-cbc -salt -pbkdf2 \
  -in /home/pi/jobifai/.env \
  -out "${BACKUP_DIR}/env_${TIMESTAMP}.enc" \
  -pass "env:BACKUP_ENCRYPT_KEY"

# 3. Push to remote via Rclone (Google Drive / S3 / Backblaze B2 / SFTP)
rclone copy "$BACKUP_DIR" "jobifai-backup:jobifai/backups/" \
  --include "*.gz" --include "*.enc" >> "$LOG" 2>&1

# 4. Prune local backups older than 14 days
find "$BACKUP_DIR" -name "*.gz" -mtime +14 -delete
find "$BACKUP_DIR" -name "*.enc" -mtime +14 -delete

echo "[$(date -Is)] Backup complete" >> "$LOG"
```

Cron (`/etc/cron.d/jobifai-backup`) — daily at 03:00 AM:
```cron
0 3 * * * root SUPABASE_DB_URL="postgresql://..." BACKUP_ENCRYPT_KEY="..." /usr/local/bin/jobifai-backup.sh
```

**Recovery:**
```bash
rclone copy "jobifai-backup:jobifai/backups/" /var/restore/
openssl enc -d -aes-256-cbc -pbkdf2 -in /var/restore/env_*.enc \
  -out /home/pi/jobifai/.env -pass "env:BACKUP_ENCRYPT_KEY"
gunzip -c /var/restore/db_*.sql.gz | psql "$SUPABASE_DB_URL"
```

**Weekly decryption test** (automate monthly):
```bash
LATEST=$(ls -t /var/backups/jobifai/*.enc | head -1)
openssl enc -d -aes-256-cbc -pbkdf2 -in "$LATEST" \
  -pass "env:BACKUP_ENCRYPT_KEY" | head -c 50
# Must print "SUPABASE_URL=..." — not binary garbage
```

### 10.2 Frontend Error Tracking — Sentry

Zero production error visibility currently. A null pointer in `StandardA4Layout`, a Zustand hydration failure, or a silently-dropped SSE parse event generates no signal.

```bash
cd frontend && npm install @sentry/react
```

`frontend/src/app/main.tsx`:
```typescript
import * as Sentry from "@sentry/react";
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_APP_VERSION,    // set in CI: git rev-parse --short HEAD
  sampleRate: import.meta.env.MODE === "production" ? 1.0 : 0.0,
  tracesSampleRate: 0.10,
  beforeSend(event) {
    if (event.user) { delete event.user.email; delete event.user.ip_address; }
    return event;
  },
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      sessionSampleRate: 0.10,
      errorSampleRate: 1.0,
      maskAllText: true,     // resume content must never appear in replays
      blockAllMedia: true,
    }),
  ],
});
```

`App.tsx` — one line change for route-aware transaction names:
```typescript
const SentryRoutes = Sentry.withSentryReactRouterV6Routing(Routes);
// Replace <Routes> with <SentryRoutes>
```

**Required Sentry alerts:**

| Alert | Condition | Action |
|---|---|---|
| New issue | First occurrence | Email |
| Error spike | >10 occurrences / hour | Email + Slack |
| Store crash | Error contains "useAppStore" | Email — migration regression |
| SSE parse failure | Error in `interviewApi.ts` | Email |
| Hydration failure | Error in `loadSavedProgress` | Email — data loss risk |

**Silent failures Sentry will catch that logs cannot:**
- `resumeData.experiences` null pointer in `StandardA4Layout` — blank document, no console error in prod build
- Zustand selector returning `undefined` after store refactor — `undefined.toFixed()` in ATS score ring
- `JSON.parse()` failure on malformed `data_extract` SSE event — Mac responds but document never updates
- `useNavigate()` called outside `BrowserRouter` — white screen suppressed by error boundary
- `supabase.auth.getSession()` throwing on corrupted localStorage — user permanently locked out silently

Add to `.env.example`:
```
VITE_SENTRY_DSN=https://xxx@xxx.ingest.sentry.io/xxx
VITE_APP_VERSION=   # Set in CI: git rev-parse --short HEAD
```

### 10.3 Refactoring Safety Net — Playwright E2E

**Directive:** No PR touching `useAppStore.ts` or any extracted store (§4 migration) merges without all smoke tests passing. Enforced via branch protection on `main`.

```bash
cd frontend
npm install -D @playwright/test
npx playwright install chromium
```

`frontend/playwright.config.ts`:
```typescript
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'on-first-retry' },
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

**Five required smoke tests (`frontend/e2e/smoke.spec.ts`):**

| # | Test | Guards |
|---|---|---|
| 1 | Landing → AuthModal opens → Google + Apple buttons visible | Auth layer, SIWA presence (§9.2) |
| 2 | Upload PDF → structured resume in preview → ATS score renders (not NaN, not 0) | `useDocumentStore` + `useSessionStore` handoff |
| 3 | Mock SSE stream → token bubbles appear → mascot: processing → talking → idle | `useChatStore` + SSE parser |
| 4 | Seed `pendingDiff` → amber banner → Accept → `newText` in bullet → banner gone | `useDocumentStore.applyDiff()` + AnimatePresence |
| 5 | Mock 402 on interview → PaywallInterceptor opens → ✕ closes → document preserved | `useBillingStore` + state preservation contract |

`.github/workflows/ci.yml`:
```yaml
e2e:
  runs-on: ubuntu-latest
  needs: [typecheck, lint]
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '20' }
    - run: npm ci
      working-directory: frontend
    - run: npx playwright install --with-deps chromium
      working-directory: frontend
    - run: npx playwright test e2e/smoke.spec.ts
      working-directory: frontend
      env: { CI: true }
    - uses: actions/upload-artifact@v4
      if: failure()
      with: { name: playwright-report, path: frontend/playwright-report/ }
```

If any smoke test fails after a store change: **do not merge**. Do not mark it flaky. The contract is real.

---

## 11. Infrastructure & One-Click Deployment

### 11.1 `docker-compose.yml` Is the Absolute Single Source of Truth

Every service configuration — ports, memory limits, restart policies, health checks, environment injection, log rotation — lives in `docker-compose.yml`. No exceptions.

**Prohibited:**
- `docker run` with manually typed flags. It does not survive a Pi reboot.
- Editing `/etc/nginx/nginx.conf` directly on the Pi. Nginx config belongs in `nginx/` in the repo.
- Setting env vars with `export` in a shell session. Variables live in `.env`.
- `docker restart` as a substitute for `deploy.sh`. Restart without rebuild = stale code.

Every service added to `docker-compose.yml` must include: `restart`, `deploy.resources.limits.memory`, `logging` with `max-size` and `max-file`. No exceptions.

### 11.2 Canonical `docker-compose.yml`

```yaml
services:

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
      platforms:
        - linux/arm64              # Non-negotiable for Pi 5
    image: jobifai-backend:latest
    container_name: jobifai-backend
    restart: unless-stopped
    ports:
      - "8000:8000"                # Not exposed publicly — Nginx gates it
    env_file:
      - .env
    environment:
      ENVIRONMENT: ${ENVIRONMENT:-production}
    healthcheck:
      test: ["CMD", "python", "-c",
             "import httpx; httpx.get('http://localhost:8000/health').raise_for_status()"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    deploy:
      resources:
        limits:
          memory: 512M             # Hard cap — prevents OOM killer
          cpus: "2.0"
        reservations:
          memory: 128M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "5"

  nginx:
    image: nginx:alpine
    container_name: jobifai-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/certs:/etc/nginx/certs:ro
      - ./frontend/dist:/usr/share/nginx/html:ro
    depends_on:
      backend:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 64M
    logging:
      driver: "json-file"
      options:
        max-size: "5m"
        max-file: "3"

  node-exporter:
    image: prom/node-exporter:latest
    container_name: jobifai-metrics
    restart: unless-stopped
    ports:
      - "127.0.0.1:9100:9100"      # Loopback only — never expose metrics publicly
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.ignored-mount-points=^/(sys|proc|dev|host|etc)($$|/)'
    deploy:
      resources:
        limits:
          memory: 32M
```

### 11.3 The Canonical Deploy Pipeline

```bash
#!/bin/bash
# /home/pi/jobifai/deploy.sh — the only sanctioned deployment sequence
set -euo pipefail
cd /home/pi/jobifai

# Step 1: Pull latest code
# git reset --hard prevents accidental local edits on the Pi from blocking the pull.
# Never edit files directly on the Pi. The repo is the source of truth.
git fetch origin main && git reset --hard origin/main
echo "✅ git: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# Step 2: Build and start containers
# --build:          Re-run Dockerfile even if image tag unchanged.
#                   Without this, new requirements.txt entries are silently ignored.
# -d:               Detached — SSH session close does NOT kill containers.
# --remove-orphans: Removes containers for services deleted from compose file.
docker compose up --build -d --remove-orphans

# Step 3: Prune dangling images — MANDATORY
# Every --build creates new image layers (~200 MB). Old layers are untagged, not deleted.
# 4 deploys without pruning = ~800 MB of orphaned data on the SD card.
# prune -f ONLY deletes untagged, unreferenced images — safe while containers run.
docker image prune -f
echo "✅ Pruned — disk available: $(df -h / | awk 'NR==2{print $4}')"

# Step 4: Verify state
docker compose ps

# Step 5: Health gate with automatic rollback
for i in $(seq 1 6); do
  sleep 5
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health 2>/dev/null || echo "000")
  [ "$HTTP" = "200" ] && echo "✅ Deploy complete" && exit 0
  echo "  attempt ${i}/6 — HTTP ${HTTP}"
done

echo "❌ Health check failed — rolling back"
git reset --hard HEAD~1
docker compose up --build -d --remove-orphans
exit 1
```

```bash
chmod +x /home/pi/jobifai/deploy.sh
# Add to ~/.bashrc: alias deploy='cd /home/pi/jobifai && ./deploy.sh'
```

**Why `--build` and `docker image prune -f` are both mandatory:**

| Omit | Symptom | Root Cause |
|---|---|---|
| `--build` | New pip packages missing; `ImportError` at runtime | Cached image layer not invalidated by `requirements.txt` change |
| `docker image prune -f` | `no space left on device` on 3rd–4th deploy | Each `--build` generates ~200 MB; old layers are untagged but not freed |

### 11.4 Systemd Watchdog

If Docker daemon itself crashes, containers do not restart. Add:

`/etc/systemd/system/jobifai.service`:
```ini
[Unit]
Description=JobifAI Docker Stack
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/pi/jobifai
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable jobifai && sudo systemctl start jobifai
```

---

## 12. Local Mobile Testing — Tailscale Protocol

### 12.1 Why `localhost` Fails on Device

| Alternative | Why it fails |
|---|---|
| LAN IP (`ifconfig`) | DHCP changes on every router renewal — breaks CORS configs and bookmarks |
| `ngrok` / `localtunnel` | Resume data and auth tokens transit a third-party server — PII violation |
| Deploy to Pi to test | Every UI change requires full `deploy.sh` cycle — destroys feedback loop |

Tailscale assigns each device a stable `100.x.x.x` IP reachable across any network, peer-to-peer encrypted, never transiting Tailscale's servers when direct connection is possible.

### 12.2 Setup (One-Time)

```bash
# Dev machine (macOS)
brew install tailscale && sudo tailscale up
tailscale ip -4   # → 100.64.0.12  (DEV_TAILSCALE_IP)
```

Install Tailscale on the iOS/Android test device. Sign in to the same Tailnet. Verify from device: `ping 100.64.0.12` must reply before proceeding.

### 12.3 Binding Vite to All Interfaces

Default Vite binds to `127.0.0.1`. The Tailscale interface (`utun*`/`tailscale0`) is a separate adapter — Vite ignores it without explicit binding.

```bash
# Ad-hoc (no config change):
npx vite --host 0.0.0.0
# Vite prints: Network: http://100.64.0.12:5173  ← mobile uses this URL
```

To make `npm run dev` expose automatically, update `vite.config.ts`:
```typescript
server: {
  port: 5173,
  host: '0.0.0.0',    // Binds to all interfaces including Tailscale
  proxy: {
    '/api': { target: 'http://localhost:8000', changeOrigin: true },
  },
},
```

> ⚠️ **Security:** `host: '0.0.0.0'` exposes the dev server to every network interface. On public Wi-Fi, anyone on the same network can reach it. Revert when not actively testing on device.

### 12.4 Binding Uvicorn to All Interfaces

The Dockerfile CMD already specifies `--host 0.0.0.0`. When running **outside Docker**:

```bash
# WRONG — loopback only
uvicorn backend.main:app --reload --port 8000

# CORRECT
uvicorn backend.main:app --reload --port 8000 --host 0.0.0.0
```

Verify:
```bash
ss -tlnp | grep 8000
# Correct:   LISTEN  0.0.0.0:8000
# Wrong:     LISTEN  127.0.0.1:8000
```

### 12.5 ⚠️ CORS — The Silent Killer

> **This is the most common failure mode.** The mobile browser sends `Origin: http://100.64.0.12:5173` in every preflight. FastAPI's CORS middleware rejects it with `403` because the Tailscale IP is not in `allowed_origins`. The browser reports a vague "CORS error". The API is never reached.

Fix in `backend/main.py`:

```python
import os

if settings.environment == "dev":
    allowed_origins += [
        "http://localhost:4173",
        "http://127.0.0.1:5173",
    ]
    # Set DEV_TAILSCALE_ORIGIN=http://100.64.0.12:5173 in .env
    tailscale_origin = os.getenv("DEV_TAILSCALE_ORIGIN", "")
    if tailscale_origin:
        allowed_origins.append(tailscale_origin)
```

`.env` (never commit — Tailscale IPs are user-specific):
```
DEV_TAILSCALE_ORIGIN=http://100.64.0.12:5173
```

Restart the backend after the change. Verify before touching the device:
```bash
curl -v \
  -H "Origin: http://100.64.0.12:5173" \
  -H "Access-Control-Request-Method: POST" \
  -X OPTIONS http://localhost:8000/api/chat/interview
# Expected: HTTP 200 + Access-Control-Allow-Origin present
# Failure: HTTP 403 → wrong IP or backend not restarted
```

### 12.6 Supabase Auth Redirect URL

Supabase validates `emailRedirectTo` against its allowlist. Add the Tailscale origin to Supabase Dashboard → Authentication → URL Configuration → Redirect URLs before the first mobile auth test. Otherwise magic link sign-in silently redirects to the default URL instead of returning to the test session.

### 12.7 Full Session Checklist

```
□ tailscale status — dev machine "Connected", mobile device listed
□ DEV_TAILSCALE_ORIGIN=http://{IP}:5173 set in .env
□ Backend restarted after .env change
□ CORS preflight curl returns HTTP 200 + Allow-Origin header
□ Vite running: Network URL visible in terminal output
□ Supabase redirect URL allowlist includes http://{IP}:5173
□ http://{IP}:5173 loads on mobile browser (not just pings)
□ Sign-in flow completes end-to-end on device
□ At least one authenticated API call succeeds (no CORS error in DevTools)
```