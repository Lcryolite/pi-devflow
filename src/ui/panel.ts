import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";

import type { ProjectState } from "../domain/types.js";
import { TreeController } from "./tree-controller.js";
import { renderTreeRow } from "./tree-render.js";

export type DevflowPanelResult =
  | { type: "close" }
  | { type: "retry"; todoId: string }
  | { type: "toggle-pause" };


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
      lines.push(renderTreeRow(row, width, this.theme, {
        interactive: true,
        selected: row.key === selected,
      }));
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
