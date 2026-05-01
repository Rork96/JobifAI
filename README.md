# Jobif — AI Career Co-pilot

An AI-powered resume optimisation engine. Users upload their resume + a target job description, and a multi-agent system streams a real-time interview that rewrites their resume to pass ATS filters and impress Canadian recruiters.

**Stack:** FastAPI · Python 3.11 · Google Gemini 2.5 Flash · Supabase (Postgres + Auth + RLS) · Stripe · Docker · React (frontend, separate repo)

**Live:** _add deployment URL_
**Frontend:** _link if separate repo_

---

## What it does

- **Upload a resume** (PDF / DOCX / TXT) and paste a job posting URL or text.
- **Get an ATS match score** (0–100) with a list of found keywords, missing keywords, and contextual synonym matches (e.g. "Node" ↔ "Node.js").
- **Conversational rewrite** — Mac, an AI Career Co-pilot, asks targeted questions and rewrites bullets in real time using ATS-optimised action verbs.
- **Final Polish** — one-pass HR-Director rewrite of the entire resume with quantification placeholders and Canadian HR compliance.
- **Stripe billing** — $4.99 / 24-hour pass and $14.99 / month subscriptions with HMAC-verified webhooks.

---

## Architecture highlights

### Sentinel-delimited SSE streaming
A single Gemini call returns both a streaming conversational reply and a structured JSON extraction, separated by a `[DATA_EXTRACT]` sentinel. The backend forwards every pre-sentinel chunk to the SSE stream as a `token` event, then parses the post-sentinel JSON and emits a `data_extract` event. An overlap buffer of `len(SENTINEL) - 1` characters handles sentinels split across Gemini chunk boundaries. One API call, true real-time streaming, reliable structured output. See `backend/ai_service.py::stream_interview_turn`.

### PersonaFactory — Strategy pattern over system prompts
The Mac persona is assembled from named text blocks (`_HEADER`, `_RULE_LANGUAGE`, `_STEPS_OPTIMIZE`, `_STEPS_SCRATCH`, …) by `PersonaFactory.build()`. The factory selects the correct strategy based on `mode` (OPTIMIZE / SCRATCH) and `score` (`<30` Emergency Triage, `>90` Triumph mode, hardcore override). `ai_service.py` never branches on mode — it just calls the factory. See `backend/config/prompts.py`.

### Multi-strategy JSON recovery
LLM responses are sometimes truncated mid-JSON (Gemini 2.5 Flash thinking mode fights with `max_output_tokens`). The `_recover_json` helper tries five strategies in order: direct parse, first-`{` to last-`}` regex, truncation repair suffixes, partial-field harvest by regex, and finally `_TruncatedResponseError`. See `backend/routers/evaluate.py`.

### Model fallback chain
Calls flow through `gemini-1.5-flash-latest` → `gemini-1.5-pro-latest` → `gemini-2.5-flash`. Only 404 / not-found errors advance to the next model — auth and rate-limit errors propagate immediately. Survives Gemini API surface changes without a deploy.

### Asymmetric retrieval embeddings
The resume is embedded with `task_type="RETRIEVAL_DOCUMENT"`, the JD with `RETRIEVAL_QUERY`. Empirically measured spread: 0.29 between good and poor matches versus 0.19 for `SEMANTIC_SIMILARITY`. Raw cosine `[0.45, 0.85]` is linearly rescaled to `[0%, 100%]`. See `backend/services/embeddings.py`.

### Defence-in-depth Canadian HR compliance
A `FORBIDDEN_HR_FIELDS` frozenset of protected attributes (age, gender, marital status, religion, SIN, etc.) is enforced in two places: the system prompt instructs Gemini never to extract them, and a recursive post-processing scrubber removes any that slip through. Two independent safeguards.

### Stripe webhook security
Webhooks read `request.body()` as raw bytes (FastAPI JSON parsing would alter byte ordering and break HMAC). `stripe.Webhook.construct_event` performs constant-time signature comparison and a 5-minute timestamp tolerance for replay protection. Failures return 200 with `received: false` to prevent retry storms.

### Local JWT validation with fallback
Supabase access tokens are decoded locally with `PyJWT` HS256 against `SUPABASE_JWT_SECRET`. Zero network on every authenticated request. If the algorithm isn't HS256 (RS256 projects), validation falls back to `supabase.auth.get_user(token)`. See `backend/routers/user.py::get_authenticated_user_id`.

### Fail-open vs fail-closed by endpoint
`/api/evaluate-edit` returns `approved: true` on any error — the interview must never be blocked by a secondary scoring service. `/api/upload-resume` returns 422 on any parse error — silently passing an empty string to the AI would produce nonsense.

---

## Project structurebackend/
main.py                      App factory, CORS, lifespan, middleware
ai_service.py                Sentinel-streaming SSE generator + post-processing
config/
init.py                Pydantic Settings (env + .env)
prompts.py                 PersonaFactory + all system prompt blocks
routers/
interview.py               POST /api/chat/interview         — SSE stream
evaluate.py                POST /api/evaluate-edit, /api/ats-score, /api/analyze, /api/rewrite-section
upload.py                  POST /api/upload-resume          — PDF / DOCX / TXT parser
job.py                     POST /api/parse-job              — Jina Reader scraper
polish.py                  POST /api/resume/final-polish    — HR-Director rewrite
resumes.py                 POST /api/resumes, GET /api/resumes/{id}
payments.py                POST /api/checkout, POST /api/webhooks/stripe
user.py                    POST /api/user/save-progress, GET /load-progress, DELETE /clear-data
services/
parser.py                  PyMuPDF + python-docx text extractor
scraper.py                 Jina Reader proxy for JD scraping
embeddings.py              Asymmetric retrieval ATS scoring + skill gap analysis
Dockerfile                   Multi-stage, linux/arm64, non-root user, healthcheck
requirements.txt             Pinned versions
supabase/
migrations/                  Idempotent SQL migrations (RLS, triggers)

---

## Run locally

### Prerequisites
- Python 3.11
- A Google AI Studio API key
- A Supabase project (URL + service-role key + JWT secret)
- A Stripe test account (optional — billing endpoints degrade gracefully)

### Setup

```bashgit clone https://github.com/Rork96/JobifAI
cd JobifAIpython -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txtcp .env.example .env   # fill in the keys
uvicorn backend.main:app --reload
→ http://localhost:8000/docs

### Required environment variables

```envENVIRONMENT=dev
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_KEY=eyJ...                # service role key
SUPABASE_JWT_SECRET=...            # for local HS256 validation
GEMINI_API_KEY=AIza...
STRIPE_SECRET_KEY=sk_test_...      # optional
STRIPE_WEBHOOK_SECRET=whsec_...    # optional
STRIPE_PRICE_PASS_ID=price_...     # optional
STRIPE_PRICE_MONTHLY_ID=price_...  # optional

### Database

Run `supabase/migrations/20240322000000_user_data.sql` in your Supabase SQL editor. The migration is idempotent.

### Docker (Raspberry Pi 5 deployment)

```bashdocker buildx build --platform linux/arm64 -t jobifai-backend ./backend
docker run -p 8000:8000 --env-file .env jobifai-backend

The Dockerfile is multi-stage (~200 MB final image), runs as a non-root `jobifai` user, and exposes a `/health` endpoint that the included `HEALTHCHECK` instruction polls every 30 seconds.

---

## API reference

OpenAPI docs are auto-generated and available at `/docs` in development. Key endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload-resume` | Parse a PDF / DOCX / TXT resume to plain text |
| `POST` | `/api/parse-job` | Scrape a JD URL via Jina Reader, or normalise pasted text |
| `POST` | `/api/analyze` | One-shot: score + found / missing keywords + Mac's first message |
| `POST` | `/api/chat/interview` | SSE-streamed interview turn (token / data_extract / done events) |
| `POST` | `/api/evaluate-edit` | Quality gate before committing a proposed edit |
| `POST` | `/api/rewrite-section` | "Magic" rewrite of one bullet into a structured diff |
| `POST` | `/api/resume/final-polish` | One-pass HR-Director rewrite of the full resume |
| `POST` | `/api/checkout` | Create a Stripe Checkout Session |
| `POST` | `/api/webhooks/stripe` | HMAC-verified Stripe event receiver |
| `POST` | `/api/user/save-progress` | Debounced auto-save of full session state |
| `GET`  | `/api/user/load-progress` | Hydrate Zustand store on page refresh |

---

## Roadmap

- Cover-letter generator using the same PersonaFactory pattern
- Voice interview mode (Whisper STT → Mac → ElevenLabs TTS)
- Multi-resume management UI (one user, many resumes per JD)
- Postgres `pgvector` migration to colocate embeddings with resume rows

---

## License

MIT
