import type { ProjectState } from "../domain/types.js";

export function requireText(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export function textResult(text: string, state: ProjectState) {
  return {
    content: [{ type: "text" as const, text }],
    details: { projectId: state.project.id, revision: state.revision },
  };
}
