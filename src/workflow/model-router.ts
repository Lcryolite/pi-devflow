import type { ModelRole } from "../domain/types.js";

export interface DevflowModelPolicy {
  fanout?: string;
  work?: string;
  judge?: string;
}

export function resolveRoleModel(
  role: ModelRole,
  mainModel: string,
  policy: DevflowModelPolicy,
  escalateJudge: boolean,
): string {
  if (role === "fanout") return policy.fanout ?? mainModel;
  if (role === "judge" && escalateJudge) return policy.judge ?? mainModel;
  if (role === "work") return policy.work ?? mainModel;
  return mainModel;
}
