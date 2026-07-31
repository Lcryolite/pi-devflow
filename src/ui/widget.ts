import type { Theme } from "@earendil-works/pi-coding-agent";

import type { ProjectState } from "../domain/types.js";
import { projectTreeRows } from "./tree-model.js";
import { renderTreeRow } from "./tree-render.js";
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

export function renderCompactWidget(
  state: ProjectState,
  width: number,
  theme: Theme,
  expandedIds: ReadonlySet<string> = defaultWidgetExpandedIds(state),
): string[] {
  return projectTreeRows(state, expandedIds).map((row) => renderTreeRow(row, width, theme));
}
