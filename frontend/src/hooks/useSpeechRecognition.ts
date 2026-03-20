/**
 * hooks/useSpeechRecognition.ts — Web Speech API wrapper
 * ─────────────────────────────────────────────────────────────────────────────
 * Wraps the browser's SpeechRecognition API (and its webkit vendor prefix)
 * into a clean, self-contained React hook.
 *
 * WHY a custom hook instead of a library?
 *   • The Web Speech API surface is small — we only need `start/stop`
 *   • Zero bundle-size overhead (native browser API, no JS)
 *   • Full control over UX decisions (interim results, language, restart logic)
 *   • Libraries often hide the `interimResults` feature which is critical for
 *     the live "see your words appear as you speak" typewriter experience
 *
 * IMPORTANT BROWSER COMPATIBILITY:
 *   Chrome/Edge  — Full support (SpeechRecognition)
 *   Safari/iOS   — Full support via webkitSpeechRecognition
 *   Firefox      — NOT supported (as of 2026); hook returns isSupported=false
 *   Firefox users see a polite tooltip on the mic button instead of an error.
 *
 * HOW INTERIM RESULTS WORK:
 *   SpeechRecognition fires `onresult` continuously while the user speaks.
 *   Each result is either:
 *     isFinal=false → "interim" — live best-guess, may change as the user says more
 *     isFinal=true  → "final"   — committed transcript, will not change
 *
 *   We expose both so ChatPanel can show live text in the textarea while the
 *   user speaks, then commit the final result when they pause.
 *
 * PERMISSION HANDLING:
 *   First call to `startListening()` triggers the browser permission prompt.
 *   If the user denies: `permissionDenied` is set to true and the mic button
 *   updates its tooltip/state to explain why it's disabled.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── Type declarations ─────────────────────────────────────────────────────────
// SpeechRecognition, SpeechRecognitionEvent, and SpeechRecognitionErrorEvent
// are declared globally in src/types/speech.d.ts (TypeScript's built-in DOM
// lib only ships the Result/Alternative subtypes, not the main class itself).

// ── Return type ───────────────────────────────────────────────────────────────
export interface SpeechRecognitionState {
  /** True if the browser supports any form of SpeechRecognition. */
  isSupported: boolean;
  /** True while the microphone is active and listening. */
  isListening: boolean;
  /**
   * Live interim transcript — updates every few hundred ms while the user speaks.
   * Resets to '' each time the user starts a new utterance.
   * Show this in the textarea to give a live typewriter effect.
   */
  interimText: string;
  /**
   * The committed final transcript for the current recording session.
   * Accumulated across all final result chunks (handles long utterances).
   * Resets to '' on the next `startListening()` call.
   */
  finalText: string;
  /**
   * True after the user explicitly denied microphone access.
   * The mic button shows a "Permission denied" tooltip when this is true.
   * Stays true for the session — the user must change it in browser settings.
   */
  permissionDenied: boolean;
  /** Begin recording. No-op if already listening or not supported. */
  startListening: () => void;
  /** Stop recording gracefully — fires `onend` which will flush any pending final result. */
  stopListening: () => void;
}

// ── Hook ─────────────────────────────────────────────────────────────────────
/**
 * @param lang — BCP-47 language code to recognise (e.g. 'en-CA', 'fr', 'es').
 *               Pass the user's `userLang` from the Zustand store so recognition
 *               matches the language of the interview.
 */
export function useSpeechRecognition(lang: string): SpeechRecognitionState {

  const [isListening,     setIsListening]     = useState(false);
  const [interimText,     setInterimText]      = useState('');
  const [finalText,       setFinalText]        = useState('');
  const [permissionDenied, setPermissionDenied] = useState(false);

  // We hold the SpeechRecognition instance in a ref so:
  //   1. We can call .stop() from `stopListening` without a re-render
  //   2. The instance survives across re-renders
  //   3. We can abort it on unmount
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // ── Feature detection ───────────────────────────────────────────────────────
  // `useMemo` so this is computed once on mount, not every render.
  const isSupported = useMemo(() => {
    if (typeof window === 'undefined') return false;  // SSR guard
    return !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);
  }, []);

  // ── startListening ──────────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (!isSupported || isListening) return;

    // Resolve the vendor-prefixed constructor
    const SpeechRecognitionImpl = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) return;

    const recognition = new SpeechRecognitionImpl();

    // ── Configuration ──────────────────────────────────────────────────────
    recognition.lang            = lang;
    // interimResults=true: fire onresult with isFinal=false during speech.
    // This powers the live typewriter effect in the textarea.
    recognition.interimResults  = true;
    // continuous=true: recognition keeps running until the user manually stops
    // (presses the mic button again).  This prevents early cutoff on natural
    // pauses mid-sentence and lets users dictate longer answers without
    // having to tap the mic again.  The mic button always shows the stop icon
    // while active, making the state clear to the user.
    recognition.continuous      = true;
    // Retrieve the most likely transcription (index 0)
    recognition.maxAlternatives = 1;

    // ── Event handlers ─────────────────────────────────────────────────────

    recognition.onstart = () => {
      // Clear previous session's data on a fresh start
      setFinalText('');
      setInterimText('');
      setIsListening(true);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Loop through results since the last `resultIndex` change.
      // In non-continuous mode this is usually just one result, but we
      // loop defensively in case of rapid speech returning multiple finals.
      let accumulated = '';
      let interim     = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          accumulated += transcript;
        } else {
          interim += transcript;  // May update several times per second
        }
      }

      // Update interim immediately for the live typewriter effect.
      // `interimText` is replaced (not appended) because the browser
      // refines its best-guess and may shorten/alter what it said before.
      setInterimText(interim);

      // Append committed finals to the session accumulator.
      // We use the functional form to safely accumulate across multiple
      // `onresult` fires without stale-closure issues.
      if (accumulated) {
        setFinalText((prev) => (prev + ' ' + accumulated).trim());
        setInterimText('');  // Final arrived — clear the interim
      }
    };

    recognition.onend = () => {
      // Called when recognition stops (auto-silence OR manual .stop()).
      // Clear interim — any un-finalised speech at the time of stop is lost.
      setInterimText('');
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // `not-allowed`         — user denied mic permission
      // `service-not-allowed` — browser policy (private mode, data saver, etc.)
      // `no-speech`           — user was silent; handled gracefully (no error shown)
      // `network`             — network error during cloud recognition
      // `aborted`             — we called .abort() intentionally (unmount)
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setPermissionDenied(true);
      }
      // All errors end the session — onend fires automatically after onerror
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;

    // This triggers the permission prompt on first call.
    // Subsequent calls skip the prompt (browser caches the grant).
    recognition.start();
  }, [isSupported, isListening, lang]);  // lang in deps: re-creates if user changes language mid-session

  // ── stopListening ────────────────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    // .stop() gracefully finalises any pending speech before ending.
    // .abort() would discard in-progress results — we don't want that.
    recognitionRef.current?.stop();
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      // .abort() discards any pending result — that's fine on unmount
      // since there's no component to receive it anymore.
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  return {
    isSupported,
    isListening,
    interimText,
    finalText,
    permissionDenied,
    startListening,
    stopListening,
  };
}
