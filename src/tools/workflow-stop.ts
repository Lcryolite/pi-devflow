import type { ProjectState, WorkflowBinding } from "../domain/types.js";
import type { DevflowWorkflowAdapter } from "../workflow/adapter.js";

export async function stopWorkflowsForTodos(
  adapter: DevflowWorkflowAdapter,
  state: ProjectState,
  ownsTodo: (binding: WorkflowBinding) => boolean,
): Promise<void> {
  for (const binding of Object.values(state.workflowRuns)) {
    if (ownsTodo(binding) && (binding.status === "running" || binding.status === "paused")) {
      await adapter.stop(binding.id);
    }
  }
}
