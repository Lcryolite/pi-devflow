import { loadModelTierConfig, resolveTierModel } from "@quintinshaw/pi-dynamic-workflows";

import type { DevflowModelPolicy } from "./model-router.js";

export function loadDevflowModelPolicy(): DevflowModelPolicy {
  const config = loadModelTierConfig();
  if (!config) return {};
  const fanout = resolveTierModel("small", config);
  const judge = resolveTierModel("big", config) ?? resolveTierModel("large", config);
  return {
    ...(fanout ? { fanout } : {}),
    ...(judge ? { judge } : {}),
  };
}

export function describeModelPolicy(policy: DevflowModelPolicy, mainModel: string): string {
  return [
    `fanout: ${policy.fanout ?? `${mainModel} (inherit)`}`,
    `work: ${policy.work ?? `${mainModel} (inherit)`}`,
    `judge: ${mainModel} initially${policy.judge ? `; escalates to ${policy.judge}` : ""}`,
  ].join("\n");
}
