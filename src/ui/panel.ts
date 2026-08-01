import { basename } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import type { ProjectState } from "../domain/types.js";
import { TreeController } from "./tree-controller.js";
import { renderTreeRow } from "./tree-render.js";
import { defaultWidgetExpandedIds } from "./widget.js";

export type DevflowPanelResult =
  | { type: "close" }
  | { type: "retry"; todoId: string }
  | { type: "toggle-pause" };

export class DevflowPanel implements Component {
  private readonly controller: TreeController;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly state: ProjectState,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (result: DevflowPanelResult) => void,
    expandedIds: Set<string> = defaultWidgetExpandedIds(state),
    private readonly ownerSessionId?: string,
  ) {
    this.controller = new TreeController(state, expandedIds, ownerSessionId);
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
    const w = Math.max(1, width);
    const rootLabel = basename(this.state.project.root) || this.state.project.root;
    const active = Object.values(this.state.goals).filter((goal) => (!this.ownerSessionId || goal.ownerSessionId === this.ownerSessionId) && (goal.status === "active" || goal.status === "blocked")).length;
    const paused = this.ownerSessionId ? this.state.scheduler.sessionPaused[this.ownerSessionId] ? " · paused" : "" : this.state.scheduler.paused ? " · paused" : "";
    const header = `devflow · ${rootLabel} · rev ${this.state.revision} · ${active} active${paused}`;
    const help = "↑↓ move · enter expand · left collapse · g focus · r retry · p pause · esc";
    const lines = [
      this.theme.fg("accent", this.theme.bold(truncateToWidth(header, w))),
      this.theme.fg("dim", truncateToWidth(this.state.project.root, w)),
      this.theme.fg("dim", truncateToWidth(help, w)),
      "",
    ];
    for (const row of this.controller.rows()) {
      lines.push(renderTreeRow(row, width, this.theme, {
        interactive: true,
        selected: row.key === this.controller.selectedRow()?.key,
      }));
    }
    if (lines.length === 4) lines.push(this.theme.fg("dim", "No goals or todos in this project."));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
