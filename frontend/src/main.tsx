/**
 * main.tsx — Application Bootstrap
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the entry point Vite loads first (referenced in index.html).
 * Its only job: mount the React tree into the DOM.
 *
 * Keep this file tiny.  All real logic belongs in App.tsx or lower.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css'; // Tailwind base + global styles

// `document.getElementById('root')!`
// The `!` is a non-null assertion — we know the element exists because we
// put it in index.html.  TypeScript can't know that statically, so we tell it.
const rootElement = document.getElementById('root')!;

// React 18's createRoot enables Concurrent Mode — React can pause/resume
// rendering, making the app more responsive during heavy work.
// (This replaces the old ReactDOM.render() from React 17.)
ReactDOM.createRoot(rootElement).render(
  // StrictMode intentionally renders components twice in development to
  // help catch side effects in useEffect / useState that would break in
  // Concurrent Mode.  It has no effect in production builds.
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
