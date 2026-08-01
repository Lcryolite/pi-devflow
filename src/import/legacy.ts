import { createHash } from "node:crypto";

import { addGoal, addTodo } from "../domain/state.js";
import type { ProjectState } from "../domain/types.js";

interface LegacyGoal {
  goalId: string;
  objective: string;
  status: "active" | "paused" | "budgetLimited" | "complete";
  createdAt: number;
  updatedAt: number;
}

interface LegacyTask {
  id: number;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blockedBy?: number[];
}

export interface LegacyImportReport {
  state: ProjectState;
  applied: boolean;
  migrationId?: string;
  goalIds: string[];
  todoIds: string[];
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function readGoal(entries: unknown[]): LegacyGoal | undefined {
  let goal: LegacyGoal | undefined;
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry?.type !== "custom" || entry.customType !== "pi-codex-goal") continue;
    const data = asRecord(entry.data);
    if (data?.kind === "clear") goal = undefined;
    if (data?.kind === "set") {
      const candidate = asRecord(data.goal);
      if (candidate
        && typeof candidate.goalId === "string"
        && typeof candidate.objective === "string"
        && ["active", "paused", "budgetLimited", "complete"].includes(String(candidate.status))
        && typeof candidate.createdAt === "number"
        && typeof candidate.updatedAt === "number") {
        goal = candidate as unknown as LegacyGoal;
      }
    }
    if (data?.kind === "usage" && goal && data.goalId === goal.goalId && typeof data.updatedAt === "number") {
      goal = { ...goal, status: data.status as LegacyGoal["status"], updatedAt: data.updatedAt };
    }
  }
  return goal;
}

function readTasks(entries: unknown[]): LegacyTask[] {
  let tasks: LegacyTask[] = [];
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "toolResult" || message.toolName !== "todo") continue;
    const details = asRecord(message.details);
    if (!Array.isArray(details?.tasks)) continue;
    const valid = details.tasks.filter((item): item is LegacyTask => {
      const task = asRecord(item);
      return Boolean(task
        && typeof task.id === "number"
        && typeof task.subject === "string"
        && ["pending", "in_progress", "completed", "deleted"].includes(String(task.status)));
    });
    tasks = valid.map((task) => structuredClone(task));
  }
  return tasks;
}

function availableId(existing: Record<string, unknown>, preferred: string, fingerprint: string): string {
  if (!existing[preferred]) return preferred;
  const fallback = `${preferred}:import:${fingerprint.slice(0, 8)}`;
  if (!existing[fallback]) return fallback;
  throw new Error(`Legacy import id collision for ${preferred}`);
}


function safeLegacyGoalId(value: string, fingerprint: string): string {
  return !value.trim() || ["__proto__", "prototype", "constructor"].includes(value)
    ? `legacy-goal-${fingerprint.slice(0, 8)}`
    : value;
}

export function importLegacyBranch(
  state: ProjectState,
  branch: Iterable<unknown>,
  now: string,
  sourceKey = "default-session",
): LegacyImportReport {
  const entries = [...branch];
  const goal = readGoal(entries);
  const tasks = readTasks(entries);
  if (!goal && tasks.length === 0) return { state, applied: false, goalIds: [], todoIds: [], warnings: [] };

  const fingerprint = createHash("sha256").update(JSON.stringify({ goal, tasks })).digest("hex");
  const sourceHash = createHash("sha256").update(sourceKey).digest("hex").slice(0, 16);
  const migrationId = `legacy-session:${sourceHash}`;
  if (state.migrations[migrationId]) {
    return { state, applied: false, migrationId, goalIds: [], todoIds: [], warnings: [] };
  }

  let next = state;
  const warnings: string[] = [];
  const goalIds: string[] = [];
  const todoIds: string[] = [];
  let targetGoalId: string;
  let needsResumeDecision = false;
  const liveTasks = tasks.filter((task) => task.status !== "deleted");
  const hasIncompleteLegacyTasks = liveTasks.some((task) => task.status !== "completed");
  if (goal) {
    targetGoalId = availableId(next.goals, safeLegacyGoalId(goal.goalId, fingerprint), fingerprint);
    const title = goal.objective.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || "Imported goal";
    next = addGoal(next, {
      id: targetGoalId,
      ownerSessionId: sourceKey,
      title,
      objective: goal.objective,
      successCriteria: [],
      sourceRequest: "Imported from pi-codex-goal session state",
    }, new Date(goal.createdAt).toISOString());
    if (goal.status === "complete" && !hasIncompleteLegacyTasks) {
      next.goals[targetGoalId]!.status = "completed";
      next.goals[targetGoalId]!.completedAt = new Date(goal.updatedAt).toISOString();
    } else if (goal.status === "complete") {
      warnings.push(`Legacy goal ${goal.goalId} was complete but has incomplete imported todos; imported as active`);
    } else if (goal.status === "paused" || goal.status === "budgetLimited") {
      needsResumeDecision = true;
      warnings.push(`Legacy goal ${goal.goalId} was ${goal.status}; a resume decision is required`);
    }
    goalIds.push(targetGoalId);
  } else {
    targetGoalId = availableId(next.goals, "legacy-imported-todos", fingerprint);
    next = addGoal(next, {
      id: targetGoalId,
      ownerSessionId: sourceKey,
      title: "Imported legacy todos",
      objective: "Complete tasks imported from rpiv-todo",
      successCriteria: [],
      sourceRequest: "Imported from rpiv-todo session state",
    }, now);
    goalIds.push(targetGoalId);
  }
  const idMap = new Map<number, string>();
  for (const task of liveTasks) {
    idMap.set(task.id, availableId(next.todos, `legacy-todo-${task.id}`, fingerprint));
  }
  for (const task of liveTasks) {
    const id = idMap.get(task.id)!;
    const dependencies = (task.blockedBy ?? []).flatMap((legacyId) => {
      const mapped = idMap.get(legacyId);
      if (!mapped) {
        warnings.push(`Todo ${task.id} references missing/deleted dependency ${legacyId}`);
        return [];
      }
      return [mapped];
    });
    next = addTodo(next, {
      id,
      goalId: targetGoalId,
      title: task.subject,
      ...(task.description ? { description: task.description } : {}),
      dependsOn: dependencies,
      execution: "main",
      sourceRequest: "Imported from rpiv-todo session state",
    }, now);
    if (task.status === "in_progress") {
      next.todos[id]!.status = "blocked";
      next.todos[id]!.blocker = {
        kind: "decision",
        reason: "Legacy in-progress execution was interrupted during migration",
        recommendedAnswer: "Retry this Todo with a fresh strategy",
        sourceIds: [String(task.id)],
      };
      warnings.push(`Legacy in-progress Todo ${task.id} requires an explicit retry`);
    }
    if (task.status === "completed") {
      next.todos[id]!.status = "completed";
      next.todos[id]!.completedAt = now;
    }
    todoIds.push(id);
  }
  if (needsResumeDecision) {
    const resumeId = availableId(next.todos, `legacy-goal-resume-${targetGoalId}`, fingerprint);
    next = addTodo(next, {
      id: resumeId,
      goalId: targetGoalId,
      title: "Confirm legacy Goal resume",
      execution: "main",
      sourceRequest: "Imported paused legacy Goal",
    }, now);
    next.todos[resumeId]!.status = "blocked";
    next.todos[resumeId]!.blocker = {
      kind: "decision",
      reason: "The imported legacy Goal was paused or budget-limited",
      recommendedAnswer: "Resume with current Devflow limits",
      sourceIds: [goal!.goalId],
    };
    todoIds.push(resumeId);
  }
  if (tasks.some((task) => task.status === "deleted")) warnings.push("Deleted legacy todos were not imported");

  next = structuredClone(next);
  next.migrations[migrationId] = {
    id: migrationId,
    source: goal && tasks.length > 0 ? "pi-codex-goal+rpiv-todo" : goal ? "pi-codex-goal" : "rpiv-todo",
    sourceIds: [...(goal ? [goal.goalId] : []), ...tasks.map((task) => String(task.id))],
    appliedAt: now,
    warnings: [...warnings],
  };
  next.project.updatedAt = now;
  return { state: next, applied: true, migrationId, goalIds, todoIds, warnings };
}
