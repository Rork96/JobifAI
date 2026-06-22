/**
 * useChatStore — Store 4 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: chat messages, interview step machine, SSE streaming
 * state, BYOK Gemini key.
 *
 * FSD target location: features/ai-coaching/model/useChatStore.ts
 * Lives in store/ during Phase 1; will move during FSD refactor.
 *
 * SSE streaming rules (PRD §4.9):
 *   - enforcer.consume() is called ONLY after type:"done" — never on error.
 *   - isGenerating = true for the full duration from request sent → type:"done".
 *   - On type:"interrupt" (Hardcore Mode): message is appended, isGenerating stays
 *     true until the interrupt overlay is dismissed.
 *
 * BYOK rule (PRD §1.4):
 *   - byokApiKey is NEVER persisted to DB, NEVER sent to Supabase.
 *   - Lives only in this store for the session lifetime.
 *   - Persistent BYOK storage is managed in /settings (localStorage, encrypted).
 *   - When set, the backend receives it as a request header and bypasses quota.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /**
   * Phase 3 — Dialogue binding.
   * ID of the EditableBullet this message was sent against.
   * Undefined only for legacy/system messages that predate Phase 3.
   * Guarantees the conversation history is always traceable to a specific
   * resume bullet and prevents unanchored AI suggestions.
   */
  bulletId?: string;
  /** True while this message is still streaming (partial content). */
  isStreaming?: boolean;
}

/**
 * SSE event types from the interview stream (PRD §4.9).
 * The feature layer (interviewApi.ts) maps raw SSE strings to this union.
 */
export type InterviewSSEEvent =
  | { type: 'token';     data: string }
  | { type: 'done';      data: null }
  | { type: 'interrupt'; data: { reason: string } }
  | { type: 'error';     data: { message: string } };

interface ChatState {
  // ── State ──────────────────────────────────────────────────────────────────
  messages: ChatMessage[];
  /** Current interview turn index. Incremented by advanceStep(). */
  interviewStep: number;
  /** True while SSE stream is open (request sent → type:"done"). */
  isGenerating: boolean;
  streamError: string | null;

  /**
   * BYOK Gemini API key (PRD §1.4).
   * Never persisted to DB. Never sent to Supabase.
   * Session-lifetime only. When set, bypasses all server-side quota.
   */
  byokApiKey: string | null;

  // ── Actions ────────────────────────────────────────────────────────────────
  addMessage: (message: ChatMessage) => void;
  setMessages: (messages: ChatMessage[]) => void;

  /**
   * Append a token to the last streaming message.
   * Called for each type:"token" SSE event.
   */
  appendToken: (token: string) => void;

  /** Mark the last streaming message as complete (type:"done"). */
  finalizeStream: () => void;

  /** Increment interviewStep. Called after each confirmed turn. */
  advanceStep: () => void;

  setIsGenerating: (value: boolean) => void;
  setStreamError: (error: string | null) => void;

  /**
   * Set the BYOK API key for this session.
   * Pass null to clear (fall back to server quota).
   */
  setByokApiKey: (key: string | null) => void;

  /** Clear messages, step counter, and streaming state. */
  clearConversation: () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  messages: [],
  interviewStep: 0,
  isGenerating: false,
  streamError: null,
  byokApiKey: null,

  // ── Actions ────────────────────────────────────────────────────────────────
  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),

  setMessages: (messages) => set({ messages }),

  appendToken: (token) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      messages[messages.length - 1] = {
        ...last,
        content: last.content + token,
        isStreaming: true,
      };
      return { messages };
    }),

  finalizeStream: () =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      messages[messages.length - 1] = { ...last, isStreaming: false };
      return { messages };
    }),

  advanceStep: () => set((s) => ({ interviewStep: s.interviewStep + 1 })),

  setIsGenerating: (value) => set({ isGenerating: value }),

  setStreamError: (error) => set({ streamError: error }),

  setByokApiKey: (key) => set({ byokApiKey: key }),

  clearConversation: () =>
    set({
      messages: [],
      interviewStep: 0,
      isGenerating: false,
      streamError: null,
      // byokApiKey intentionally NOT cleared — persists through conversation resets
    }),
}));
