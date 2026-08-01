import { randomUUID } from "node:crypto";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { auditGoal } from "../domain/audit.js";
import {
  addCriterionEvidence,
  addEvidence,
  addGoal,
  addTodo,
  completeGoal,
} from "../domain/state.js";
import { cancelGoal, updateGoal } from "../domain/transitions.js";
import type { Evidence, SuccessCriterion } from "../domain/types.js";
import { listGoals } from "../status.js";
import type { ToolDependencies } from "./tool-deps.js";
import { requireText, textResult } from "./util.js";
import { stopWorkflowsForTodos } from "./workflow-stop.js";

const GoalAction = StringEnum(["create", "list", "get", "update", "audit", "complete", "cancel"] as const);
const EvidenceKindSchema = StringEnum(["test", "file", "command", "review", "workflow", "user", "legacy"] as const);
const GoalParams = Type.Object({
  action: GoalAction,
  id: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  objective: Type.Optional(Type.String()),
  successCriteria: Type.Optional(Type.Array(Type.String())),
  constraints: Type.Optional(Type.Array(Type.String())),
  nonGoals: Type.Optional(Type.Array(Type.String())),
  evidenceRequirements: Type.Optional(Type.Array(Type.String())),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  criterionId: Type.Optional(Type.String()),
  evidenceId: Type.Optional(Type.String()),
  evidenceKind: Type.Optional(EvidenceKindSchema),
  evidenceSummary: Type.Optional(Type.String()),
  evidenceLocator: Type.Optional(Type.String()),
  evidenceValid: Type.Optional(Type.Boolean()),
});

export function registerDevflowGoalTool(pi: ExtensionAPI, dependencies: ToolDependencies): void {
  pi.registerTool({
    name: "devflow_goal",
    label: "Devflow Goal",
    description: "Create and manage project-scoped completion contracts with success criteria and evidence.",
    promptSnippet: "Manage durable project goals and their completion evidence",
    parameters: GoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectStore = await dependencies.getStore(ctx);
      const scope = dependencies.getScope(ctx);
      const requireOwnedGoal = (state: Awaited<ReturnType<typeof projectStore.load>>, id: string) => {
        const goal = state.goals[id];
        if (!goal) throw new Error(`Goal ${id} does not exist`);
        if (goal.ownerSessionId !== scope.sessionId) throw new Error(`Goal ${id} belongs to another Pi session`);
        return goal;
      };
      if (params.action === "list") {
        const state = await projectStore.load();
        return textResult(listGoals(state, scope.sessionId), state);
      }
      if (params.action === "get") {
        const state = await projectStore.load();
        const goal = requireOwnedGoal(state, requireText(params.id, "id"));
        return textResult(JSON.stringify(goal, null, 2), state);
      }
      if (params.action === "audit") {
        const state = await projectStore.load();
        requireOwnedGoal(state, requireText(params.id, "id"));
        return textResult(JSON.stringify(auditGoal(state, requireText(params.id, "id")), null, 2), state);
      }
      if (params.action === "cancel") {
        const state = await projectStore.load();
        const goalId = requireText(params.id, "id");
        requireOwnedGoal(state, goalId);
        const todoIds = new Set(Object.values(state.todos).filter((todo) => todo.goalId === goalId).map((todo) => todo.id));
        const adapter = await dependencies.getAdapter(ctx);
        await stopWorkflowsForTodos(adapter, state, (binding) => todoIds.has(binding.todoId));
      }

      const now = new Date().toISOString();
      const next = await projectStore.transact((state) => {
        if (params.action === "create") {
          const id = params.id?.trim() || randomUUID();
          const criteria: SuccessCriterion[] = (params.successCriteria ?? []).map((text, index) => ({
            id: `${id}:criterion:${index + 1}`,
            text,
            required: true,
            evidenceIds: [],
          }));
          const title = requireText(params.title, "title");
          let created = addGoal(state, {
            id,
            ownerSessionId: scope.sessionId,
            title,
            objective: requireText(params.objective, "objective"),
            successCriteria: criteria,
            ...(params.constraints ? { constraints: params.constraints } : {}),
            ...(params.nonGoals ? { nonGoals: params.nonGoals } : {}),
            ...(params.evidenceRequirements ? { evidenceRequirements: params.evidenceRequirements } : {}),
            ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
          }, now);
          created = addTodo(created, {
            id: `${id}:root`,
            goalId: id,
            title: `Execute ${title}`,
            execution: "main",
            systemManaged: true,
          }, now);
          return created;
        }

        const id = requireText(params.id, "id");
        requireOwnedGoal(state, id);
        if (params.action === "update") {
          let updated = updateGoal(state, id, {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.objective !== undefined ? { objective: params.objective } : {}),
            ...(params.constraints !== undefined ? { constraints: params.constraints } : {}),
            ...(params.nonGoals !== undefined ? { nonGoals: params.nonGoals } : {}),
            ...(params.evidenceRequirements !== undefined ? { evidenceRequirements: params.evidenceRequirements } : {}),
          }, now);
          if (params.criterionId || params.evidenceId) {
            const evidenceId = requireText(params.evidenceId, "evidenceId");
            if (params.evidenceSummary || params.evidenceKind || params.evidenceLocator || params.evidenceValid !== undefined) {
              const existing = updated.evidence[evidenceId];
              const evidence: Evidence = {
                id: evidenceId,
                ownerSessionId: scope.sessionId,
                kind: params.evidenceKind ?? existing?.kind ?? "user",
                summary: params.evidenceSummary ?? existing?.summary ?? evidenceId,
                ...(params.evidenceLocator ? { locator: params.evidenceLocator } : existing?.locator ? { locator: existing.locator } : {}),
                observedAt: now,
                valid: params.evidenceValid ?? existing?.valid ?? true,
              };
              updated = addEvidence(updated, evidence);
            }
            updated = addCriterionEvidence(updated, id, requireText(params.criterionId, "criterionId"), evidenceId, now);
          }
          return updated;
        }
        if (params.action === "complete") return completeGoal(state, id, now);
        if (params.action === "cancel") return cancelGoal(state, id, now);
        throw new Error(`Unsupported goal action: ${params.action}`);
      });
      return textResult(`Goal ${params.action} succeeded.`, next);
    },
  });
}
