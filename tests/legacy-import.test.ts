import assert from "node:assert/strict";
import test from "node:test";

import { createProjectState, importLegacyBranch, validateProject } from "../src/index.js";

const branch = [
  {
    type: "custom", customType: "pi-codex-goal", data: {
      version: 1, kind: "set", source: "tool", at: 1,
      goal: { goalId: "old-goal", objective: "Ship the old work", status: "active", tokenBudget: null, usage: { tokensUsed: 1, activeSeconds: 1 }, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_100 },
    },
  },
  {
    type: "message", message: { role: "toolResult", toolName: "todo", details: {
      action: "list", params: {}, nextId: 4,
      tasks: [
        { id: 1, subject: "First", status: "completed" },
        { id: 2, subject: "Second", status: "pending", blockedBy: [1] },
        { id: 3, subject: "Removed", status: "deleted" },
      ],
    } },
  },
];

test("legacy session Goal and Todo snapshots import atomically and idempotently", () => {
  const state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  const imported = importLegacyBranch(state, branch, "2026-07-30T00:00:01.000Z");
  assert.equal(imported.applied, true);
  assert.equal(imported.state.goals["old-goal"]?.objective, "Ship the old work");
  assert.deepEqual(imported.state.todos["legacy-todo-2"]?.dependsOn, ["legacy-todo-1"]);
  assert.match(imported.warnings.join(" "), /Deleted/);
  validateProject(imported.state);

  const replay = importLegacyBranch(imported.state, branch, "2026-07-30T00:00:02.000Z");
  assert.equal(replay.applied, false);
  assert.equal(Object.keys(replay.state.goals).length, 1);
  const evolved = structuredClone(branch) as Array<Record<string, any>>;
  evolved[1]!.message.details.tasks[1].status = "completed";
  const evolvedReplay = importLegacyBranch(imported.state, evolved, "2026-07-30T00:00:03.000Z");
  assert.equal(evolvedReplay.applied, false);
  assert.equal(Object.keys(evolvedReplay.state.todos).length, 2);
});


test("paused legacy Goals import with a recoverable decision blocker", () => {
  const state = createProjectState("/repo", "2026-07-30T00:00:00.000Z");
  const paused = structuredClone(branch.slice(0, 1)) as Array<{ data: { goal: { status: string } } }>;
  paused[0]!.data.goal.status = "paused";
  const imported = importLegacyBranch(state, paused, "2026-07-30T00:00:01.000Z");
  const resume = Object.values(imported.state.todos).find((todo) => todo.title === "Confirm legacy Goal resume");
  assert.equal(resume?.status, "blocked");
  assert.equal(resume?.blocker?.kind, "decision");
});
