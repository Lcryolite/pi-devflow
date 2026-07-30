import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ProjectStore } from "../store/project-store.js";
import type { DevflowWorkflowAdapter } from "../workflow/adapter.js";
import type { DevflowWorkflowPlan } from "../workflow/script.js";

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

export interface WorkflowToolDependencies {
  getAdapter(ctx: ExtensionContext): Promise<DevflowWorkflowAdapter>;
  getStore(ctx: ExtensionContext): Promise<ProjectStore>;
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

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
      if (params.action === "start") {
        const plan: DevflowWorkflowPlan = {
          name: required(params.name, "name"),
          description: required(params.description, "description"),
          phases: (params.phases ?? []).map((phase) => ({
            title: phase.title,
            role: phase.role,
            prompts: phase.prompts,
            ...(phase.escalateJudge !== undefined ? { escalateJudge: phase.escalateJudge } : {}),
          })),
        };
        if (plan.phases.length === 0) throw new Error("phases is required");
        const bindingId = await adapter.start(required(params.todoId, "todoId"), plan);
        const state = await store.load();
        return {
          content: [{ type: "text", text: `Started Workflow binding ${bindingId}` }],
          details: { bindingId, projectId: state.project.id, revision: state.revision },
        };
      }

      if (params.action === "status") {
        const state = await store.load();
        const bindings = params.bindingId
          ? [state.workflowRuns[params.bindingId]].filter((binding) => binding !== undefined)
          : Object.values(state.workflowRuns);
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

      const bindingId = required(params.bindingId, "bindingId");
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
