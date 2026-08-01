import { markContinuation } from "./scheduler.js";
import type { ProjectState } from "./types.js";

export type ContinuationClaimOutcome = "claimed" | "expired" | "stale";

/** Pure policy for whether a continuation key can be claimed by the main agent. */
export function resolveContinuationClaim(state: ProjectState, key: string): ContinuationClaimOutcome {
  const record = state.scheduler.continuationKeys[key];
  const todo = record ? state.todos[record.todoId] : undefined;
  if (record?.status === "sent" && todo?.status === "in_progress" && state.scheduler.activeLeases[todo.id]) {
    return "claimed";
  }
  if (record && record.status !== "expired") return "expired";
  return "stale";
}

/** Apply claim/expire for a continuation key. Returns next state and whether the prompt is stale. */
export function applyContinuationClaim(
  state: ProjectState,
  key: string,
): { state: ProjectState; stale: boolean; outcome: ContinuationClaimOutcome } {
  const outcome = resolveContinuationClaim(state, key);
  if (outcome === "claimed") {
    return { state: markContinuation(state, key, "claimed"), stale: false, outcome };
  }
  if (outcome === "expired") {
    return { state: markContinuation(state, key, "expired"), stale: true, outcome };
  }
  return { state, stale: true, outcome };
}
