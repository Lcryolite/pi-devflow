import type { ProjectState } from "./types.js";

export interface GoalAudit {
  goalId: string;
  revision: number;
  status: "done" | "partial" | "blocked" | "cancelled";
  criteria: Array<{
    criterionId: string;
    required: boolean;
    evidenceIds: string[];
    satisfied: boolean;
    reason?: string;
  }>;
  incompleteTodoIds: string[];
  blockedTodoIds: string[];
  invalidEvidenceIds: string[];
  requiresJudge: boolean;
}

export function auditGoal(state: ProjectState, goalId: string): GoalAudit {
  const goal = state.goals[goalId];
  if (!goal) throw new Error(`Goal ${goalId} does not exist`);
  const invalidEvidenceIds = new Set<string>();
  let requiresJudge = false;
  const criteria = goal.successCriteria.map((criterion) => {
    const evidence = criterion.evidenceIds.map((id) => state.evidence[id]);
    for (const [index, item] of evidence.entries()) {
      if (!item?.valid) invalidEvidenceIds.add(criterion.evidenceIds[index]!);
    }
    const hasValid = evidence.some((item) => item?.valid);
    const hasJudge = evidence.some((item) => item?.valid && (item.kind === "review" || item.kind === "workflow"));
    const satisfied = (!criterion.required || hasValid) && (!criterion.requiresJudge || hasJudge);
    if (criterion.requiresJudge && !hasJudge) requiresJudge = true;
    return {
      criterionId: criterion.id,
      required: criterion.required,
      evidenceIds: [...criterion.evidenceIds],
      satisfied,
      ...(!satisfied ? { reason: criterion.requiresJudge && !hasJudge ? "judge evidence required" : "valid evidence required" } : {}),
    };
  });
  const todos = Object.values(state.todos).filter((todo) => todo.goalId === goalId && todo.required);
  const incompleteTodoIds = todos.filter((todo) => todo.status !== "completed").map((todo) => todo.id);
  const blockedTodoIds = todos.filter((todo) => todo.status === "blocked").map((todo) => todo.id);
  const done = criteria.every((criterion) => criterion.satisfied) && incompleteTodoIds.length === 0;
  const status = goal.status === "cancelled" ? "cancelled" : done ? "done" : blockedTodoIds.length > 0 ? "blocked" : "partial";
  return {
    goalId,
    revision: state.revision,
    status,
    criteria,
    incompleteTodoIds,
    blockedTodoIds,
    invalidEvidenceIds: [...invalidEvidenceIds],
    requiresJudge,
  };
}

export function completeGoalFromAudit(state: ProjectState, audit: GoalAudit, now: string): ProjectState {
  if (audit.revision !== state.revision) throw new Error("Goal audit revision is stale");
  const fresh = auditGoal(state, audit.goalId);
  if (fresh.status !== "done" || audit.status !== "done") throw new Error(`Goal ${audit.goalId} audit is ${fresh.status}, not done`);
  const next = structuredClone(state);
  const goal = next.goals[audit.goalId];
  if (!goal) throw new Error(`Goal ${audit.goalId} does not exist`);
  if (goal.status === "cancelled") throw new Error(`Goal ${audit.goalId} is cancelled`);
  goal.status = "completed";
  goal.completedAt = now;
  goal.updatedAt = now;
  next.project.updatedAt = now;
  return next;
}
