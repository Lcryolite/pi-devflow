import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { ProjectState } from "../domain/types.js";

export function renderCompactWidget(state: ProjectState, width: number, theme: Theme): string[] {
  const goals = Object.values(state.goals).filter((goal) => goal.status === "active" || goal.status === "blocked");
  const todos = Object.values(state.todos);
  const ready = todos.filter((todo) => todo.status === "ready");
  const running = todos.filter((todo) => todo.status === "in_progress");
  const blocked = todos.filter((todo) => todo.status === "blocked");
  if (goals.length === 0 && ready.length === 0 && running.length === 0 && blocked.length === 0) return [];

  const lines = [theme.fg("accent", `Devflow · ${goals.length} goals · ${ready.length} ready · ${blocked.length} blocked`)];
  for (const todo of [...running, ...ready, ...blocked].slice(0, 4)) {
    const symbol = todo.status === "in_progress" ? "●" : todo.status === "ready" ? "◇" : "!";
    lines.push(`${symbol} ${todo.title}`);
  }
  return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}
