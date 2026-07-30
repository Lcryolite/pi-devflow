import { createHash } from "node:crypto";
import { auditGoal, completeGoalFromAudit } from "./audit.js";

import type { AddGoalInput, AddTodoInput, ProjectState, TodoStatus } from "./types.js";

function clone(state: ProjectState): ProjectState {
  return structuredClone(state);
}


const reservedRecordKeys = new Set(["__proto__", "prototype", "constructor"]);

export function assertSafeRecordKey(value: string, label: string): void {
  if (!value.trim() || reservedRecordKeys.has(value)) throw new Error(`${label} is not a safe identifier`);
}

export function createProjectState(root: string, now: string): ProjectState {
  return {
    schemaVersion: 2,
    revision: 0,
    project: {
      id: createHash("sha256").update(root).digest("hex").slice(0, 16),
      root,
      createdAt: now,
      updatedAt: now,
    },
    goals: {},
    todos: {},
    evidence: {},
    workflowRuns: {},
    locks: {},
    scheduler: {
      paused: false,
      maxConcurrentMain: 1,
      maxConcurrentWorkflow: 2,
      grill: {},
      continuationKeys: {},
      activeLeases: {},
    },
    appliedProposalIds: [],
    migrations: {},
  };
}

export function addGoal(state: ProjectState, input: AddGoalInput, now: string): ProjectState {
  assertSafeRecordKey(input.id, "Goal id");
  if (state.goals[input.id]) throw new Error(`Goal ${input.id} already exists`);
  const next = clone(state);
  next.goals[input.id] = {
    id: input.id,
    title: input.title,
    objective: input.objective,
    successCriteria: structuredClone(input.successCriteria),
    constraints: [...(input.constraints ?? [])],
    nonGoals: [...(input.nonGoals ?? [])],
    evidenceRequirements: [...(input.evidenceRequirements ?? [])],
    status: "active",
    dependsOn: [...(input.dependsOn ?? [])],
    rootTodoIds: [],
    ...(input.sourceRequest ? { sourceRequest: input.sourceRequest } : {}),
    createdAt: now,
    updatedAt: now,
  };
  next.project.updatedAt = now;
  return next;
}

export function addTodo(state: ProjectState, input: AddTodoInput, now: string): ProjectState {
  assertSafeRecordKey(input.id, "Todo id");
  if (state.todos[input.id]) throw new Error(`Todo ${input.id} already exists`);
  const goal = state.goals[input.goalId];
  if (!goal) throw new Error(`Goal ${input.goalId} does not exist`);
  if (input.parentId) {
    const parent = state.todos[input.parentId];
    if (!parent) throw new Error(`Parent todo ${input.parentId} does not exist`);
    if (parent.goalId !== input.goalId) throw new Error("Parent todo belongs to a different goal");
  }

  const next = clone(state);
  next.todos[input.id] = {
    id: input.id,
    goalId: input.goalId,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    status: "pending",
    required: input.required ?? true,
    dependsOn: [...(input.dependsOn ?? [])],
    childIds: [],
    execution: input.execution ?? "undecided",
    ...(input.executionProfile ? { executionProfile: structuredClone(input.executionProfile) } : {}),
    ...(input.workflowPlan ? { workflowPlan: structuredClone(input.workflowPlan) } : {}),
    resourceClaims: structuredClone(input.resourceClaims ?? []),
    systemManaged: input.systemManaged ?? false,
    executionGeneration: 0,
    ...(input.sourceRequest ? { sourceRequest: input.sourceRequest } : {}),
    attempts: [],
    createdAt: now,
    updatedAt: now,
  };
  if (input.parentId) next.todos[input.parentId]!.childIds.push(input.id);
  else next.goals[input.goalId]!.rootTodoIds.push(input.id);
  next.project.updatedAt = now;
  return next;
}

export function setTodoStatus(
  state: ProjectState,
  todoId: string,
  status: TodoStatus,
  reason: string | undefined,
  now: string,
): ProjectState {
  const next = clone(state);
  const todo = next.todos[todoId];
  if (!todo) throw new Error(`Todo ${todoId} does not exist`);
  todo.status = status;
  todo.updatedAt = now;
  if (status === "blocked") {
    todo.blocker = { kind: "tool", reason: reason ?? "Blocked", sourceIds: [] };
  } else {
    delete todo.blocker;
  }
  if (status === "completed") todo.completedAt = now;
  else delete todo.completedAt;
  next.project.updatedAt = now;
  return next;
}


export function addEvidence(
  state: ProjectState,
  evidence: ProjectState["evidence"][string],
): ProjectState {
  assertSafeRecordKey(evidence.id, "Evidence id");
  const next = clone(state);
  next.evidence[evidence.id] = structuredClone(evidence);
  return next;
}


export function addCriterionEvidence(
  state: ProjectState,
  goalId: string,
  criterionId: string,
  evidenceId: string,
  now: string,
): ProjectState {
  assertSafeRecordKey(evidenceId, "Evidence id");
  const next = clone(state);
  const goal = next.goals[goalId];
  if (!goal) throw new Error(`Goal ${goalId} does not exist`);
  const criterion = goal.successCriteria.find((item) => item.id === criterionId);
  if (!criterion) throw new Error(`Criterion ${criterionId} does not exist`);
  if (!next.evidence[evidenceId]) throw new Error(`Evidence ${evidenceId} does not exist`);
  if (!criterion.evidenceIds.includes(evidenceId)) criterion.evidenceIds.push(evidenceId);
  goal.updatedAt = now;
  next.project.updatedAt = now;
  return next;
}

export function completeGoal(state: ProjectState, goalId: string, now: string): ProjectState {
  const audit = auditGoal(state, goalId);
  const missing = audit.criteria.filter((criterion) => criterion.required && !criterion.satisfied);
  if (missing.length > 0) throw new Error(`Goal ${goalId} is missing evidence for: ${missing.map((item) => item.criterionId).join(", ")}`);
  return completeGoalFromAudit(state, audit, now);
}

export function reconcileProject(state: ProjectState, now: string): ProjectState {
  const next = clone(state);
  for (const todo of Object.values(next.todos)) {
    if (todo.childIds.length > 0 || ["completed", "cancelled", "in_progress"].includes(todo.status)) continue;
    if (todo.status === "blocked" && todo.blocker?.kind !== "dependency") continue;
    const dependencies = todo.dependsOn.map((id) => next.todos[id]).filter(Boolean);
    const failedDependency = dependencies.find((dependency) => dependency!.status === "blocked" || dependency!.status === "cancelled");
    if (failedDependency) {
      todo.status = "blocked";
      todo.blocker = {
        kind: "dependency",
        reason: `Blocked by ${failedDependency.id}`,
        sourceIds: [failedDependency.id],
      };
      continue;
    }
    const goal = next.goals[todo.goalId]!;
    const goalDependenciesComplete = goal.dependsOn.every((id) => next.goals[id]?.status === "completed");
    const todoDependenciesComplete = dependencies.every((dependency) => dependency!.status === "completed");
    todo.status = goalDependenciesComplete && todoDependenciesComplete ? "ready" : "pending";
    delete todo.blocker;
    todo.updatedAt = now;
  }
  const aggregate = (todoId: string): TodoStatus => {
    const todo = next.todos[todoId];
    if (!todo || todo.childIds.length === 0) return todo?.status ?? "pending";
    const children = todo.childIds.map((id) => next.todos[id]).filter((child) => child !== undefined);
    for (const child of children) aggregate(child.id);
    const required = children.filter((child) => child.required);
    if (required.length > 0 && required.every((child) => child.status === "completed")) {
      todo.status = "completed";
      todo.completedAt = now;
    } else if (children.some((child) => child.status === "in_progress")) {
      todo.status = "in_progress";
    } else if (children.some((child) => child.status === "ready")) {
      todo.status = "ready";
    } else if (required.length > 0 && required.every((child) => child.status === "blocked" || child.status === "cancelled")) {
      todo.status = "blocked";
    } else {
      todo.status = "pending";
    }
    todo.updatedAt = now;
    return todo.status;
  };

  for (const goal of Object.values(next.goals)) {
    for (const rootId of goal.rootTodoIds) aggregate(rootId);
    if (goal.status === "completed" || goal.status === "cancelled") continue;
    const remaining = Object.values(next.todos).filter(
      (todo) => todo.goalId === goal.id && todo.required && todo.status !== "completed" && todo.status !== "cancelled",
    );
    const hasRunnable = remaining.some((todo) => todo.status === "ready" || todo.status === "in_progress");
    goal.status = remaining.length > 0 && !hasRunnable ? "blocked" : "active";
    goal.updatedAt = now;
  }
  for (const [todoId] of Object.entries(next.scheduler.activeLeases)) {
    const status = next.todos[todoId]?.status;
    if (status === "completed" || status === "cancelled" || status === "blocked" || !status) {
      delete next.scheduler.activeLeases[todoId];
    }
  }
  for (const record of Object.values(next.scheduler.continuationKeys)) {
    const status = next.todos[record.todoId]?.status;
    if (status !== "in_progress" && record.status !== "expired") record.status = "expired";
  }
  return next;
}
