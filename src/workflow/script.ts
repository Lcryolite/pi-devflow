import type { ModelRole } from "../domain/types.js";
import { resolveRoleModel, type DevflowModelPolicy } from "./model-router.js";

export interface DevflowWorkflowPhasePlan {
  title: string;
  role: ModelRole;
  prompts: string[];
  escalateJudge?: boolean;
}

export interface DevflowWorkflowPlan {
  name: string;
  description: string;
  phases: DevflowWorkflowPhasePlan[];
}

export interface BuiltWorkflow {
  script: string;
  phases: Array<{ title: string; role: ModelRole; requestedModel?: string }>;
}

export function buildWorkflowScript(
  plan: DevflowWorkflowPlan,
  mainModel: string,
  policy: DevflowModelPolicy,
): BuiltWorkflow {
  if (!plan.name.trim() || !plan.description.trim()) throw new Error("Workflow name and description are required");
  if (plan.phases.length === 0) throw new Error("Workflow requires at least one phase");

  const phaseMetadata = plan.phases.map((phase) => {
    if (!phase.title.trim() || phase.prompts.length === 0) throw new Error("Every Workflow phase needs a title and prompt");
    const model = resolveRoleModel(phase.role, mainModel, policy, phase.escalateJudge ?? false);
    return {
      title: phase.title,
      role: phase.role,
      requestedModel: model,
    };
  });

  const lines = [
    `export const meta = ${JSON.stringify({
      name: plan.name,
      description: plan.description,
      phases: phaseMetadata.map((phase) => ({ title: phase.title })),
    })};`,
    "const outputs = {};",
  ];

  plan.phases.forEach((phase, phaseIndex) => {
    const route = phaseMetadata[phaseIndex]!;
    lines.push(`phase(${JSON.stringify(phase.title)});`);
    const calls = phase.prompts.map((prompt, promptIndex) => {
      const options = {
        label: `${plan.name}-${phaseIndex + 1}-${promptIndex + 1}`,
        ...(route.requestedModel ? { model: route.requestedModel } : {}),
      };
      return `() => agent(${JSON.stringify(prompt)}, ${JSON.stringify(options)})`;
    });
    lines.push(`outputs[${JSON.stringify(phase.title)}] = await parallel([${calls.join(",")}]);`);
  });
  lines.push("return outputs;");
  return { script: lines.join("\n"), phases: phaseMetadata };
}
