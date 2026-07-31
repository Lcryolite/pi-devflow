import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { ProjectState } from "../domain/types.js";
import { projectTreeRows } from "./tree-model.js";
import { renderTreeRow } from "./tree-render.js";

export interface WidgetViewState {
  expanded: boolean;
  hadActivity: boolean | undefined;
}

export function defaultWidgetExpandedIds(state: ProjectState): Set<string> {
  return new Set(Object.values(state.goals)
    .filter((goal) => goal.status === "active" || goal.status === "blocked")
    .map((goal) => `goal:${goal.id}`));
}

export function syncWidgetExpandedIds(
  state: ProjectState,
  expandedIds: Set<string>,
  previousStatuses: Map<string, ProjectState["goals"][string]["status"]>,
): void {
  const currentGoalIds = new Set(Object.keys(state.goals));
  for (const goalId of previousStatuses.keys()) {
    if (!currentGoalIds.has(goalId)) {
      previousStatuses.delete(goalId);
      expandedIds.delete(`goal:${goalId}`);
    }
  }
  for (const goal of Object.values(state.goals)) {
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

export function hasWidgetActivity(state: ProjectState): boolean {
  return Object.values(state.todos).some((todo) =>
    todo.status === "ready" || todo.status === "in_progress" || todo.status === "blocked");
}

export function syncWidgetView(state: ProjectState, view: WidgetViewState): void {
  const active = hasWidgetActivity(state);
  if (view.hadActivity === true && !active) view.expanded = false;
  view.hadActivity = active;
}

export function toggleWidgetView(view: WidgetViewState): boolean {
  view.expanded = !view.expanded;
  return view.expanded;
}

export function renderDynamicWidget(
  state: ProjectState,
  width: number,
  theme: Theme,
  expandedIds: ReadonlySet<string> = defaultWidgetExpandedIds(state),
  expanded = false,
): string[] {
  if (expanded) {
    return projectTreeRows(state, expandedIds).map((row) => renderTreeRow(row, width, theme));
  }

  const todos = Object.values(state.todos);
  const running = todos.filter((todo) => todo.status === "in_progress");
  const blocked = todos.filter((todo) => todo.status === "blocked");
  const ready = todos.filter((todo) => todo.status === "ready");
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
