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
 * This is a "controlled" component in the sense that ALL state lives in the
 * Zustand store.  ChatPanel only reads and writes the store — it has no local
 * state except the controlled input value.
 *
 * TASK 4 INTEGRATION POINT:
 *   The `handleSend` function is where the Gemini multi-agent pipeline plugs in.
 *   Right now it mocks an AI response with a setTimeout.  In Task 4, replace the
 *   mock with:
 *     const response = await callGeminiAgent(inputValue, { currentStep, resumeData, userLang });
 *     addMessage({ role: 'assistant', content: response.text });
 *     if (response.shouldAdvance) advanceStep();
 *     if (response.dataUpdate) updateResumeData(response.dataUpdate);
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, RotateCcw } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { INTERVIEW_STEP_PROMPTS, INTERVIEW_STEP_LABELS } from '@/types';
import { MacMascot } from '@/components/mascot/MacMascot';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Converts a Unix timestamp to a human-readable relative time (e.g. "2m ago"). */
const formatRelativeTime = (timestamp: number): string => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60)  return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};

// ── Component ─────────────────────────────────────────────────────────────────
export const ChatPanel: React.FC = () => {
  // ── Local state ─────────────────────────────────────────────────────────────
  // Input value is the ONLY local state here — everything else is in the store.
  // We keep it local because it changes on every keystroke and we don't want
  // to trigger store subscribers (like DocumentPreview) on every key press.
  const [inputValue, setInputValue] = useState('');

  // Ref to the bottom of the message list — used for auto-scroll.
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ── Store subscriptions ──────────────────────────────────────────────────────
  // Subscribe to each field individually so this component only re-renders
  // when ONE of these specific values changes.
  const currentStep   = useAppStore((s) => s.currentStep);
  const messages      = useAppStore((s) => s.messages);
  const isGenerating  = useAppStore((s) => s.isGenerating);
  const userLang      = useAppStore((s) => s.userLang);

  // Actions — stable references (Zustand guarantees these never change)
  const addMessage        = useAppStore((s) => s.addMessage);
  const advanceStep       = useAppStore((s) => s.advanceStep);
  const setIsGenerating   = useAppStore((s) => s.setIsGenerating);
  const resetInterview    = useAppStore((s) => s.resetInterview);

  // ── Auto-scroll ──────────────────────────────────────────────────────────────
  // Scrolls to the latest message whenever the messages array changes.
  // `{ behavior: 'smooth' }` gives a nice scroll animation but can be
  // jarring if the user is reading old messages — consider disabling smooth
  // scroll if the user is not near the bottom (a future improvement).
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send handler ─────────────────────────────────────────────────────────────
  const handleSend = () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isGenerating) return;

    // 1. Add the user's message to the store immediately (optimistic update)
    addMessage({ role: 'user', content: trimmed });
    setInputValue('');

    // 2. Show Mac "thinking" state
    setIsGenerating(true);

    // ── TODO (Task 4): Replace this mock with the real Gemini agent call ──────
    // The mock simulates network latency and a basic AI response.
    setTimeout(() => {
      addMessage({
        role: 'assistant',
        content: `[Mock — ${INTERVIEW_STEP_LABELS[currentStep]}] Got it! Keep going 🐾`,
      });
      setIsGenerating(false);
    }, 900);
    // ────────────────────────────────────────────────────────────────────────────
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter, allow Shift+Enter for newlines
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

        {/* Empty state */}
        {messages.length === 0 && (
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

        {/* Message bubbles */}
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              layout                        // Smooth reflow when new messages push old ones up
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0,  scale: 1 }}
              exit={{   opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {/* Mac avatar dot for assistant messages */}
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

                {/* Timestamp — shown on hover in a real app; always shown here for simplicity */}
                <span className={`text-[10px] text-gray-400 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                  {formatRelativeTime(msg.timestamp)}
                </span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Typing indicator — shown while Mac is generating */}
        <AnimatePresence>
          {isGenerating && (
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
            // Auto-grow textarea up to max-h-28
            style={{ height: 'auto' }}
            onInput={(e) => {
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

        {/* ── DEV controls ─────────────────────────────────────────────── */}
        {/* Remove these in Task 4 once the AI handles step progression. */}
        {import.meta.env.DEV && (
          <div className="mt-2 flex items-center justify-between px-1">
            <button
              onClick={advanceStep}
              className="text-xs text-brand-500 hover:text-brand-700 transition-colors font-medium"
            >
              [DEV] Next step →
            </button>
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
