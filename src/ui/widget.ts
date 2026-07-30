import type { Theme } from "@earendil-works/pi-coding-agent";

import type { ProjectState } from "../domain/types.js";
import { projectTreeRows } from "./tree-model.js";
import { renderTreeRow } from "./tree-render.js";
export function renderCompactWidget(state: ProjectState, width: number, theme: Theme): string[] {
  const expandedGoals = new Set(Object.keys(state.goals).map((goalId) => `goal:${goalId}`));
  return projectTreeRows(state, expandedGoals).map((row) => renderTreeRow(row, width, theme));
}
