import type { ProjectState } from "../domain/types.js";
import { projectTreeRows, type TreeRow } from "./tree-model.js";

export type TreeAction =
  | { type: "expand" | "collapse"; key: string }
  | { type: "retry"; todoId: string }
  | { type: "none" };

export class TreeController {
  readonly expandedIds: Set<string>;
  private selectedKey: string | undefined;
  private focusedGoalId: string | undefined;

  constructor(private state: ProjectState, expandedIds?: Set<string>, private readonly ownerSessionId?: string) {
    this.expandedIds = expandedIds ?? new Set<string>();
  }

  update(state: ProjectState): void {
    this.state = state;
    if (this.selectedKey && !this.rows().some((row) => row.key === this.selectedKey)) this.selectedKey = undefined;
  }

  rows(): TreeRow[] {
    return projectTreeRows(this.state, this.expandedIds, this.focusedGoalId, this.ownerSessionId);
  }

  selectedRow(): TreeRow | undefined {
    const rows = this.rows();
    return rows.find((row) => row.key === this.selectedKey) ?? rows[0];
  }

  selectKey(key: string): void {
    if (this.rows().some((row) => row.key === key)) this.selectedKey = key;
  }

  move(delta: number): void {
    const rows = this.rows().filter((row) => row.kind !== "detail");
    if (rows.length === 0) return;
    const current = Math.max(0, rows.findIndex((row) => row.key === this.selectedRow()?.key));
    const next = Math.max(0, Math.min(rows.length - 1, current + delta));
    this.selectedKey = rows[next]?.key;
  }

  expand(key: string): void {
    if (this.rows().find((row) => row.key === key)?.expandable) this.expandedIds.add(key);
  }

  activate(): TreeAction {
    const row = this.selectedRow();
    if (!row?.expandable) return { type: "none" };
    if (this.expandedIds.has(row.key)) {
      this.expandedIds.delete(row.key);
      return { type: "collapse", key: row.key };
    }
    this.expandedIds.add(row.key);
    return { type: "expand", key: row.key };
  }

  left(): void {
    const row = this.selectedRow();
    if (!row) return;
    if (this.expandedIds.delete(row.key)) return;
    if (row.parentKey) this.selectedKey = row.parentKey;
  }

  retrySelected(): TreeAction {
    const row = this.selectedRow();
    if (row?.kind !== "todo" || row.status !== "blocked" || !row.todoId) return { type: "none" };
    const todo = this.state.todos[row.todoId];
    if (!todo || todo.attempts.filter((attempt) => attempt.outcome === "failed").length >= 2) return { type: "none" };
    return { type: "retry", todoId: row.todoId };
  }

  toggleGoalFocus(): string | undefined {
    const row = this.selectedRow();
    if (row?.goalId && this.focusedGoalId !== row.goalId) this.focusedGoalId = row.goalId;
    else this.focusedGoalId = undefined;
    this.selectedKey = undefined;
    return this.focusedGoalId;
  }
}
