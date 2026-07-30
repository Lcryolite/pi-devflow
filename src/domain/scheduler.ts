import type { ExecutionMode, ExecutionProfile, ProjectState, ResourceClaim } from "./types.js";

export interface ScheduleStart {
  todoId: string;
  goalId: string;
  mode: Exclude<ExecutionMode, "undecided">;
  continuationKey: string;
  resourceClaims: ResourceClaim[];
}

export interface SchedulePlan {
  revision: number;
  starts: ScheduleStart[];
}

export function selectExecutionMode(profile: ExecutionProfile): Exclude<ExecutionMode, "undecided"> {
  const safeWrites = profile.writeScope === "none" || profile.writeScope === "known-disjoint";
  return profile.independentUnits >= 2
    && profile.estimatedUnits >= 2
    && !profile.hasSequentialDependency
    && safeWrites
    && profile.mergeableResults
    ? "workflow"
    : "main";
}

function keyOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function resourceClaimsConflict(left: ResourceClaim[], right: ResourceClaim[]): boolean {
  return left.some((a) => right.some((b) => keyOverlap(a.key, b.key) && !(a.mode === "read" && b.mode === "read")));
}

function fairCandidates(state: ProjectState): string[] {
  const goals = Object.values(state.goals)
    .filter((goal) => goal.status === "active")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const queues = goals.map((goal) => Object.values(state.todos)
    .filter((todo) => todo.goalId === goal.id && todo.status === "ready")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((todo) => todo.id));
  const ordered: string[] = [];
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) ordered.push(next);
    }
  }
  return ordered;
}

export function planSchedule(state: ProjectState, _now: string): SchedulePlan {
  if (state.scheduler.paused) return { revision: state.revision, starts: [] };
  const active = Object.values(state.scheduler.activeLeases);
  const capacity = {
    main: Math.max(0, state.scheduler.maxConcurrentMain - active.filter((lease) => lease.mode === "main").length),
    workflow: Math.max(0, state.scheduler.maxConcurrentWorkflow - active.filter((lease) => lease.mode === "workflow").length),
  };
  const starts: ScheduleStart[] = [];
  const heldClaims = active.flatMap((lease) => lease.resourceClaims);
  for (const todoId of fairCandidates(state)) {
    const todo = state.todos[todoId]!;
    const mode = todo.execution === "undecided"
      ? todo.executionProfile ? selectExecutionMode(todo.executionProfile) : "main"
      : todo.execution;
    if (capacity[mode] <= 0) continue;
    if (resourceClaimsConflict(todo.resourceClaims, heldClaims)) continue;
    const continuationKey = `${state.project.id}:${state.revision}:${todo.id}:${todo.executionGeneration}`;
    if (state.scheduler.continuationKeys[continuationKey]) continue;
    starts.push({ todoId: todo.id, goalId: todo.goalId, mode, continuationKey, resourceClaims: structuredClone(todo.resourceClaims) });
    capacity[mode] -= 1;
    heldClaims.push(...todo.resourceClaims);
  }
  return { revision: state.revision, starts };
}

export function applySchedulePlan(state: ProjectState, plan: SchedulePlan, now: string): ProjectState {
  if (plan.revision !== state.revision) throw new Error("Schedule plan revision is stale");
  const next = structuredClone(state);
  for (const start of plan.starts) {
    if (next.scheduler.continuationKeys[start.continuationKey]) continue;
    const todo = next.todos[start.todoId];
    if (!todo || todo.status !== "ready") continue;
    todo.execution = start.mode;
    todo.status = "in_progress";
    todo.updatedAt = now;
    next.scheduler.continuationKeys[start.continuationKey] = {
      key: start.continuationKey,
      todoId: start.todoId,
      revision: state.revision,
      status: "reserved",
      createdAt: now,
    };
    next.scheduler.activeLeases[start.todoId] = {
      id: start.todoId,
      todoId: start.todoId,
      goalId: start.goalId,
      mode: start.mode,
      resourceClaims: structuredClone(start.resourceClaims),
      acquiredAt: now,
    };
  }
  next.project.updatedAt = now;
  return next;
}

export function markContinuation(
  state: ProjectState,
  key: string,
  status: "sent" | "claimed" | "expired",
): ProjectState {
  const next = structuredClone(state);
  const record = next.scheduler.continuationKeys[key];
  if (!record) throw new Error(`Continuation ${key} does not exist`);
  record.status = status;
  return next;
}

export function releaseExecutionLease(state: ProjectState, todoId: string): ProjectState {
  const next = structuredClone(state);
  delete next.scheduler.activeLeases[todoId];
  return next;
}


export function recoverInterruptedExecutions(state: ProjectState, now: string): ProjectState {
  if (Object.keys(state.scheduler.activeLeases).length === 0) return state;
  const next = structuredClone(state);
  for (const lease of Object.values(next.scheduler.activeLeases)) {
    const todo = next.todos[lease.todoId];
    if (lease.mode === "main" && todo?.status === "in_progress") {
      todo.status = "blocked";
      todo.blocker = {
        kind: "tool",
        reason: "Main-agent execution ended before this Todo completed",
        recommendedAnswer: "Retry with a fresh strategy",
        sourceIds: [lease.id],
      };
      todo.updatedAt = now;
    }
    if (lease.mode === "workflow" && todo?.workflowRunId) {
      const binding = next.workflowRuns[todo.workflowRunId];
      if (binding?.status === "running") binding.status = "paused";
    }
    for (const record of Object.values(next.scheduler.continuationKeys)) {
      if (record.todoId === lease.todoId && (record.status === "reserved" || record.status === "sent")) {
        record.status = "expired";
      }
    }
    delete next.scheduler.activeLeases[lease.todoId];
  }
  next.project.updatedAt = now;
  return next;
}
