// Handbook §4.2 — Store 4: useChatStore
// Owns: chat messages, interview step machine, SSE streaming state, BYOK key.
// Target location (post-migration): features/ai-coaching/model/useChatStore.ts
//
// BYOK (PRD §1.4): byokApiKey lives only in this store for the session lifetime.
// It is NEVER persisted to Supabase and NEVER sent as part of the request body —
// only forwarded as X-BYOK-Key header in apiClient.ts.

import { create } from 'zustand'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

interface ChatState {
  messages: ChatMessage[]
  interviewStep: number
  isGenerating: boolean
  streamError: string | null
  byokApiKey: string | null
}

interface ChatActions {
  addMessage: (message: ChatMessage) => void
  setMessages: (messages: ChatMessage[]) => void
  advanceStep: () => void
  setIsGenerating: (isGenerating: boolean) => void
  setStreamError: (error: string | null) => void
  setBYOKApiKey: (key: string | null) => void
  clearConversation: () => void
}

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  messages: [],
  interviewStep: 0,
  isGenerating: false,
  streamError: null,
  byokApiKey: null,

  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),
  setMessages: (messages) => set({ messages }),
  advanceStep: () => set((s) => ({ interviewStep: s.interviewStep + 1 })),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setStreamError: (streamError) => set({ streamError }),
  setBYOKApiKey: (byokApiKey) => set({ byokApiKey }),

  clearConversation: () =>
    set({ messages: [], interviewStep: 0, isGenerating: false, streamError: null }),
}))
