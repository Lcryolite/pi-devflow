import type { ProjectState } from "./types.js";

function assertAcyclic(
  ids: string[],
  dependencies: (id: string) => string[],
  label: string,
): void {
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`${label} dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies(id)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of ids) visit(id);
}

export function validateProject(state: ProjectState): void {
  if (state.schemaVersion !== 2) throw new Error(`Unsupported schema version ${state.schemaVersion}`);

  for (const goal of Object.values(state.goals)) {
    for (const dependencyId of goal.dependsOn) {
      if (!state.goals[dependencyId]) throw new Error(`Goal ${goal.id} has missing dependency ${dependencyId}`);
    }
    for (const rootId of goal.rootTodoIds) {
      const root = state.todos[rootId];
      if (!root || root.goalId !== goal.id || root.parentId) {
        throw new Error(`Goal ${goal.id} has invalid root todo ${rootId}`);
      }
    }
    for (const criterion of goal.successCriteria) {
      for (const evidenceId of criterion.evidenceIds) {
        if (!state.evidence[evidenceId]) throw new Error(`Criterion ${criterion.id} has missing evidence ${evidenceId}`);
      }
    }
  }
  assertAcyclic(Object.keys(state.goals), (id) => state.goals[id]?.dependsOn ?? [], "Goal");

  for (const todo of Object.values(state.todos)) {
    if (!state.goals[todo.goalId]) throw new Error(`Todo ${todo.id} has missing goal ${todo.goalId}`);
    for (const dependencyId of todo.dependsOn) {
      const dependency = state.todos[dependencyId];
      if (!dependency) throw new Error(`Todo ${todo.id} has missing dependency ${dependencyId}`);
      if (dependency.goalId !== todo.goalId) {
        throw new Error(`Todo ${todo.id} cannot depend directly on another goal's todo ${dependencyId}`);
      }
    }
    if (todo.parentId) {
      const parent = state.todos[todo.parentId];
      if (!parent || parent.goalId !== todo.goalId || !parent.childIds.includes(todo.id)) {
        throw new Error(`Todo ${todo.id} has invalid parent ${todo.parentId}`);
      }
    }
    for (const childId of todo.childIds) {
      if (state.todos[childId]?.parentId !== todo.id) throw new Error(`Todo ${todo.id} has invalid child ${childId}`);
    }
  }

  for (const binding of Object.values(state.workflowRuns)) {
    if (!state.todos[binding.todoId]) throw new Error(`Workflow ${binding.id} has missing todo ${binding.todoId}`);
    for (const phase of binding.phases) {
      if (!state.todos[phase.todoId]) throw new Error(`Workflow ${binding.id} has missing phase todo ${phase.todoId}`);
    }
  }
  for (const lease of Object.values(state.scheduler.activeLeases)) {
    if (!state.todos[lease.todoId]) throw new Error(`Lease ${lease.id} has missing todo ${lease.todoId}`);
  }
  assertAcyclic(Object.keys(state.todos), (id) => state.todos[id]?.dependsOn ?? [], "Todo");
  assertAcyclic(Object.keys(state.todos), (id) => state.todos[id]?.parentId ? [state.todos[id]!.parentId!] : [], "Todo parent");
}
