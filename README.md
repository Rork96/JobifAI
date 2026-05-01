# JobifAI — Architecture

## System overview

```mermaid
flowchart TB
    User([User Browser])

    subgraph Frontend["Frontend (React + Vite)"]
        UI[Chat UI + Document Preview]
        Store[Zustand Store]
    end

    subgraph Backend["Backend (FastAPI · Python 3.11)"]
        direction TB

        subgraph Routers["API Routers"]
            R1["/api/upload-resume"]
            R2["/api/parse-job"]
            R3["/api/analyze"]
            R4["/api/chat/interview<br/>(SSE)"]
            R5["/api/evaluate-edit"]
            R6["/api/resume/final-polish"]
            R7["/api/checkout<br/>/webhooks/stripe"]
            R8["/api/user/save-progress<br/>/load-progress"]
        end

        subgraph AI["AI Service Layer"]
            Stream[stream_interview_turn<br/>Sentinel SSE Generator]
            Factory[PersonaFactory<br/>Strategy Pattern]
            Recover[JSON Recovery<br/>5 Strategies]
            Fallback[Model Fallback Chain]
        end

        subgraph Services["Services"]
            Parser[Parser<br/>PyMuPDF · python-docx]
            Scraper[Scraper<br/>Jina Reader]
            Embed[Embeddings<br/>Asymmetric Retrieval]
        end

        subgraph Security["Security"]
            JWT[Local JWT Decode<br/>HS256 + fallback]
            HMAC[Stripe HMAC<br/>Raw Bytes]
            Scrub[HR Compliance Scrubber]
        end
    end

    subgraph External["External Services"]
        Gemini[(Google Gemini<br/>2.5 Flash + 1.5 Pro<br/>+ embedding-001)]
        Supabase[(Supabase<br/>Postgres · Auth · RLS)]
        Stripe[(Stripe<br/>Checkout · Webhooks)]
        Jina[(Jina Reader<br/>JD Scraper)]
    end

    User <-->|HTTPS| UI
    UI <--> Store
    UI -->|REST + SSE| Routers

    R3 --> AI
    R4 --> AI
    R5 --> AI
    R6 --> AI

    AI --> Gemini
    Stream --> Factory
    Stream --> Recover
    AI --> Fallback
    Fallback --> Gemini

    R1 --> Parser
    R2 --> Scraper
    R3 --> Embed
    Embed --> Gemini
    Scraper --> Jina

    R8 --> JWT
    JWT --> Supabase
    R7 --> HMAC
    HMAC --> Stripe
    AI --> Scrub

    R8 --> Supabase

    classDef router fill:#1e40af,stroke:#1e3a8a,color:#fff
    classDef ai fill:#7c3aed,stroke:#5b21b6,color:#fff
    classDef svc fill:#0891b2,stroke:#0e7490,color:#fff
    classDef sec fill:#b91c1c,stroke:#991b1b,color:#fff
    classDef ext fill:#059669,stroke:#047857,color:#fff

    class R1,R2,R3,R4,R5,R6,R7,R8 router
    class Stream,Factory,Recover,Fallback ai
    class Parser,Scraper,Embed svc
    class JWT,HMAC,Scrub sec
    class Gemini,Supabase,Stripe,Jina ext
```

## Interview turn flow — sentinel-delimited streaming

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant F as Frontend
    participant B as FastAPI Backend
    participant P as PersonaFactory
    participant G as Gemini API

    U->>F: Types message
    F->>B: POST /api/chat/interview
    B->>P: build(mode, score, step, lang)
    P-->>B: System prompt
    B->>G: generate_content_async(stream=True)

    loop For each Gemini chunk
        G-->>B: chunk_text
        alt Sentinel not yet found
            B->>B: Buffer with overlap of len(SENTINEL)-1
            B-->>F: SSE event: token
            F-->>U: Render text in real time
        else Sentinel found
            B->>B: Switch to JSON accumulation mode
        end
    end

    G-->>B: Stream end
    B->>B: Parse JSON with 5-strategy recovery
    B->>B: HR compliance scrubber
    B-->>F: SSE event: data_extract
    F->>F: Update Zustand store
    F-->>U: Document preview flashes
    B-->>F: SSE event: done
```

## ATS scoring pipeline

```mermaid
flowchart LR
    Resume[Resume Text] --> Extract[Extract<br/>Skills + Experience<br/>+ Summary]
    JD[Job Description] --> Trim[Trim to 2000 chars]

    Extract -->|RETRIEVAL_DOCUMENT| EmbedR[gemini-embedding-001]
    Trim -->|RETRIEVAL_QUERY| EmbedJ[gemini-embedding-001]

    EmbedR --> Vec1[(Vector A · 768d)]
    EmbedJ --> Vec2[(Vector B · 768d)]

    Vec1 --> Cosine{Cosine Similarity}
    Vec2 --> Cosine

    Cosine -->|raw 0.45–0.85| Rescale[Linear Rescale<br/>to 0–100%]
    Rescale --> Score[ATS Score]

    Resume --> SkillCall[Gemini skill analysis]
    JD --> SkillCall
    Score --> SkillCall
    SkillCall --> Matched[Matched skills]
    SkillCall --> Missing[Missing skills<br/>+ impact %]
```

## Persona selection — Strategy pattern

```mermaid
flowchart TD
    Request[Interview Request<br/>mode + score + step] --> Factory{PersonaFactory.build}

    Factory -->|mode=SCRATCH| StepsS[Inject SCRATCH<br/>state machine:<br/>idle → target_title →<br/>summary → experience →<br/>skills_education → complete]
    Factory -->|mode=OPTIMIZE| StepsO[Inject OPTIMIZE<br/>coaching flow:<br/>ghost keyword integration]

    Factory -->|hardcore=true| Hard[Hardcore Mentor Override<br/>radical honesty]
    Factory -->|score lower than 30| Triage[Emergency Triage<br/>brief · fill empty sections]
    Factory -->|score greater than 90| Triumph[Triumph Mode<br/>celebrate · Elite Bonus Skills]
    Factory -->|30 ≤ score ≤ 90| Standard[Standard Coaching<br/>no override]

    StepsS --> Assemble[Assemble final prompt]
    StepsO --> Assemble
    Hard --> Assemble
    Triage --> Assemble
    Triumph --> Assemble
    Standard --> Assemble

    Assemble --> Gemini[Send to Gemini<br/>as system_instruction]
```
