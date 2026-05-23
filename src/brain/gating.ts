import type { EntryStatus } from "./types.js";

export const PUBLISH_THRESHOLD = 0.8;
export const PENDING_THRESHOLD = 0.5;

export function statusForConfidence(c: number): EntryStatus | "discard" {
  if (c >= PUBLISH_THRESHOLD) return "published";
  if (c >= PENDING_THRESHOLD) return "pending";
  return "discard";
}

// New items get priority up to the cap; backfill takes the remaining budget.
export function splitBudget(
  maxItems: number,
  newAvailable: number,
): { newBudget: number; backfillBudget: number } {
  const newBudget = Math.min(newAvailable, maxItems);
  return { newBudget, backfillBudget: maxItems - newBudget };
}
