import type { ProjectState, TodoStatus } from "./domain/types.js";

const symbols: Record<TodoStatus, string> = {
  pending: "○",
  ready: "◇",
  in_progress: "●",
  blocked: "!",
  completed: "✓",
  cancelled: "×",
};

function sessionGoalIds(state: ProjectState, sessionId?: string): Set<string> {
  return new Set(Object.values(state.goals)
    .filter((goal) => !sessionId || goal.ownerSessionId === sessionId)
    .map((goal) => goal.id));
}

export function formatStatus(state: ProjectState, sessionId?: string): string {
  const goalIds = sessionGoalIds(state, sessionId);
  const goals = Object.values(state.goals).filter((goal) => goalIds.has(goal.id));
  const todos = Object.values(state.todos).filter((todo) => goalIds.has(todo.goalId) && !todo.origin);
  const ready = todos.filter((todo) => todo.status === "ready");
  const running = todos.filter((todo) => todo.status === "in_progress");
  const blocked = todos.filter((todo) => todo.status === "blocked");
  const lines = [
    `Devflow ${state.project.root} · rev ${state.revision} · ${goals.length} goal(s) · ${ready.length} ready · ${running.length} running · ${blocked.length} blocked`,
  ];

  const visible = [...running, ...ready, ...blocked].slice(0, 12);
  for (const todo of visible) {
    const blocker = todo.blocker ? ` — ${todo.blocker.reason}` : "";
    lines.push(`${symbols[todo.status]} #${todo.id} ${todo.title}${blocker}`);
  }
  if (visible.length === 0) lines.push("No runnable or blocked todos.");
  return lines.join("\n");
}

export function listGoals(state: ProjectState, sessionId?: string): string {
  const goals = Object.values(state.goals).filter((goal) => !sessionId || goal.ownerSessionId === sessionId);
  if (goals.length === 0) return "No goals.";
  return goals.map((goal) => `${goal.status === "completed" ? "✓" : goal.status === "blocked" ? "!" : "●"} ${goal.id} ${goal.title}`).join("\n");
}

export function listTodos(state: ProjectState, goalId?: string, sessionId?: string): string {
  const goals = sessionGoalIds(state, sessionId);
  const todos = Object.values(state.todos).filter((todo) => goals.has(todo.goalId) && (!goalId || todo.goalId === goalId));
  if (todos.length === 0) return "No todos.";
  return todos.map((todo) => `${todo.status.padEnd(11)} #${todo.id} ${todo.title}`).join("\n");
}
