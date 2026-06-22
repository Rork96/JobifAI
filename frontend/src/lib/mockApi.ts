/**
 * mockApi.ts — Phase 4 stub. Swapped for the real backend call in Phase 5.
 *
 * Intentional design:
 *   - Same request/response shape as POST /api/rewrite-section so Phase 5
 *     is a single import-swap with zero interface changes.
 *   - 2-second delay simulates real network + model latency so the full
 *     ChatInput → skeleton → SandwichDiffInline → Accept/Reject loop can be
 *     verified before any live API dependency is introduced.
 *   - `new_text` echoes the user's instruction back so it's obvious the binding
 *     is working (the specific bullet text + the specific instruction appear).
 *   - `predicted_score_increase` is a fixed 5 — enough to exercise all the
 *     score-impact display paths in SandwichDiffInline and WorkspaceNavbar.
 */

const MOCK_DELAY_MS = 2000;

// ── Request / Response — mirrors RewriteRequest / RewriteResponse in api.ts ──

export interface MockRewriteRequest {
  old_text:        string;
  instruction:     string;
  job_description: string;
}

export interface MockRewriteResponse {
  new_text:                  string;
  predicted_score_increase:  number;
}

/**
 * Fake rewrite — waits MOCK_DELAY_MS then returns a new_text that visibly
 * incorporates both the original bullet and the user's instruction.
 */
export async function mockRewriteBullet(
  req: MockRewriteRequest,
): Promise<MockRewriteResponse> {
  await new Promise<void>(resolve => setTimeout(resolve, MOCK_DELAY_MS));

  const instrSnippet = req.instruction.length > 50
    ? req.instruction.slice(0, 50) + '…'
    : req.instruction;

  return {
    new_text: `${req.old_text} [mock: "${instrSnippet}"]`,
    predicted_score_increase: 5,
  };
}
