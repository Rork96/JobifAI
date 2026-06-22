# JobifAI — Frontend Constitution

> **These rules override all previous patterns. Every future code change to the
> frontend must comply. No exceptions.**

---

## Rule 1 — Strict Separation of Concerns

### React Components (`.tsx`) are DUMB
- They **only** render state and dispatch actions.
- They **never** parse text, run regex, or call `fetch` directly.
- They **never** contain business logic (no `if (score > 50)` decisions, no data
  transformations, no side-effect chains beyond a single store action dispatch).
- A component's job: `store state → JSX`. That is the entire contract.

### `useDocumentStore.ts` (Zustand) is the ONLY Source of Truth
- All API calls live here, in clearly named async actions.
- All state transitions live here.
- All data mutations (parse, merge, diff, score) are triggered from here.
- No component may reach around the store to mutate shared state.

---

## Rule 2 — Headless Data First (The "Verify" Rule)

1. Build the data layer (Zustand action + parser + API fetcher) in isolation.
2. Verify the output with `console.log` — the payload must be correct and
   fully typed before any UI is built on top of it.
3. **If the data flow does not work perfectly headlessly, do not build the UI
   for it.** Broken data hidden behind a spinner is not progress.

---

## Rule 3 — The Parser Contract

- The document parser lives in `frontend/src/lib/parseResume.ts`.
- It is a **pure function**: `(rawText: string) => ResumeSection[]`.
- It has zero imports from React, Zustand, or any API module.
- It handles: chronological section ordering, header detection, bullet
  classification, and `isMeta` tagging — before the UI ever sees the data.
- No regex hacks inside components or store actions. All parsing happens in
  `parseResume.ts` and nowhere else.
- The function must be unit-testable with a plain `node` call.

---

## Rule 4 — No Silent Failures

Every async action in the store must follow this template:

```typescript
actionName: async (...args) => {
  set({ isLoading: true, error: null });
  try {
    // ... work ...
    set({ isLoading: false, /* result fields */ });
  } catch (err) {
    // Reset ALL pending/loading flags.
    // Surface a visible error — never swallow it.
    set({ isLoading: false, error: String(err) });
    throw err; // re-throw so callers can react if needed
  }
},
```

- **No infinite spinners.** `isLoading` must be reset to `false` in both the
  success path and the catch block.
- **No silent swallowing.** Every `catch` must either set an `error` field in
  the store or dispatch a toast notification. Logging to console alone is not
  sufficient.

---

## File Layout (enforced)

```
frontend/src/
  lib/
    parseResume.ts      ← pure parser (Rule 3)
    supabaseClient.ts   ← DB helpers (no business logic)
    geminiClient.ts     ← AI API helpers (no business logic)
  store/
    useDocumentStore.ts ← single source of truth (Rule 1)
    useAuthStore.ts
    useUIStore.ts
  pages/
    WorkspacePage/      ← dumb shell (Rule 1)
    LandingPage/
    DashboardPage/
  components/           ← dumb, reusable (Rule 1)
```

---

## Violation Checklist (reject any PR that contains these)

- [ ] `fetch(` inside a `.tsx` file
- [ ] `/regex/` inside a `.tsx` file
- [ ] Business logic (`if/else` decisions on data shape) inside a `.tsx` file
- [ ] A `set({})` call inside a React component
- [ ] An async action with no `try/catch`
- [ ] An async action that does not reset `isLoading` on error
- [ ] Parsing logic outside of `parseResume.ts`
