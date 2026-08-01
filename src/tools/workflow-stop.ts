import type { ProjectState, WorkflowBinding } from "../domain/types.js";
import type { DevflowWorkflowAdapter } from "../workflow/adapter.js";

export async function stopWorkflowsForTodos(
  adapter: DevflowWorkflowAdapter,
  state: ProjectState,
  ownsTodo: (binding: WorkflowBinding) => boolean,
): Promise<void> {
  for (const binding of Object.values(state.workflowRuns)) {
    if (ownsTodo(binding) && (binding.status === "planned" || binding.status === "running" || binding.status === "paused")) {
      if (!(await adapter.stop(binding.id))) throw new Error(`Cannot stop Workflow binding ${binding.id}`);
    }
  }
}
