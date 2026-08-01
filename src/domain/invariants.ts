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
  if (state.schemaVersion !== 3) throw new Error(`Unsupported schema version ${state.schemaVersion}`);

  for (const goal of Object.values(state.goals)) {
    if (!goal.ownerSessionId) throw new Error(`Goal ${goal.id} has no session owner`);
    for (const dependencyId of goal.dependsOn) {
      const dependency = state.goals[dependencyId];
      if (!dependency) throw new Error(`Goal ${goal.id} has missing dependency ${dependencyId}`);
      if (dependency.ownerSessionId !== goal.ownerSessionId) throw new Error(`Goal ${goal.id} cannot depend on another Pi session's Goal ${dependencyId}`);
    }
    for (const rootId of goal.rootTodoIds) {
      const root = state.todos[rootId];
      if (!root || root.goalId !== goal.id || root.parentId) {
        throw new Error(`Goal ${goal.id} has invalid root todo ${rootId}`);
      }
    }
    for (const criterion of goal.successCriteria) {
      for (const evidenceId of criterion.evidenceIds) {
        const evidence = state.evidence[evidenceId];
        if (!evidence) throw new Error(`Criterion ${criterion.id} has missing evidence ${evidenceId}`);
        if (evidence.ownerSessionId !== goal.ownerSessionId) throw new Error(`Criterion ${criterion.id} uses foreign evidence ${evidenceId}`);
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

  const activeWorkflowTodos = new Set<string>();
  for (const binding of Object.values(state.workflowRuns)) {
    const todo = state.todos[binding.todoId];
    if (!todo) throw new Error(`Workflow ${binding.id} has missing todo ${binding.todoId}`);
    if (state.goals[todo.goalId]?.ownerSessionId !== binding.ownerSessionId) {
      throw new Error(`Workflow ${binding.id} owner does not match Goal ${todo.goalId}`);
    }
    if (["planned", "running", "paused"].includes(binding.status)) {
      if (activeWorkflowTodos.has(binding.todoId)) throw new Error(`Todo ${binding.todoId} has multiple active Workflows`);
      activeWorkflowTodos.add(binding.todoId);
    }
    for (const phase of binding.phases) {
      if (!state.todos[phase.todoId]) throw new Error(`Workflow ${binding.id} has missing phase todo ${phase.todoId}`);
    }
  }
  for (const lease of Object.values(state.scheduler.activeLeases)) {
    const todo = state.todos[lease.todoId];
    if (!todo) throw new Error(`Lease ${lease.id} has missing todo ${lease.todoId}`);
    if (state.goals[todo.goalId]?.ownerSessionId !== lease.ownerSessionId) {
      throw new Error(`Lease ${lease.id} owner does not match Goal ${todo.goalId}`);
    }
  }
  assertAcyclic(Object.keys(state.todos), (id) => state.todos[id]?.dependsOn ?? [], "Todo");
  assertAcyclic(Object.keys(state.todos), (id) => state.todos[id]?.parentId ? [state.todos[id]!.parentId!] : [], "Todo parent");
}
