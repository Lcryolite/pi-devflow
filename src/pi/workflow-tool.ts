import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { DevflowWorkflowPlan } from "../workflow/script.js";
import type { ToolDependencies } from "../tools/tool-deps.js";
import { requireText } from "../tools/util.js";

const Action = StringEnum(["start", "status", "pause", "resume", "stop"] as const);
const Role = StringEnum(["fanout", "work", "judge"] as const);

const Params = Type.Object({
  action: Action,
  bindingId: Type.Optional(Type.String()),
  todoId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  phases: Type.Optional(Type.Array(Type.Object({
    title: Type.String(),
    role: Role,
    prompts: Type.Array(Type.String(), { minItems: 1 }),
    escalateJudge: Type.Optional(Type.Boolean()),
  }), { minItems: 1 })),
});

export type WorkflowToolDependencies = ToolDependencies;

export function registerDevflowWorkflowTool(pi: ExtensionAPI, dependencies: WorkflowToolDependencies): void {
  pi.registerTool({
    name: "devflow_workflow",
    label: "Devflow Workflow",
    description: "Run or control a Todo-bound multi-agent Workflow with visible phases and resolved models.",
    promptSnippet: "Delegate independent Todo work through the shared devflow WorkflowManager",
    parameters: Params,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adapter = await dependencies.getAdapter(ctx);
      const store = await dependencies.getStore(ctx);
      const scope = dependencies.getScope(ctx);
      if (params.action === "start") {
        const todoId = requireText(params.todoId, "todoId");
        const before = await store.load();
        const todo = before.todos[todoId];
        if (!todo || before.goals[todo.goalId]?.ownerSessionId !== scope.sessionId) {
          throw new Error(`Todo ${todoId} belongs to another Pi session`);
        }
        const plan: DevflowWorkflowPlan = {
          name: requireText(params.name, "name"),
          description: requireText(params.description, "description"),
          phases: (params.phases ?? []).map((phase) => ({
            title: phase.title,
            role: phase.role,
            prompts: phase.prompts,
            ...(phase.escalateJudge !== undefined ? { escalateJudge: phase.escalateJudge } : {}),
          })),
        };
        if (plan.phases.length === 0) throw new Error("phases is required");
        const bindingId = await adapter.start(todoId, plan);
        const state = await store.load();
        return {
          content: [{ type: "text", text: `Started Workflow binding ${bindingId}` }],
          details: { bindingId, projectId: state.project.id, revision: state.revision },
        };
      }

      if (params.action === "status") {
        const state = await store.load();
        const bindings = (params.bindingId
          ? [state.workflowRuns[params.bindingId]]
          : Object.values(state.workflowRuns))
          .filter((binding): binding is NonNullable<typeof binding> => binding?.ownerSessionId === scope.sessionId);
        return {
          content: [{
            type: "text",
            text: bindings.length === 0 ? "No Workflow bindings." : bindings.map((binding) => {
              const models = [...new Set(binding.phases.flatMap((phase) => phase.actualModels))];
              const model = models.length === 0 ? "inherit" : models.length === 1 ? models[0] : "mixed";
              return `${binding.status} ${binding.id} ${binding.phases.reduce((sum, phase) => sum + phase.agentCompleted, 0)}/${binding.phases.reduce((sum, phase) => sum + phase.agentTotal, 0)} agents · ${model}`;
            }).join("\n"),
          }],
          details: { bindings, revision: state.revision },
        };
      }

      const bindingId = requireText(params.bindingId, "bindingId");
      const binding = (await store.load()).workflowRuns[bindingId];
      if (!binding || binding.ownerSessionId !== scope.sessionId) throw new Error(`Workflow ${bindingId} belongs to another Pi session`);
      const changed = params.action === "pause"
        ? await adapter.pause(bindingId)
        : params.action === "resume"
          ? await adapter.resume(bindingId)
          : await adapter.stop(bindingId);
      if (!changed) throw new Error(`Cannot ${params.action} Workflow binding ${bindingId}`);
      return {
        content: [{ type: "text", text: `${params.action} succeeded for ${bindingId}` }],
        details: { bindingId },
      };
    },
  });
}
