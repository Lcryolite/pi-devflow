import type { GoalStatus, ProjectState, TodoStatus } from "../domain/types.js";
import { workflowPhaseModelLabel } from "../workflow/projection.js";

export interface TreeRow {
  key: string;
  parentKey?: string;
  kind: "goal" | "todo" | "detail";
  depth: number;
  number: string;
  title: string;
  status?: GoalStatus | TodoStatus;
  expandable: boolean;
  expanded: boolean;
  todoId?: string;
  goalId?: string;
  workflowBadge?: string;
}

export function projectTreeRows(
  state: ProjectState,
  expandedIds: ReadonlySet<string>,
  focusedGoalId?: string,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const goals = Object.values(state.goals)
    .filter((goal) => !focusedGoalId || goal.id === focusedGoalId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));


  const workflowBadge = (todoId: string): string | undefined => {
    const todo = state.todos[todoId];
    if (!todo) return undefined;
    const binding = todo.workflowRunId
      ? state.workflowRuns[todo.workflowRunId]
      : todo.origin?.kind === "workflow-phase" ? state.workflowRuns[todo.origin.bindingId] : undefined;
    if (!binding) return undefined;
    const phases = todo.origin?.kind === "workflow-phase"
      ? binding.phases.filter((phase) => phase.todoId === todo.id)
      : binding.phases;
    const completed = phases.reduce((sum, phase) => sum + phase.agentCompleted, 0);
    const total = phases.reduce((sum, phase) => sum + phase.agentTotal, 0);
    const models = [...new Set(phases.map((phase) => workflowPhaseModelLabel(phase)))];
    const model = models.length === 0 ? "inherit" : models.length === 1 ? models[0] : "mixed";
    return `workflow · ${completed}/${total} · ${model}`;
  };

  const addTodo = (todoId: string, number: string, depth: number, parentKey: string): void => {
    const todo = state.todos[todoId];
    if (!todo) return;
    const key = `todo:${todo.id}`;
    const phase = todo.origin?.kind === "workflow-phase"
      ? state.workflowRuns[todo.origin.bindingId]?.phases.find((item) => item.todoId === todo.id)
      : undefined;
    const expandable = todo.childIds.length > 0 || Boolean(todo.blocker) || Boolean(phase?.agents.length);
    const expanded = expandable && expandedIds.has(key);
    const badge = workflowBadge(todo.id);
    rows.push({
      key,
      parentKey,
      kind: "todo",
      depth,
      number,
      title: todo.title,
      status: todo.status,
      expandable,
      expanded,
      todoId: todo.id,
      goalId: todo.goalId,
      ...(badge ? { workflowBadge: badge } : {}),
    });
    if (!expanded) return;
    todo.childIds.forEach((childId, index) => addTodo(childId, `${number}.${index + 1}`, depth + 1, key));
    phase?.agents.forEach((agent) => {
      const model = agent.model ?? phase.requestedModel ?? "inherit";
      const modelLabel = agent.modelConfirmed ? model : `${model}?`;
      const detail = agent.error ? ` · ${agent.error}` : agent.resultPreview ? ` · ${agent.resultPreview}` : "";
      rows.push({
        key: `detail:${todo.id}:agent:${agent.callId}`,
        parentKey: key,
        kind: "detail",
        depth: depth + 1,
        number: "",
        title: `${agent.status}: ${agent.label} · ${modelLabel}${detail}`,
        expandable: false,
        expanded: false,
        todoId: todo.id,
        goalId: todo.goalId,
      });
    });
    if (todo.blocker) {
      const unlock = todo.blocker.unlockCondition ? ` · unlock: ${todo.blocker.unlockCondition}` : "";
      rows.push({
        key: `detail:${todo.id}:blocker`,
        parentKey: key,
        kind: "detail",
        depth: depth + 1,
        number: "",
        title: `blocked: ${todo.blocker.reason}${unlock}`,
        expandable: false,
        expanded: false,
        todoId: todo.id,
        goalId: todo.goalId,
      });
    }
  };

  goals.forEach((goal, goalIndex) => {
    const key = `goal:${goal.id}`;
    const expanded = goal.rootTodoIds.length > 0 && expandedIds.has(key);
    rows.push({
      key,
      kind: "goal",
      depth: 0,
      number: `#${goalIndex + 1}`,
      title: goal.title,
      status: goal.status,
      expandable: goal.rootTodoIds.length > 0,
      expanded,
      goalId: goal.id,
    });
    if (expanded) goal.rootTodoIds.forEach((todoId, index) => addTodo(todoId, `#${goalIndex + 1}.${index + 1}`, 1, key));
  });

  return rows;
}
