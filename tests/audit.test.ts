import assert from "node:assert/strict";
import test from "node:test";

import {
  addCriterionEvidence,
  addEvidence,
  addGoal,
  addTodo,
  auditGoal,
  completeGoalFromAudit,
  createProjectState,
} from "../src/index.js";

test("completion audit rejects invalid evidence and accepts validated evidence", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, {
    id: "goal", title: "Audit", objective: "Prove it",
    successCriteria: [{ id: "criterion", text: "Tests pass", required: true, evidenceIds: [] }],
  }, "2026-07-30T00:00:01.000Z");
  state = addEvidence(state, {
    id: "test", ownerSessionId: "legacy-unowned", kind: "test", summary: "npm test", observedAt: "2026-07-30T00:00:02.000Z", valid: false,
  });
  state = addCriterionEvidence(state, "goal", "criterion", "test", "2026-07-30T00:00:03.000Z");

  assert.equal(auditGoal(state, "goal").status, "partial");

  state.evidence.test!.valid = true;
  const audit = auditGoal(state, "goal");
  assert.equal(audit.status, "done");
  state = completeGoalFromAudit(state, audit, "2026-07-30T00:00:04.000Z");
  assert.equal(state.goals.goal?.status, "completed");
});

test("completion audit is revision-bound", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, { id: "goal", title: "Audit", objective: "Done", successCriteria: [] }, "2026-07-30T00:00:01.000Z");
  const audit = auditGoal(state, "goal");
  state.revision += 1;
  assert.throws(() => completeGoalFromAudit(state, audit, "2026-07-30T00:00:02.000Z"), /revision/);
});


test("cancelled required Todos and fabricated audits cannot complete a Goal", () => {
  let state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  state = addGoal(state, { id: "goal", title: "Audit", objective: "Done", successCriteria: [] }, "2026-07-30T00:00:01.000Z");
  state = addTodo(state, { id: "required", goalId: "goal", title: "Required" }, "2026-07-30T00:00:02.000Z");
  state.todos.required!.status = "cancelled";
  const audit = auditGoal(state, "goal");
  assert.equal(audit.status, "partial");
  assert.throws(() => completeGoalFromAudit(state, { ...audit, status: "done" }, "2026-07-30T00:00:03.000Z"), /partial/);
});
