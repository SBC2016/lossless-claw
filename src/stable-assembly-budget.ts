/**
 * Cache-stable assembly budget.
 *
 * Inside one long agent turn the host passes a smaller `tokenBudget` on every
 * request (the growing current turn takes room out of it). Assembling to the
 * exact budget each time moves the eviction / live-clamp boundary on every
 * request, so the prompt prefix changes and prefix-caching providers re-read
 * the whole prompt. This helper holds the effective budget steady while the
 * host budget only drifts down, and drops it once, with headroom, when the
 * host budget falls below it.
 *
 * A large single drop (more than half of the previous host budget) is a real
 * change of limits, not drift, and is followed exactly.
 */

export const STABLE_BUDGET_HEADROOM_RATIO = 0.6;
export const STABLE_BUDGET_DRIFT_RATIO = 0.5;

export type StableBudgetState = {
  /** Budget the host gave us on the previous call. */
  hostBudget: number;
  /** Budget we actually assembled to on the previous call. */
  effectiveBudget: number;
};

export function resolveStableAssemblyBudget(params: {
  hostBudget: number;
  previous: StableBudgetState | undefined;
  headroomRatio?: number;
  driftRatio?: number;
}): { budget: number; state: StableBudgetState } {
  const host = Math.max(1, Math.floor(params.hostBudget));
  const headroom = params.headroomRatio ?? STABLE_BUDGET_HEADROOM_RATIO;
  const drift = params.driftRatio ?? STABLE_BUDGET_DRIFT_RATIO;
  const prev = params.previous;
  let effective = host;
  // A larger host budget than last time (new turn, or room freed by a
  // compaction) resets to the full budget; so does a large drop.
  if (prev && host <= prev.hostBudget && host >= Math.floor(prev.hostBudget * drift)) {
    // Same or shrinking host budget (same turn): keep the previous boundary
    // while it still fits; otherwise step down once with headroom.
    effective = prev.effectiveBudget <= host
      ? prev.effectiveBudget
      : Math.max(1, Math.floor(host * headroom));
  }
  return { budget: effective, state: { hostBudget: host, effectiveBudget: effective } };
}
