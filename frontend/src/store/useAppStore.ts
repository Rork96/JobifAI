// Barrel re-export for all domain stores.
//
// Prefer importing from individual store files in feature/widget code so
// tree-shaking and TypeScript narrowing work correctly.  This file exists
// purely for ergonomics during the early build phase — it will be deleted
// once all features import directly (Handbook §4.3 Phase 6).

export { useAuthStore } from './useAuthStore'
export { useBillingStore } from './useBillingStore'
export { useSessionStore } from './useSessionStore'
export { useChatStore } from './useChatStore'
export { useDocumentStore } from './useDocumentStore'
