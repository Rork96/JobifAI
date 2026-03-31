/**
 * types/speech.d.ts — Web Speech API Type Declarations
 * ─────────────────────────────────────────────────────────────────────────────
 * TypeScript's built-in lib.dom.d.ts includes SpeechRecognitionAlternative,
 * SpeechRecognitionResult, and SpeechRecognitionResultList, but does NOT
 * include the SpeechRecognition class itself, its event types, or the
 * webkit-prefixed variant on `window`.
 *
 * These declarations fill the gap.  They mirror the W3C Web Speech API spec:
 * https://wicg.github.io/speech-api/
 *
 * WHY a separate .d.ts file instead of inline declarations in the hook?
 *   • .d.ts files are automatically ambient (global scope) — no import needed
 *   • Declarations in .ts files with exports are module-scoped by default
 *   • This file is included automatically because tsconfig.json includes "src"
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── SpeechRecognition event types ─────────────────────────────────────────────

/** Fired when a recognition result (interim or final) is available. */
interface SpeechRecognitionEvent extends Event {
  /** Index of the first new result in `results`. */
  readonly resultIndex: number;
  /** The list of all recognition results so far. */
  readonly results:     SpeechRecognitionResultList;
}

/** Fired when a speech recognition error occurs. */
interface SpeechRecognitionErrorEvent extends Event {
  /**
   * The error type — relevant values:
   *   'not-allowed'         — User denied microphone permission
   *   'service-not-allowed' — Browser policy prevented access (private mode, etc.)
   *   'no-speech'           — User was silent for too long
   *   'network'             — Network error during cloud recognition
   *   'aborted'             — recognition.abort() was called
   */
  readonly error:   string;
  readonly message: string;
}

// ── SpeechRecognition interface ───────────────────────────────────────────────

interface SpeechRecognition extends EventTarget {
  /** BCP-47 language tag for the recognition language (e.g. 'en-CA', 'fr'). */
  lang:            string;
  /** If true, recognition continues after each result (vs. single-utterance mode). */
  continuous:      boolean;
  /** If true, fires `onresult` with `isFinal=false` chunks during speech. */
  interimResults:  boolean;
  /** Number of alternative transcripts to return (we use 1). */
  maxAlternatives: number;

  /** Fires as transcription results arrive (interim or final). */
  onresult:        ((event: SpeechRecognitionEvent) => void) | null;
  /** Fires when recognition stops (normally or after error). */
  onend:           ((event: Event) => void) | null;
  /** Fires when recognition begins receiving audio. */
  onstart:         ((event: Event) => void) | null;
  /** Fires when an error occurs. */
  onerror:         ((event: SpeechRecognitionErrorEvent) => void) | null;

  /** Start recognition (triggers the browser microphone permission prompt on first call). */
  start():  void;
  /** Gracefully stop — finalises any pending utterance before ending. */
  stop():   void;
  /** Immediately abort recognition (pending results are discarded). */
  abort():  void;
}

/** Constructor interface for SpeechRecognition. */
interface SpeechRecognitionConstructor {
  prototype: SpeechRecognition;
  new(): SpeechRecognition;
}

// ── Global declarations ───────────────────────────────────────────────────────

declare var SpeechRecognition: SpeechRecognitionConstructor | undefined;

interface Window {
  /** Standard SpeechRecognition (Chrome 33+, Edge 79+). */
  SpeechRecognition:       SpeechRecognitionConstructor | undefined;
  /** Webkit-prefixed SpeechRecognition (Safari 14.1+, older Chrome). */
  webkitSpeechRecognition: SpeechRecognitionConstructor | undefined;
}
