import { addGoal, addTodo } from "./state.js";
import type { AddGoalInput, AddTodoInput, ProjectState } from "./types.js";

export type NormalizationProposal =
  | {
      id: string;
      action: "create_goal";
      rationale: string;
      sourceRequest: string;
      goal: AddGoalInput;
      initialTodos?: Omit<AddTodoInput, "goalId">[];
    }
  | {
      id: string;
      action: "merge_as_todo";
      rationale: string;
      sourceRequest: string;
      targetGoalId: string;
      todo: Omit<AddTodoInput, "goalId" | "sourceRequest">;
    }
  | {
      id: string;
      action: "ask";
      question: string;
      recommendedAnswer: string;
      missingDecision: string;
    };

export function applyNormalizationProposal(
  state: ProjectState,
  proposal: NormalizationProposal,
  now: string,
): ProjectState {
  if (proposal.action === "ask") return state;
  if (state.appliedProposalIds.includes(proposal.id)) return state;

  let next = state;
  if (proposal.action === "create_goal") {
    next = addGoal(next, { ...proposal.goal, sourceRequest: proposal.sourceRequest }, now);
    const initialTodos = proposal.initialTodos?.length
      ? proposal.initialTodos
      : [{ id: `${proposal.goal.id}:root`, title: `Execute ${proposal.goal.title}`, execution: "main" as const, systemManaged: true }];
    for (const todo of initialTodos) {
      next = addTodo(next, { ...todo, goalId: proposal.goal.id, sourceRequest: proposal.sourceRequest }, now);
    }
  } else {
    const target = state.goals[proposal.targetGoalId];
    if (!target || ["completed", "cancelled"].includes(target.status)) {
      throw new Error(`Cannot merge request into inactive goal ${proposal.targetGoalId}`);
    }
    next = addTodo(next, {
      ...proposal.todo,
      goalId: proposal.targetGoalId,
      sourceRequest: proposal.sourceRequest,
    }, now);
  }
  next = structuredClone(next);
  next.appliedProposalIds.push(proposal.id);
  next.project.updatedAt = now;
  return next;
}
