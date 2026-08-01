import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ProjectStore } from "../store/project-store.js";
import type { DevflowWorkflowAdapter } from "../workflow/adapter.js";

export interface ToolDependencies {
  getAdapter(ctx: ExtensionContext): Promise<DevflowWorkflowAdapter>;
  getStore(ctx: ExtensionContext): Promise<ProjectStore>;
}
