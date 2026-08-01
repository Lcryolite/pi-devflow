import { randomUUID } from "node:crypto";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { addTodo, setTodoStatus } from "../domain/state.js";
import { blockTodo, moveTodo, recordTodoFailure, retryTodo, updateTodo } from "../domain/transitions.js";
import type { TodoStatus } from "../domain/types.js";
import { listTodos } from "../status.js";
import type { ToolDependencies } from "./tool-deps.js";
import { requireText, textResult } from "./util.js";
import { stopWorkflowsForTodos } from "./workflow-stop.js";

const TodoAction = StringEnum(["create", "list", "get", "update", "move", "retry", "cancel"] as const);
const TodoStatusSchema = StringEnum(["pending", "ready", "in_progress", "blocked", "completed", "cancelled"] as const);
const ExecutionSchema = StringEnum(["main", "workflow", "undecided"] as const);
const BlockerKindSchema = StringEnum(["decision", "permission", "resource", "tool", "validation", "workflow"] as const);
const ResourceModeSchema = StringEnum(["read", "write", "exclusive"] as const);
const WriteScopeSchema = StringEnum(["none", "known-disjoint", "shared", "unknown"] as const);
const ModelRoleSchema = StringEnum(["fanout", "work", "judge"] as const);
const TodoParams = Type.Object({
  action: TodoAction,
  id: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.String()),
  makeRoot: Type.Optional(Type.Boolean()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  execution: Type.Optional(ExecutionSchema),
  status: Type.Optional(TodoStatusSchema),
  blockerKind: Type.Optional(BlockerKindSchema),
  blockerReason: Type.Optional(Type.String()),
  unlockCondition: Type.Optional(Type.String()),
  recommendedAnswer: Type.Optional(Type.String()),
  strategy: Type.Optional(Type.String()),
  evidenceIds: Type.Optional(Type.Array(Type.String())),
  resourceClaims: Type.Optional(Type.Array(Type.Object({ key: Type.String(), mode: ResourceModeSchema }))),
  independentUnits: Type.Optional(Type.Integer({ minimum: 0 })),
  hasSequentialDependency: Type.Optional(Type.Boolean()),
  writeScope: Type.Optional(WriteScopeSchema),
  mergeableResults: Type.Optional(Type.Boolean()),
  estimatedUnits: Type.Optional(Type.Integer({ minimum: 0 })),
  workflowPlan: Type.Optional(Type.Object({
    name: Type.String(),
    description: Type.String(),
    phases: Type.Array(Type.Object({
      title: Type.String(),
      role: ModelRoleSchema,
      prompts: Type.Array(Type.String()),
      escalateJudge: Type.Optional(Type.Boolean()),
    })),
  })),
});

export function registerDevflowTodoTool(pi: ExtensionAPI, dependencies: ToolDependencies): void {
  pi.registerTool({
    name: "devflow_todo",
    label: "Devflow Todo",
    description: "Manage hierarchical project todos, dependencies, blockers, and bounded recovery attempts.",
    promptSnippet: "Manage hierarchical todos attached to devflow goals",
    parameters: TodoParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectStore = await dependencies.getStore(ctx);
      if (params.action === "list") {
        const state = await projectStore.load();
        return textResult(listTodos(state, params.goalId), state);
      }
      if (params.action === "get") {
        const state = await projectStore.load();
        const todo = state.todos[requireText(params.id, "id")];
        if (!todo) throw new Error(`Todo ${params.id} does not exist`);
        return textResult(JSON.stringify(todo, null, 2), state);
      }
      if (params.action === "cancel") {
        const state = await projectStore.load();
        const todoId = requireText(params.id, "id");
        const adapter = await dependencies.getAdapter(ctx);
        await stopWorkflowsForTodos(
          adapter,
          state,
          (binding) => binding.todoId === todoId || binding.phases.some((phase) => phase.todoId === todoId),
        );
      }

      const now = new Date().toISOString();
      const next = await projectStore.transact((state) => {
        if (params.action === "create") {
          const profileFields = [params.independentUnits, params.hasSequentialDependency, params.writeScope, params.mergeableResults, params.estimatedUnits];
          const hasProfile = profileFields.some((value) => value !== undefined);
          if (hasProfile && profileFields.some((value) => value === undefined)) {
            throw new Error("All execution profile fields are required together");
          }
          return addTodo(state, {
            id: params.id?.trim() || randomUUID(),
            goalId: requireText(params.goalId, "goalId"),
            title: requireText(params.title, "title"),
            ...(params.parentId ? { parentId: params.parentId } : {}),
            ...(params.description ? { description: params.description } : {}),
            ...(params.required !== undefined ? { required: params.required } : {}),
            ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
            ...(params.execution ? { execution: params.execution } : {}),
            ...(params.resourceClaims ? { resourceClaims: params.resourceClaims } : {}),
            ...(hasProfile ? {
              executionProfile: {
                independentUnits: params.independentUnits!,
                hasSequentialDependency: params.hasSequentialDependency!,
                writeScope: params.writeScope!,
                mergeableResults: params.mergeableResults!,
                estimatedUnits: params.estimatedUnits!,
              },
            } : {}),
            ...(params.workflowPlan ? { workflowPlan: params.workflowPlan } : {}),
          }, now);
        }

        const id = requireText(params.id, "id");
        if (params.action === "update") {
          if (params.status === "blocked") {
            if (params.strategy?.trim()) {
              return recordTodoFailure(
                state,
                id,
                params.strategy.trim(),
                requireText(params.blockerReason, "blockerReason"),
                params.evidenceIds ?? [],
                now,
              );
            }
            return blockTodo(state, id, {
              kind: params.blockerKind ?? "tool",
              reason: requireText(params.blockerReason, "blockerReason"),
              ...(params.unlockCondition ? { unlockCondition: params.unlockCondition } : {}),
              ...(params.recommendedAnswer ? { recommendedAnswer: params.recommendedAnswer } : {}),
              ...(params.evidenceIds ? { sourceIds: params.evidenceIds } : {}),
            }, now);
          }
          return updateTodo(state, id, {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.required !== undefined ? { required: params.required } : {}),
            ...(params.execution !== undefined ? { execution: params.execution } : {}),
            ...(params.status !== undefined ? { status: params.status as TodoStatus } : {}),
            ...(params.resourceClaims !== undefined ? { resourceClaims: params.resourceClaims } : {}),
            ...(params.workflowPlan !== undefined ? { workflowPlan: params.workflowPlan } : {}),
          }, now);
        }
        if (params.action === "move") return moveTodo(state, id, params.makeRoot ? undefined : requireText(params.parentId, "parentId"), now);
        if (params.action === "retry") return retryTodo(state, id, requireText(params.strategy, "strategy"), now);
        if (params.action === "cancel") return setTodoStatus(state, id, "cancelled", undefined, now);
        throw new Error(`Unsupported todo action: ${params.action}`);
      });
      return textResult(`Todo ${params.action} succeeded.`, next);
    },
  });
}
