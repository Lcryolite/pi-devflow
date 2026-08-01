import type { ProjectState } from "./domain/types.js";

export interface PendingGrill {
  key: string;
  todoId: string;
  question: string;
  recommendedAnswer?: string;
}

export function selectPendingGrill(state: ProjectState, sessionId?: string): PendingGrill | undefined {
  const todo = Object.values(state.todos)
    .filter((candidate) => candidate.status === "blocked"
      && candidate.blocker?.kind === "decision"
      && (!sessionId || state.goals[candidate.goalId]?.ownerSessionId === sessionId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
  if (!todo?.blocker || state.goals[todo.goalId]?.status !== "blocked") return undefined;
  const key = [todo.goalId, todo.id, todo.blocker.kind, todo.blocker.reason, todo.blocker.unlockCondition ?? ""].join(":");
  const lastAsked = sessionId ? state.scheduler.grill.lastAskedBlockerKeys[sessionId] : state.scheduler.grill.lastAskedBlockerKey;
  if (lastAsked === key) return undefined;
  return {
    key,
    todoId: todo.id,
    question: todo.blocker.unlockCondition ?? todo.blocker.reason,
    ...(todo.blocker.recommendedAnswer ? { recommendedAnswer: todo.blocker.recommendedAnswer } : {}),
  };
}
