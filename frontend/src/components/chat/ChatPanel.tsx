/**
 * components/chat/ChatPanel.tsx — The Interview Conversation UI
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders:
 *   1. Mac the Mascot (expression + thinking state from the store)
 *   2. Step context prompt (what Mac is currently asking)
 *   3. Scrollable message list (user bubbles right, Mac bubbles left)
 *   4. Text input + Send button
 *   5. DEV: Step-advance button for testing the state machine manually
 *
 * ALL interview state lives in the Zustand store — ChatPanel is a
 * "controlled" component that only reads/writes the store.
 * The ONLY local state is the textarea input value and the live streaming
 * buffer (changes on every token — too frequent for global store).
 *
 * SSE STREAMING DESIGN:
 *   The AI endpoint returns a Server-Sent Events stream (text/event-stream).
 *   We cannot use the browser's EventSource API here because that only supports
 *   GET requests — we need POST with a JSON body.  Instead we use:
 *
 *     fetch() → response.body (ReadableStream) → getReader() → decode chunks
 *
 *   Events arriving from the server:
 *     event: token        { text: "..." }       — stream to typewriter buffer
 *     event: data_extract { step, advance, data } — update resume + step machine
 *     event: done         {}                    — commit message, clear buffer
 *     event: error        { message: "..." }    — show error, clean up
 *
 * STREAMING UX:
 *   Phase 1 — "Thinking":  isGenerating=true, streamingContent=''
 *             → Show bouncing dots (Mac is calling the API)
 *   Phase 2 — "Streaming": isGenerating=true, streamingContent='Hello…'
 *             → Show live bubble with blinking cursor (tokens arriving)
 *   Phase 3 — "Done":      addMessage() commits to store, both cleared
 *             → Bubble becomes a real message in the list
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, RotateCcw } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { INTERVIEW_STEP_PROMPTS, INTERVIEW_STEP_LABELS, type ResumeData } from '@/types';
import { MacMascot } from '@/components/mascot/MacMascot';

// ── API Types ─────────────────────────────────────────────────────────────────

/** Shape of the POST /api/chat/interview request body (mirrors InterviewRequest in Python). */
interface InterviewRequestBody {
  user_message:         string;
  current_step:         string;
  user_lang:            string;
  resume_lang:          string;
  /** Prior messages EXCLUDING the current user turn — backend adds user_message separately. */
  conversation_history: Array<{ role: 'user' | 'assistant'; content: string }>;
  resume_data_context:  Partial<ResumeData>;
  byok_api_key?:        string;
}

/** Parsed payload of a `data_extract` SSE event. */
interface DataExtractPayload {
  step:    string;
  advance: boolean;
  data:    Partial<ResumeData>;
  /** Optional warning flag from the backend (e.g. sentinel_missing). */
  _warn?:  string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Converts a Unix timestamp to a human-readable relative time (e.g. "2m ago"). */
const formatRelativeTime = (timestamp: number): string => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60)   return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};

// ── Component ─────────────────────────────────────────────────────────────────
export const ChatPanel: React.FC = () => {

  // ── Local state ─────────────────────────────────────────────────────────────
  // `inputValue` is local because it changes on every keystroke — we don't
  // want DocumentPreview re-rendering on every keypress.
  const [inputValue, setInputValue] = useState('');

  // `streamingContent` holds the live typewriter buffer.  It is local because:
  //   • It changes on every token (potentially 20–50× per second)
  //   • Only ChatPanel needs to render it
  //   • Putting it in global store would trigger re-renders in DocumentPreview
  // null  = not streaming
  // ''    = streaming started but no tokens yet (show dots)
  // text  = tokens arriving (show live bubble)
  const [streamingContent, setStreamingContent] = useState<string | null>(null);

  // AbortController lets us cancel the fetch if the component unmounts mid-stream
  // or if the user starts a new request before the previous one finishes.
  const abortRef = useRef<AbortController | null>(null);

  // Ref to the bottom of the message list — used for auto-scroll.
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ── Store subscriptions ──────────────────────────────────────────────────────
  // Subscribe to each field individually — this component only re-renders
  // when one of THESE specific values changes, not on any store update.
  const currentStep  = useAppStore((s) => s.currentStep);
  const messages     = useAppStore((s) => s.messages);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const userLang     = useAppStore((s) => s.userLang);
  const resumeLang   = useAppStore((s) => s.resumeLang);
  const resumeData   = useAppStore((s) => s.resumeData);

  // Actions — Zustand guarantees these are stable references (never change),
  // so they're safe to use in deps arrays without causing infinite loops.
  const addMessage      = useAppStore((s) => s.addMessage);
  const advanceStep     = useAppStore((s) => s.advanceStep);
  const setIsGenerating = useAppStore((s) => s.setIsGenerating);
  const updateResumeData = useAppStore((s) => s.updateResumeData);
  const resetInterview  = useAppStore((s) => s.resetInterview);

  // ── Cleanup on unmount ────────────────────────────────────────────────────────
  // If the user navigates away while Mac is responding, abort the fetch so we
  // don't leak network connections or update unmounted component state.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── Auto-scroll ──────────────────────────────────────────────────────────────
  // Scrolls to the latest message whenever messages or the streaming buffer
  // changes.  We scroll on streamingContent changes too so the live bubble
  // stays in view as it grows.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // ── Send handler ─────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isGenerating) return;

    // ── Snapshot state BEFORE any mutations ────────────────────────────────────
    // `messages` in the store doesn't include the new user message yet.
    // We snapshot it now to use as the `conversation_history` for this request
    // (the backend wants history EXCLUDING the current user turn).
    //
    // Using getState() directly (not the closure `messages`) ensures we get the
    // absolute latest slice even if React batches multiple renders.
    const prevMessages = useAppStore.getState().messages;
    const step         = currentStep;   // capture before any step advances
    const langUser     = userLang;
    const langResume   = resumeLang;
    const ctxData      = resumeData;

    // ── 1. Optimistic UI: add user message immediately ─────────────────────────
    // The user sees their message appear right away — no waiting for the API.
    addMessage({ role: 'user', content: trimmed });
    setInputValue('');

    // ── 2. Transition into "thinking" state ───────────────────────────────────
    setIsGenerating(true);
    setStreamingContent('');  // '' = streaming started, no tokens yet → show dots

    // Cancel any previous in-flight request (shouldn't happen in normal usage
    // since the send button is disabled while isGenerating, but defensive coding).
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    // Accumulates the full streamed conversational text for this turn.
    // We keep it in a local variable (not state) to avoid stale closure issues —
    // each frame of the event loop reads the latest value.
    let accumulated = '';
    let finished    = false;  // guard against processing events after done/error

    // ── Cleanup helper — called on done, error, or exception ──────────────────
    const cleanup = () => {
      setStreamingContent(null);
      setIsGenerating(false);
      finished = true;
    };

    // ── 3. Build request body ─────────────────────────────────────────────────
    const body: InterviewRequestBody = {
      user_message:         trimmed,
      current_step:         step,
      user_lang:            langUser,
      resume_lang:          langResume,
      // Pass prior messages (not including the current user turn we just added)
      conversation_history: prevMessages.map((m) => ({
        role:    m.role,
        content: m.content,
      })),
      // Context-only: helps the AI know what's already been collected so it can
      // avoid re-asking things. Not persisted server-side.
      resume_data_context: ctxData,
    };

    try {
      // ── 4. Fetch with SSE response ──────────────────────────────────────────
      const res = await fetch('/api/chat/interview', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(errText);
      }

      // ── 5. Read the SSE stream ────────────────────────────────────────────
      // ReadableStream → getReader() → decode chunks → parse SSE events.
      //
      // SSE format:
      //   event: <type>\n
      //   data: <json>\n
      //   \n              ← blank line = end of event
      //
      // Multiple events can arrive in a single chunk, and a single event
      // can be split across chunks — we use a `buffer` to handle both.
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      while (!finished) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;

        // Append the new chunk to our buffer and split on the SSE event delimiter.
        buffer += decoder.decode(value, { stream: true });

        // Split on double-newline (SSE event boundary).
        // `parts.pop()` retains the incomplete trailing fragment in `buffer`.
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const block of parts) {
          if (finished || !block.trim()) continue;

          // Extract the `event:` and `data:` lines from the block.
          // We use regex to be robust against extra whitespace / ordering.
          const eventType  = /^event: (.+)$/m.exec(block)?.[1]?.trim();
          const dataString = /^data: (.+)$/m.exec(block)?.[1]?.trim();

          if (!eventType || !dataString) continue;

          // Parse the JSON payload — skip the block if malformed.
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(dataString); }
          catch { continue; }

          switch (eventType) {
            // ── token: a chunk of conversational text ──────────────────────
            case 'token': {
              const chunk = (payload.text as string) ?? '';
              accumulated += chunk;
              // Update the live streaming bubble immediately.
              // React batches these setStates in concurrent mode so the UI
              // doesn't thrash even at 50 tokens/second.
              setStreamingContent(accumulated);
              break;
            }

            // ── data_extract: structured resume data + step-advance signal ─
            case 'data_extract': {
              const extracted = payload as unknown as DataExtractPayload;

              // Merge extracted fields into the global resume data store.
              // The backend's sanitise_extracted_data() has already allowlisted
              // the keys so we don't need to re-validate here.
              if (extracted.data && Object.keys(extracted.data).length > 0) {
                updateResumeData(extracted.data);
              }

              // Advance the interview step machine if the AI says it's ready.
              // We advance AFTER merging data so DocumentPreview reflects the
              // new data in the new step (not the previous one).
              if (extracted.advance === true) {
                advanceStep();
              }
              break;
            }

            // ── done: stream complete, commit the message ───────────────────
            case 'done': {
              // Commit the full accumulated text as a real message in the store.
              // This replaces the live streaming bubble with a permanent bubble.
              if (accumulated.trim()) {
                addMessage({ role: 'assistant', content: accumulated.trim() });
              }
              cleanup();
              break;
            }

            // ── error: AI service failure ───────────────────────────────────
            case 'error': {
              const errMsg = (payload.message as string) ?? 'Something went wrong.';
              addMessage({
                role:    'assistant',
                content: `⚠️ ${errMsg}`,
              });
              cleanup();
              break;
            }
          }
        }
      }

    } catch (err: unknown) {
      // AbortError = intentional cancel (unmount or new request) — silent.
      if ((err as Error)?.name === 'AbortError') {
        // Don't show an error — this was intentional
      } else {
        // Real network/parse error — show whatever was streamed so far
        if (accumulated.trim()) {
          // Partial response is better than nothing
          addMessage({ role: 'assistant', content: accumulated.trim() });
        } else {
          addMessage({
            role:    'assistant',
            content: '⚠️ Connection error — please check your network and try again.',
          });
        }
      }
      cleanup();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter; allow Shift+Enter for multi-line messages
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0 bg-white dark:bg-surface-dark">

      {/* ── Header: Mascot + current step prompt ─────────────────────────── */}
      <div className="flex-shrink-0 px-5 pt-6 pb-4 border-b border-gray-100 dark:border-gray-800">
        <div className="flex flex-col items-center gap-3">
          <MacMascot currentStep={currentStep} isThinking={isGenerating} />

          {/* Step context prompt — changes per step, slides in with animation */}
          <AnimatePresence mode="wait">
            <motion.p
              key={currentStep}
              className="text-sm text-center text-gray-500 dark:text-gray-400 max-w-xs leading-relaxed"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{   opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
            >
              {INTERVIEW_STEP_PROMPTS[currentStep]}
            </motion.p>
          </AnimatePresence>

          {/* Language indicator — subtle badge showing USER_LANG */}
          <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span>Chatting in <strong className="font-medium">{userLang}</strong></span>
          </div>
        </div>
      </div>

      {/* ── Message list ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hidden px-4 py-4 space-y-3 min-h-0">

        {/* Empty state — shown before the first message */}
        {messages.length === 0 && !streamingContent && (
          <motion.div
            className="flex flex-col items-center justify-center h-full gap-3 text-center py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
          >
            <p className="text-sm text-gray-400 dark:text-gray-500">
              Type your first message to begin ↓
            </p>
          </motion.div>
        )}

        {/* Committed message bubbles */}
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              layout                        // Smooth reflow as new messages push old ones up
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0,  scale: 1 }}
              exit={{   opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {/* Mac avatar for assistant messages */}
              {msg.role === 'assistant' && (
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mt-1">
                  <span className="text-xs">🐾</span>
                </div>
              )}

              <div className="max-w-[78%] flex flex-col gap-1">
                <div
                  className={[
                    'px-4 py-2.5 text-sm leading-relaxed',
                    msg.role === 'user'
                      ? 'bg-brand-600 text-white rounded-2xl rounded-br-md ml-auto'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-2xl rounded-bl-md',
                  ].join(' ')}
                >
                  {msg.content}
                </div>

                <span className={`text-[10px] text-gray-400 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                  {formatRelativeTime(msg.timestamp)}
                </span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* ── Phase 1: Thinking dots ─────────────────────────────────────────
          Shown when generating has started but the first token hasn't arrived.
          `streamingContent === ''` means we're in this "waiting" phase.
          Once tokens arrive, streamingContent becomes a non-empty string,
          this disappears, and the live bubble below takes over.
        ─────────────────────────────────────────────────────────────────── */}
        <AnimatePresence>
          {isGenerating && streamingContent === '' && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex gap-2 justify-start"
            >
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center">
                <span className="text-xs">🐾</span>
              </div>
              <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3 flex gap-1 items-center">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500 inline-block"
                    animate={{ y: [0, -4, 0] }}
                    transition={{ repeat: Infinity, duration: 0.7, delay: i * 0.15 }}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Phase 2: Live streaming bubble ─────────────────────────────────
          Once tokens arrive (streamingContent becomes non-empty), this bubble
          replaces the dots and fills in the text in real-time.
          A blinking cursor at the end signals that more is coming.

          This is a local-state render — does NOT go through the Zustand store.
          When `done` is received, `addMessage()` commits it to the store and
          this bubble unmounts, replaced by the new item in the messages array.
        ─────────────────────────────────────────────────────────────────── */}
        <AnimatePresence>
          {streamingContent && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex gap-2 justify-start"
            >
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mt-1">
                <span className="text-xs">🐾</span>
              </div>
              <div className="max-w-[78%] bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-relaxed">
                {streamingContent}
                {/* Blinking text cursor — signals the stream is still active */}
                <motion.span
                  className="inline-block w-0.5 h-4 bg-brand-400 ml-0.5 align-middle"
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ repeat: Infinity, duration: 0.8 }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Scroll anchor — always at the bottom of the list */}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-gray-100 dark:border-gray-800">

        <div className="flex items-end gap-2 bg-gray-50 dark:bg-gray-800/60 rounded-2xl px-4 py-2 border border-gray-100 dark:border-gray-700 focus-within:border-brand-400 transition-colors">
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your answer…"
            rows={1}
            disabled={currentStep === 'complete'}
            className="flex-1 bg-transparent resize-none text-sm outline-none text-gray-900 dark:text-gray-100 placeholder:text-gray-400 max-h-28 scrollbar-hidden leading-relaxed py-1 disabled:opacity-50"
            style={{ height: 'auto' }}
            onInput={(e) => {
              // Auto-grow the textarea up to max-h-28 (112px)
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
            }}
          />

          <motion.button
            whileTap={{ scale: 0.85 }}
            onClick={handleSend}
            disabled={!inputValue.trim() || isGenerating || currentStep === 'complete'}
            className="flex-shrink-0 w-8 h-8 rounded-full bg-brand-600 disabled:bg-gray-200 dark:disabled:bg-gray-700 flex items-center justify-center transition-colors mb-0.5"
            aria-label="Send message"
          >
            <Send className="w-3.5 h-3.5 text-white" />
          </motion.button>
        </div>

        {/* ── DEV controls ─────────────────────────────────────────────────
          These buttons let you manually advance the step machine or reset
          the interview during development — useful for testing each step
          without completing a full interview.  Hidden in production.
        ─────────────────────────────────────────────────────────────────── */}
        {import.meta.env.DEV && (
          <div className="mt-2 flex items-center justify-between px-1">
            <button
              onClick={advanceStep}
              className="text-xs text-brand-500 hover:text-brand-700 transition-colors font-medium"
            >
              [DEV] Next step →
            </button>
            <span className="text-[10px] text-gray-300 dark:text-gray-600 font-mono">
              {INTERVIEW_STEP_LABELS[currentStep]}
            </span>
            <button
              onClick={resetInterview}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
