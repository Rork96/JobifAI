/**
 * App.tsx — Root Component
 * ─────────────────────────────────────────────────────────────────────────────
 * Intentionally thin by design.  App's only responsibilities are:
 *   1. Provide any global React context (auth session, theme)
 *   2. Set up page routing (React Router added in Task 3)
 *   3. Render the top-level layout
 *
 * Business logic belongs in the Zustand store.
 * UI structure belongs in MainLayout.
 * This file is the composition root — it wires them together.
 *
 * FUTURE PROVIDER STACK (added per task):
 *
 *   <ThemeProvider>        ← Task 2.5: dark/light mode toggle
 *     <SupabaseProvider>   ← Task 3: session listener, auth guard
 *       <BrowserRouter>    ← Task 3: routing (/, /dashboard, /pricing, etc.)
 *         <MainLayout />
 *       </BrowserRouter>
 *     </SupabaseProvider>
 *   </ThemeProvider>
 *
 * WHY NO ZUSTAND PROVIDER HERE?
 *   Zustand doesn't use React Context — the store is a module-level singleton.
 *   Any component anywhere can import `useAppStore` and it reads from the same
 *   store instance.  No <Provider> wrapper needed.  The trade-off: the store
 *   is global state, which is appropriate for a single-user SPA.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { MainLayout } from '@/layouts/MainLayout';

const App: React.FC = () => {
  return <MainLayout />;
};

export default App;
