import { loadModelTierConfig, resolveTierModel, type ModelTierConfig } from "@quintinshaw/pi-dynamic-workflows";

import type { DevflowModelPolicy } from "./model-router.js";

export function modelPolicyFromTierConfig(config: ModelTierConfig | null): DevflowModelPolicy {
  if (!config) return {};
  const fanout = resolveTierModel("small", config);
  const work = resolveTierModel("medium", config);
  const judge = resolveTierModel("big", config) ?? resolveTierModel("large", config);
  return {
    ...(fanout ? { fanout } : {}),
    ...(work ? { work } : {}),
    ...(judge ? { judge } : {}),
  };
}

export function loadDevflowModelPolicy(): DevflowModelPolicy {
  return modelPolicyFromTierConfig(loadModelTierConfig());
}

export function describeModelPolicy(policy: DevflowModelPolicy, mainModel: string): string {
  return [
    `fanout: ${policy.fanout ?? `${mainModel} (inherit)`}`,
    `work: ${policy.work ?? `${mainModel} (inherit)`}`,
    `judge: ${mainModel} initially${policy.judge ? `; escalates to ${policy.judge}` : ""}`,
  ].join("\n");
}
