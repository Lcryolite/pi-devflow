import assert from "node:assert/strict";
import test from "node:test";

import {
  addGoal,
  addTodo,
  blockTodo,
  createProjectState,
  markGrillAsked,
  reconcileProject,
  selectPendingGrill,
} from "../src/index.js";

test("a decision blocker produces one Grill question", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, { id: "goal", title: "Goal", objective: "Wait", successCriteria: [] }, "2026-07-30T00:00:01.000Z");
  state = addTodo(state, { id: "todo", goalId: "goal", title: "Choose target" }, "2026-07-30T00:00:02.000Z");
  state = blockTodo(state, "todo", {
    kind: "decision",
    reason: "Target is unknown",
    unlockCondition: "Choose staging or production",
    recommendedAnswer: "Use staging",
  }, "2026-07-30T00:00:03.000Z");
  state = reconcileProject(state, "2026-07-30T00:00:04.000Z");

  const pending = selectPendingGrill(state);
  assert.equal(pending?.question, "Choose staging or production");
  assert.equal(pending?.recommendedAnswer, "Use staging");

  state = markGrillAsked(state, pending!.key);
  assert.equal(selectPendingGrill(state), undefined);
});
