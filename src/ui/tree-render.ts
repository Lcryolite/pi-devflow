import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { TreeRow } from "./tree-model.js";

const statusSymbol: Record<string, string> = {
  active: "●",
  pending: "○",
  ready: "◇",
  in_progress: "●",
  blocked: "!",
  completed: "✓",
  cancelled: "×",
};

export interface TreeRowRenderOptions {
  interactive?: boolean;
  selected?: boolean;
}

export function renderTreeRow(
  row: TreeRow,
  width: number,
  theme: Theme,
  options: TreeRowRenderOptions = {},
): string {
  const prefix = options.interactive
    ? `${options.selected ? theme.fg("accent", ">") : " "} `
    : "";
  const indent = "  ".repeat(row.depth);
  const arrow = row.expandable ? (row.expanded ? "▼" : "▶") : " ";
  const symbol = row.status ? statusSymbol[row.status] ?? " " : " ";
  const number = row.number ? `${row.number} ` : "";
  const workflowBadge = row.workflowBadge ? ` [${row.workflowBadge}]` : "";
  const base = `${prefix}${indent}${arrow} ${symbol} ${number}${row.title}${workflowBadge}`;
  const styled = row.kind === "detail"
    ? theme.fg("warning", base)
    : options.selected ? theme.fg("accent", base) : base;
  return truncateToWidth(styled, Math.max(1, width));
}
