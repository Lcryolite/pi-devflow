import { normalizeTitle } from "./text.js";
import type { ExecutionMode, ProjectState, ResourceClaim, TodoStatus, WorkflowPlanData } from "./types.js";

function copy(state: ProjectState): ProjectState {
  return structuredClone(state);
}

export function updateGoal(
  state: ProjectState,
  goalId: string,
  patch: { title?: string; objective?: string; constraints?: string[]; nonGoals?: string[]; evidenceRequirements?: string[] },
  now: string,
): ProjectState {
  const next = copy(state);
  const goal = next.goals[goalId];
  if (!goal) throw new Error(`Goal ${goalId} does not exist`);
  if (patch.title !== undefined) goal.title = normalizeTitle(patch.title);
  if (patch.objective !== undefined) goal.objective = patch.objective;
  if (patch.constraints !== undefined) goal.constraints = [...patch.constraints];
  if (patch.nonGoals !== undefined) goal.nonGoals = [...patch.nonGoals];
  if (patch.evidenceRequirements !== undefined) goal.evidenceRequirements = [...patch.evidenceRequirements];
  goal.updatedAt = now;
  return next;
}

export function cancelGoal(state: ProjectState, goalId: string, now: string): ProjectState {
  const next = copy(state);
  const goal = next.goals[goalId];
  if (!goal) throw new Error(`Goal ${goalId} does not exist`);
  goal.status = "cancelled";
  goal.updatedAt = now;
  for (const todo of Object.values(next.todos)) {
    if (todo.goalId === goalId && todo.status !== "completed") {
      todo.status = "cancelled";
      todo.updatedAt = now;
    }
  }
  return next;
}

export function updateTodo(
  state: ProjectState,
  todoId: string,
  patch: { title?: string; description?: string; required?: boolean; execution?: ExecutionMode; status?: TodoStatus; resourceClaims?: ResourceClaim[]; workflowPlan?: WorkflowPlanData },
  now: string,
): ProjectState {
  const next = copy(state);
  const todo = next.todos[todoId];
  if (!todo) throw new Error(`Todo ${todoId} does not exist`);
  const previousStatus = todo.status;
  if (patch.title !== undefined) todo.title = normalizeTitle(patch.title);
  if (patch.description !== undefined) todo.description = patch.description;
  if (patch.required !== undefined) todo.required = patch.required;
  if (patch.execution !== undefined) todo.execution = patch.execution;
  if (patch.status !== undefined) todo.status = patch.status;
  if (patch.resourceClaims !== undefined) todo.resourceClaims = structuredClone(patch.resourceClaims);
  if (patch.workflowPlan !== undefined) todo.workflowPlan = structuredClone(patch.workflowPlan);
  if (patch.status !== "blocked") delete todo.blocker;
  if (patch.status === "completed") todo.completedAt = now;
  if (patch.status && ["pending", "ready"].includes(patch.status) && !["pending", "ready"].includes(previousStatus)) {
    todo.executionGeneration += 1;
    delete next.scheduler.activeLeases[todoId];
    for (const [key, record] of Object.entries(next.scheduler.continuationKeys)) {
      if (record.todoId === todoId) delete next.scheduler.continuationKeys[key];
    }
  }
  todo.updatedAt = now;
  return next;
}

export function moveTodo(state: ProjectState, todoId: string, parentId: string | undefined, now: string): ProjectState {
  const next = copy(state);
  const todo = next.todos[todoId];
  if (!todo) throw new Error(`Todo ${todoId} does not exist`);
  if (parentId === todoId) throw new Error("A todo cannot be its own parent");
  const parent = parentId ? next.todos[parentId] : undefined;
  if (parentId && !parent) throw new Error(`Parent todo ${parentId} does not exist`);
  if (parent && parent.goalId !== todo.goalId) throw new Error("Parent todo belongs to a different goal");

  if (todo.parentId) {
    const oldParent = next.todos[todo.parentId];
    if (oldParent) oldParent.childIds = oldParent.childIds.filter((id) => id !== todoId);
  } else {
    const goal = next.goals[todo.goalId]!;
    goal.rootTodoIds = goal.rootTodoIds.filter((id) => id !== todoId);
  }

  if (parentId) {
    todo.parentId = parentId;
    parent!.childIds.push(todoId);
  } else {
    delete todo.parentId;
    next.goals[todo.goalId]!.rootTodoIds.push(todoId);
  }
  todo.updatedAt = now;
  return next;
}

export function recordTodoFailure(
  state: ProjectState,
  todoId: string,
  strategy: string,
  reason: string,
  evidenceIds: string[],
  now: string,
): ProjectState {
  const next = copy(state);
  const todo = next.todos[todoId];
  if (!todo) throw new Error(`Todo ${todoId} does not exist`);
  if (todo.attempts.filter((attempt) => attempt.outcome === "failed").length >= 2) {
    throw new Error(`Todo ${todoId} exhausted its two recovery attempts`);
  }
  if (todo.attempts.some((attempt) => attempt.strategy === strategy)) {
    throw new Error(`Todo ${todoId} already tried recovery strategy: ${strategy}`);
  }
  todo.attempts.push({
    index: todo.attempts.length + 1,
    strategy,
    evidenceIds: [...evidenceIds],
    outcome: "failed",
    startedAt: now,
    endedAt: now,
  });
  todo.status = "blocked";
  todo.blocker = { kind: "tool", reason, sourceIds: [...evidenceIds] };
  todo.updatedAt = now;
  return next;
}

export function retryTodo(state: ProjectState, todoId: string, strategy: string, now: string): ProjectState {
  const next = copy(state);
  const todo = next.todos[todoId];
  if (!todo) throw new Error(`Todo ${todoId} does not exist`);
  if (todo.status !== "blocked") throw new Error(`Todo ${todoId} is not blocked`);
  if (todo.attempts.filter((attempt) => attempt.outcome === "failed").length >= 2) {
    throw new Error(`Todo ${todoId} exhausted its two recovery attempts`);
  }
  if (todo.attempts.some((attempt) => attempt.strategy === strategy)) {
    throw new Error(`Todo ${todoId} already tried recovery strategy: ${strategy}`);
  }
  todo.status = "pending";
  delete todo.blocker;
  todo.executionGeneration += 1;
  todo.updatedAt = now;
  delete next.scheduler.activeLeases[todoId];
  for (const [key, record] of Object.entries(next.scheduler.continuationKeys)) {
    if (record.todoId === todoId) delete next.scheduler.continuationKeys[key];
  }
  return next;
}


export function blockTodo(
  state: ProjectState,
  todoId: string,
  blocker: {
    kind: "decision" | "permission" | "resource" | "validation" | "workflow" | "tool";
    reason: string;
    unlockCondition?: string;
    recommendedAnswer?: string;
    sourceIds?: string[];
  },
  now: string,
): ProjectState {
  const next = copy(state);
  const todo = next.todos[todoId];
  if (!todo) throw new Error(`Todo ${todoId} does not exist`);
  todo.status = "blocked";
  todo.blocker = {
    kind: blocker.kind,
    reason: blocker.reason,
    ...(blocker.unlockCondition ? { unlockCondition: blocker.unlockCondition } : {}),
    ...(blocker.recommendedAnswer ? { recommendedAnswer: blocker.recommendedAnswer } : {}),
    sourceIds: [...(blocker.sourceIds ?? [])],
  };
  todo.updatedAt = now;
  return next;
}

export function setSchedulerPaused(state: ProjectState, paused: boolean): ProjectState {
  const next = copy(state);
  next.scheduler.paused = paused;
  return next;
}

export function markGrillAsked(state: ProjectState, blockerKey: string, sessionId?: string): ProjectState {
  const next = copy(state);
  next.scheduler.grill ??= { lastAskedBlockerKeys: {} };
  next.scheduler.grill.lastAskedBlockerKeys ??= {};
  if (sessionId) next.scheduler.grill.lastAskedBlockerKeys[sessionId] = blockerKey;
  else next.scheduler.grill.lastAskedBlockerKey = blockerKey;
  return next;
}
