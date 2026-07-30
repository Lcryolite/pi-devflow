import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { ProjectState } from "../domain/types.js";
import { TreeController } from "./tree-controller.js";

export type DevflowPanelResult =
  | { type: "close" }
  | { type: "retry"; todoId: string }
  | { type: "toggle-pause" };

const statusSymbol: Record<string, string> = {
  active: "●",
  pending: "○",
  ready: "◇",
  in_progress: "●",
  blocked: "!",
  completed: "✓",
  cancelled: "×",
};

export class DevflowPanel implements Component {
  private readonly controller: TreeController;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    state: ProjectState,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (result: DevflowPanelResult) => void,
  ) {
    this.controller = new TreeController(state);
    for (const goal of Object.values(state.goals)) this.controller.expand(`goal:${goal.id}`);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ type: "close" });
      return;
    }
    if (matchesKey(data, Key.up)) this.controller.move(-1);
    else if (matchesKey(data, Key.down)) this.controller.move(1);
    else if (matchesKey(data, Key.right) || matchesKey(data, Key.enter)) this.controller.activate();
    else if (matchesKey(data, Key.left)) this.controller.left();
    else if (data === "g") this.controller.toggleGoalFocus();
    else if (data === "r") {
      const action = this.controller.retrySelected();
      if (action.type === "retry") {
        this.done(action);
        return;
      }
    } else if (data === "p") {
      this.done({ type: "toggle-pause" });
      return;
    } else return;
    this.cachedLines = undefined;
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const selected = this.controller.selectedRow()?.key;
    const lines = [
      this.theme.fg("accent", this.theme.bold("pi-devflow")),
      this.theme.fg("dim", "↑↓ navigate · enter/right expand · left collapse · g focus · r retry · p pause · esc close"),
      "",
    ];
    for (const row of this.controller.rows()) {
      const isSelected = row.key === selected;
      const cursor = isSelected ? this.theme.fg("accent", ">") : " ";
      const indent = "  ".repeat(row.depth);
      const arrow = row.expandable ? (row.expanded ? "▼" : "▶") : " ";
      const symbol = row.status ? statusSymbol[row.status] ?? " " : " ";
      const number = row.number ? `${row.number} ` : "";
      const workflowBadge = "workflowBadge" in row && typeof row.workflowBadge === "string" ? row.workflowBadge : undefined;
      const base = `${cursor} ${indent}${arrow} ${symbol} ${number}${row.title}${workflowBadge ? ` [${workflowBadge}]` : ""}`;
      const styled = row.kind === "detail"
        ? this.theme.fg("warning", base)
        : isSelected ? this.theme.fg("accent", base) : base;
      lines.push(truncateToWidth(styled, Math.max(1, width)));
    }
    if (lines.length === 3) lines.push(this.theme.fg("dim", "No goals or todos."));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
