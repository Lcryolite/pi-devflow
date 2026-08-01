import type { WorkflowSnapshot } from "@quintinshaw/pi-dynamic-workflows";

import { addTodo } from "../domain/state.js";
import {
  LEGACY_UNOWNED_SESSION,
  type ModelRole,
  type ProjectState,
  type WorkflowAgentProjection,
  type WorkflowPhaseProjection,
} from "../domain/types.js";

export interface CreateWorkflowBindingInput {
  bindingId: string;
  upstreamRunId: string;
  todoId: string;
  ownerSessionId?: string;
  ownerRuntimeId?: string;
  status?: "planned" | "running";
  phases: Array<{ title: string; role: ModelRole; requestedModel?: string }>;
}

export function createWorkflowBinding(
  state: ProjectState,
  input: CreateWorkflowBindingInput,
  now: string,
): ProjectState {
  const parent = state.todos[input.todoId];
  if (!parent) throw new Error(`Todo ${input.todoId} does not exist`);
  const goal = state.goals[parent.goalId];
  if (!goal || goal.status === "completed" || goal.status === "cancelled" || parent.status === "completed" || parent.status === "cancelled") {
    throw new Error(`Todo ${input.todoId} is terminal and cannot start a Workflow`);
  }
  if (state.workflowRuns[input.bindingId]) throw new Error(`Workflow binding ${input.bindingId} already exists`);
  const activeBinding = Object.values(state.workflowRuns).find((binding) =>
    binding.todoId === input.todoId && ["planned", "running", "paused"].includes(binding.status));
  if (activeBinding) throw new Error(`Todo ${input.todoId} already has active Workflow ${activeBinding.id}`);
  let next = structuredClone(state);
  const phases: WorkflowPhaseProjection[] = [];
  let previousTodoId: string | undefined;
  input.phases.forEach((phase, index) => {
    const phaseTodoId = `${input.bindingId}:phase:${index + 1}`;
    next = addTodo(next, {
      id: phaseTodoId,
      goalId: parent.goalId,
      parentId: parent.id,
      title: phase.title,
      execution: "workflow",
      ...(previousTodoId ? { dependsOn: [previousTodoId] } : {}),
    }, now);
    next.todos[phaseTodoId]!.origin = { kind: "workflow-phase", bindingId: input.bindingId, phaseTitle: phase.title };
    phases.push({
      id: `${input.bindingId}:phase:${index + 1}`,
      title: phase.title,
      role: phase.role,
      todoId: phaseTodoId,
      ...(phase.requestedModel ? { requestedModel: phase.requestedModel } : {}),
      actualModels: [],
      agentTotal: 0,
      agentCompleted: 0,
      agents: [],
    });
    previousTodoId = phaseTodoId;
  });
  next.todos[input.todoId]!.workflowRunId = input.bindingId;
  next.todos[input.todoId]!.execution = "workflow";
  next.workflowRuns[input.bindingId] = {
    id: input.bindingId,
    todoId: input.todoId,
    upstreamRunId: input.upstreamRunId,
    ownerSessionId: input.ownerSessionId ?? state.goals[parent.goalId]?.ownerSessionId ?? LEGACY_UNOWNED_SESSION,
    ownerRuntimeId: input.ownerRuntimeId ?? LEGACY_UNOWNED_SESSION,
    status: input.status ?? "running",
    phases,
    lastSnapshotSequence: 0,
    startedAt: now,
  };
  return next;
}

function agentProjection(agent: WorkflowSnapshot["agents"][number], upstreamRunId: string): WorkflowAgentProjection {
  return {
    callId: agent.callId ?? `${upstreamRunId}:${agent.id}`,
    label: agent.label,
    status: agent.status,
    ...(agent.model ? { model: agent.model } : {}),
    modelConfirmed: (agent.status === "done" || agent.status === "error") && Boolean(agent.model),
    ...(agent.error ? { error: agent.error } : {}),
    ...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
  };
}

export function applyWorkflowSnapshot(
  state: ProjectState,
  bindingId: string,
  snapshot: WorkflowSnapshot,
  sequence: number,
  now: string,
): ProjectState {
  const current = state.workflowRuns[bindingId];
  if (!current) throw new Error(`Workflow binding ${bindingId} does not exist`);
  if (current.status === "completed" || current.status === "failed" || current.status === "stopped") return state;
  if (sequence <= current.lastSnapshotSequence) return state;
  const next = structuredClone(state);
  const binding = next.workflowRuns[bindingId]!;
  binding.lastSnapshotSequence = sequence;
  if (snapshot.currentPhase) binding.currentPhaseTitle = snapshot.currentPhase;
  binding.lastProgressAt = now;
  const currentIndex = snapshot.currentPhase ? binding.phases.findIndex((phase) => phase.title === snapshot.currentPhase) : -1;

  const runningAgents = snapshot.agents.filter((agent) => agent.status === "running");
  const errorAgent = snapshot.agents.find((agent) => agent.status === "error");
  const doneAgent = [...snapshot.agents].reverse().find((agent) => agent.status === "done");
  const lastAction = runningAgents.length > 0
    ? `running: ${runningAgents[0]!.label}${runningAgents.length > 1 ? ` +${runningAgents.length - 1}` : ""}`
    : errorAgent ? `error: ${errorAgent.label}` : doneAgent ? `done: ${doneAgent.label}` : snapshot.currentPhase;
  if (lastAction) binding.lastAction = lastAction;
  binding.phases.forEach((phase, index) => {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase.title).map((agent) => agentProjection(agent, binding.upstreamRunId));
    phase.agents = agents;
    phase.agentTotal = agents.length;
    phase.agentCompleted = agents.filter((agent) => agent.status === "done" || agent.status === "error" || agent.status === "skipped").length;
    phase.actualModels = [...new Set(agents.map((agent) => agent.model).filter((model): model is string => Boolean(model)))];
    const todo = next.todos[phase.todoId]!;
    if (currentIndex > index) {
      todo.status = "completed";
      todo.completedAt = now;
    } else if (currentIndex === index) {
      todo.status = "in_progress";
      delete todo.completedAt;
    }
    if (currentIndex >= index && todo.updatedAt !== now) todo.updatedAt = now;
  });
  return next;
}

export function completeWorkflowBinding(state: ProjectState, bindingId: string, now: string): ProjectState {
  const next = structuredClone(state);
  const binding = next.workflowRuns[bindingId];
  if (!binding) throw new Error(`Workflow binding ${bindingId} does not exist`);
  binding.status = "completed";
  binding.endedAt = now;
  for (const phase of binding.phases) {
    const todo = next.todos[phase.todoId];
    if (todo) {
      todo.status = "completed";
      todo.completedAt = now;
      todo.updatedAt = now;
    }
  }
  return next;
}

export function failWorkflowBinding(state: ProjectState, bindingId: string, reason: string, now: string): ProjectState {
  const next = structuredClone(state);
  const binding = next.workflowRuns[bindingId];
  if (!binding) throw new Error(`Workflow binding ${bindingId} does not exist`);
  binding.status = "failed";
  binding.endedAt = now;
  const active = binding.phases.find((phase) => next.todos[phase.todoId]?.status === "in_progress") ?? binding.phases[0];
  if (active) {
    const todo = next.todos[active.todoId]!;
    todo.status = "blocked";
    todo.blocker = { kind: "workflow", reason, sourceIds: [binding.upstreamRunId] };
    todo.updatedAt = now;
  }
  return next;
}

export function workflowPhaseModelLabel(phase: WorkflowPhaseProjection): string {
  if (phase.actualModels.length === 0) return phase.requestedModel ? `${phase.requestedModel}?` : "inherit";
  if (phase.actualModels.length > 1) return "mixed";
  const model = phase.actualModels[0]!;
  const resolved = phase.requestedModel && phase.requestedModel !== model ? `${model} (fallback)` : model;
  return phase.agents.every((agent) => !agent.model || agent.modelConfirmed) ? resolved : `${resolved}?`;
}
