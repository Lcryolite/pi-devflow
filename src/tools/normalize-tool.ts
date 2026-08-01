import { randomUUID } from "node:crypto";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { applyNormalizationProposal, type NormalizationProposal } from "../domain/normalization.js";
import type { ToolDependencies } from "./tool-deps.js";
import { requireText, textResult } from "./util.js";

const NormalizeAction = StringEnum(["create_goal", "merge_as_todo", "ask"] as const);
const NormalizeParams = Type.Object({
  action: NormalizeAction,
  proposalId: Type.String(),
  sourceRequest: Type.Optional(Type.String()),
  rationale: Type.Optional(Type.String()),
  targetGoalId: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  todoId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  objective: Type.Optional(Type.String()),
  successCriteria: Type.Optional(Type.Array(Type.String())),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  question: Type.Optional(Type.String()),
  recommendedAnswer: Type.Optional(Type.String()),
  missingDecision: Type.Optional(Type.String()),
});

export function registerDevflowNormalizeTool(pi: ExtensionAPI, dependencies: ToolDependencies): void {
  pi.registerTool({
    name: "devflow_normalize",
    label: "Devflow Normalize",
    description: "Normalize a user request into a new independent Goal, merge it into an existing Goal as a Todo, or ask one consequential clarification. Use merge_as_todo when the request has no independent completion value.",
    promptSnippet: "Normalize requests before creating durable Goal/Todo state",
    parameters: NormalizeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectStore = await dependencies.getStore(ctx);
      const scope = dependencies.getScope(ctx);
      if (params.action === "ask") {
        const state = await projectStore.load();
        const question = requireText(params.question, "question");
        const recommendedAnswer = requireText(params.recommendedAnswer, "recommendedAnswer");
        requireText(params.missingDecision, "missingDecision");
        return textResult(`${question}\nRecommended answer: ${recommendedAnswer}`, state);
      }
      const sourceRequest = requireText(params.sourceRequest, "sourceRequest");
      const rationale = requireText(params.rationale, "rationale");
      const proposal: NormalizationProposal = params.action === "create_goal"
        ? {
            id: `${scope.sessionId}:${params.proposalId}`,
            action: "create_goal",
            rationale,
            sourceRequest,
            goal: {
              id: params.goalId?.trim() || randomUUID(),
              ownerSessionId: scope.sessionId,
              title: requireText(params.title, "title"),
              objective: requireText(params.objective, "objective"),
              successCriteria: (params.successCriteria ?? []).map((text, index) => ({
                id: `${params.proposalId}:criterion:${index + 1}`, text, required: true, evidenceIds: [],
              })),
              ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
            },
          }
        : {
            id: `${scope.sessionId}:${params.proposalId}`,
            action: "merge_as_todo",
            rationale,
            sourceRequest,
            targetGoalId: requireText(params.targetGoalId, "targetGoalId"),
            todo: {
              id: params.todoId?.trim() || randomUUID(),
              title: requireText(params.title, "title"),
              ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
            },
          };
      const next = await projectStore.transact(
        (state) => {
          if (proposal.action === "merge_as_todo" && state.goals[proposal.targetGoalId]?.ownerSessionId !== scope.sessionId) {
            throw new Error(`Goal ${proposal.targetGoalId} belongs to another Pi session`);
          }
          return applyNormalizationProposal(state, proposal, new Date().toISOString());
        },
        { actor: "tool:devflow_normalize" },
      );
      return textResult(`Normalization ${proposal.action} applied: ${proposal.rationale}`, next);
    },
  });
}
