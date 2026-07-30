import assert from "node:assert/strict";
import test from "node:test";

import { addGoal, applyNormalizationProposal, createProjectState } from "../src/index.js";

test("a request without independent value is merged as a dependent Todo", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, { id: "goal-a", title: "Fix C", objective: "Fix C", successCriteria: [] }, "2026-07-30T00:00:01.000Z");
  const proposal = {
    id: "proposal-1",
    action: "merge_as_todo" as const,
    rationale: "The review only has value after C is fixed",
    sourceRequest: "Then review C",
    targetGoalId: "goal-a",
    todo: { id: "review-c", title: "Review fixed C", dependsOn: [] },
  };

  state = applyNormalizationProposal(state, proposal, "2026-07-30T00:00:02.000Z");
  const replayed = applyNormalizationProposal(state, proposal, "2026-07-30T00:00:03.000Z");

  assert.equal(state.goals["goal-a"]?.rootTodoIds[0], "review-c");
  assert.equal(state.todos["review-c"]?.sourceRequest, "Then review C");
  assert.equal(Object.keys(replayed.todos).length, 1);
});

test("an ask proposal does not mutate canonical state", () => {
  const state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  const next = applyNormalizationProposal(state, {
    id: "proposal-ask", action: "ask", question: "Which target?", recommendedAnswer: "Use staging", missingDecision: "target",
  }, "2026-07-30T00:00:01.000Z");
  assert.deepEqual(next, state);
});


test("a normalized Goal gets a system-managed executable root Todo", () => {
  const state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  const next = applyNormalizationProposal(state, {
    id: "proposal-goal", action: "create_goal", rationale: "independent", sourceRequest: "Ship it",
    goal: { id: "goal", title: "Ship", objective: "Ship it", successCriteria: [] },
  }, "2026-07-30T00:00:01.000Z");
  assert.equal(next.todos["goal:root"]?.systemManaged, true);
  assert.equal(next.goals.goal?.rootTodoIds[0], "goal:root");
});
