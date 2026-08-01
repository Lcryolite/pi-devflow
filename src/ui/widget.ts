import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { ProjectState, WorkflowBinding } from "../domain/types.js";
import { workflowPhaseModelLabel } from "../workflow/projection.js";
import { projectTreeRows } from "./tree-model.js";
import { renderTreeRow } from "./tree-render.js";

export interface WidgetViewState {
  expanded: boolean;
  hadActivity: boolean | undefined;
}

function ownedGoalIds(state: ProjectState, sessionId?: string): Set<string> {
  return new Set(Object.values(state.goals)
    .filter((goal) => !sessionId || goal.ownerSessionId === sessionId)
    .map((goal) => goal.id));
}

export function defaultWidgetExpandedIds(state: ProjectState, sessionId?: string): Set<string> {
  return new Set(Object.values(state.goals)
    .filter((goal) => (!sessionId || goal.ownerSessionId === sessionId)
      && (goal.status === "active" || goal.status === "blocked"))
    .map((goal) => `goal:${goal.id}`));
}

export function syncWidgetExpandedIds(
  state: ProjectState,
  expandedIds: Set<string>,
  previousStatuses: Map<string, ProjectState["goals"][string]["status"]>,
  sessionId?: string,
): void {
  const currentGoalIds = ownedGoalIds(state, sessionId);
  for (const goalId of previousStatuses.keys()) {
    if (!currentGoalIds.has(goalId)) {
      previousStatuses.delete(goalId);
      expandedIds.delete(`goal:${goalId}`);
    }
  }
  for (const goal of Object.values(state.goals)) {
    if (sessionId && goal.ownerSessionId !== sessionId) continue;
    const previous = previousStatuses.get(goal.id);
    const terminal = goal.status === "completed" || goal.status === "cancelled";
    const previousTerminal = previous === "completed" || previous === "cancelled";
    if (previous === undefined) {
      if (!terminal) expandedIds.add(`goal:${goal.id}`);
    } else if (terminal && !previousTerminal) {
      expandedIds.delete(`goal:${goal.id}`);
    } else if (!terminal && previousTerminal) {
      expandedIds.add(`goal:${goal.id}`);
    }
    previousStatuses.set(goal.id, goal.status);
  }
}

export function hasWidgetActivity(state: ProjectState, sessionId?: string): boolean {
  const goals = ownedGoalIds(state, sessionId);
  return Object.values(state.todos).some((todo) => goals.has(todo.goalId)
    && (todo.status === "ready" || todo.status === "in_progress" || todo.status === "blocked"));
}

export function syncWidgetView(state: ProjectState, view: WidgetViewState, sessionId?: string): void {
  const active = hasWidgetActivity(state, sessionId);
  if (view.hadActivity === true && !active) view.expanded = false;
  view.hadActivity = active;
}

export function toggleWidgetView(view: WidgetViewState): boolean {
  view.expanded = !view.expanded;
  return view.expanded;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function activeBindings(state: ProjectState, sessionId?: string): WorkflowBinding[] {
  return Object.values(state.workflowRuns)
    .filter((binding) => {
      const parent = state.todos[binding.todoId];
      const goal = parent ? state.goals[parent.goalId] : undefined;
      if (!parent || !goal || parent.status === "completed" || parent.status === "cancelled" || goal.status === "completed" || goal.status === "cancelled") return false;
      if (sessionId && binding.ownerSessionId !== sessionId) return false;
      return binding.status === "running" || binding.status === "paused" || (binding.status === "failed" && (parent.status === "blocked" || parent.status === "in_progress"));
    })
    .sort((left, right) => (right.lastProgressAt ?? right.startedAt ?? "").localeCompare(left.lastProgressAt ?? left.startedAt ?? ""));
}

function renderWorkflowProgress(
  state: ProjectState,
  binding: WorkflowBinding,
  width: number,
  theme: Theme,
  now: number,
  otherCount: number,
): string[] {
  const parent = state.todos[binding.todoId];
  const goal = parent ? state.goals[parent.goalId] : undefined;
  const title = parent?.title ?? goal?.title ?? binding.id;
  const startedAt = binding.startedAt ? Date.parse(binding.startedAt) : now;
  const finishedAt = binding.endedAt ? Date.parse(binding.endedAt) : now;
  const elapsed = formatDuration(finishedAt - startedAt);
  const currentIndex = binding.currentPhaseTitle
    ? binding.phases.findIndex((phase) => phase.title === binding.currentPhaseTitle)
    : binding.phases.findIndex((phase) => state.todos[phase.todoId]?.status === "in_progress");
  const phase = binding.phases[Math.max(0, currentIndex)] ?? binding.phases[0];
  const phaseNumber = currentIndex >= 0 ? currentIndex + 1 : 1;
  const model = phase ? workflowPhaseModelLabel(phase) : "inherit";
  const status = binding.status === "failed" ? "blocked" : binding.status;
  const head = `◆ ${title} · ${status === "running" ? "workflow" : status} · ${elapsed}${otherCount > 0 ? ` · +${otherCount}` : ""}`;
  const detail = `  phase ${phaseNumber}/${binding.phases.length} ${phase?.title ?? "starting"} · agents ${phase?.agentCompleted ?? 0}/${phase?.agentTotal ?? 0} · ${model}`;
  const blocker = phase ? state.todos[phase.todoId]?.blocker?.reason : undefined;
  const action = blocker
    ? `  ↳ ! ${blocker}`
    : binding.status === "paused" ? "  ↳ ⏸ paused"
      : `  ↳ ${binding.lastAction ?? phase?.title ?? "starting"}`;
  return [head, detail, action].map((line, index) =>
    truncateToWidth(index === 0 ? theme.fg("accent", line) : index === 2 && blocker ? theme.fg("warning", line) : line, Math.max(1, width)));
}

export function renderDynamicWidget(
  state: ProjectState,
  width: number,
  theme: Theme,
  expandedIds: ReadonlySet<string> = defaultWidgetExpandedIds(state),
  expanded = false,
  sessionId?: string,
  now = Date.now(),
): string[] {
  if (!hasWidgetActivity(state, sessionId)) return [];
  const workflows = activeBindings(state, sessionId);
  if (expanded) {
    const visibleExpanded = new Set(expandedIds);
    for (const binding of workflows) {
      const parent = state.todos[binding.todoId];
      if (!parent) continue;
      visibleExpanded.add(`goal:${parent.goalId}`);
      visibleExpanded.add(`todo:${parent.id}`);
      const current = binding.phases.find((phase) => phase.title === binding.currentPhaseTitle)
        ?? binding.phases.find((phase) => state.todos[phase.todoId]?.status === "in_progress" || state.todos[phase.todoId]?.status === "blocked");
      if (current) visibleExpanded.add(`todo:${current.todoId}`);
    }
    return projectTreeRows(state, visibleExpanded, undefined, sessionId, true).map((row) => renderTreeRow(row, width, theme));
  }

  if (workflows[0]) return renderWorkflowProgress(state, workflows[0], width, theme, now, workflows.length - 1);

  const goals = ownedGoalIds(state, sessionId);
  const todos = Object.values(state.todos).filter((todo) => goals.has(todo.goalId));
  const running = todos.filter((todo) => todo.status === "in_progress" && !todo.origin);
  const blocked = todos.filter((todo) => todo.status === "blocked" && !todo.origin);
  const ready = todos.filter((todo) => todo.status === "ready" && !todo.origin);
  if (running.length + blocked.length + ready.length === 0) return [];

  const counts = [
    running.length > 0 ? `${running.length} running` : "",
    ready.length > 0 ? `${ready.length} ready` : "",
    blocked.length > 0 ? `${blocked.length} blocked` : "",
  ].filter(Boolean).join(" · ");
  const focus = running[0] ?? blocked[0] ?? ready[0];
  const summary = `◆ Devflow · ${counts} · Ctrl+Shift+D 展开${focus ? ` · ${focus.title}` : ""}`;
  return [truncateToWidth(theme.fg(blocked.length > 0 ? "warning" : "accent", summary), Math.max(1, width))];
}

/** @deprecated Use renderDynamicWidget. */
export function renderCompactWidget(
  state: ProjectState,
  width: number,
  theme: Theme,
  expandedIds: ReadonlySet<string> = defaultWidgetExpandedIds(state),
): string[] {
  return renderDynamicWidget(state, width, theme, expandedIds, true);
}
