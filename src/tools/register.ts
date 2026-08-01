import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDevflowWorkflowTool } from "../pi/workflow-tool.js";
import { registerDevflowGoalTool } from "./goal-tool.js";
import { registerDevflowNormalizeTool } from "./normalize-tool.js";
import { registerDevflowTodoTool } from "./todo-tool.js";
import type { ToolDependencies } from "./tool-deps.js";

export function registerDevflowTools(pi: ExtensionAPI, dependencies: ToolDependencies): void {
  registerDevflowWorkflowTool(pi, dependencies);
  registerDevflowNormalizeTool(pi, dependencies);
  registerDevflowGoalTool(pi, dependencies);
  registerDevflowTodoTool(pi, dependencies);
}
