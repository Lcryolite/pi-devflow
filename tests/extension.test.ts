import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import devflowExtension from "../src/extension.js";

test("extension registers tools and a global widget toggle shortcut", async () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const shortcuts: string[] = [];
  let shortcutHandler: ((ctx: unknown) => Promise<void> | void) | undefined;
  const fakePi = {
    on(name: string) { events.push(name); },
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    registerShortcut(name: string, definition: { handler(ctx: unknown): Promise<void> | void }) { shortcuts.push(name); shortcutHandler = definition.handler; }
  } as unknown as ExtensionAPI;

  devflowExtension(fakePi);

  assert.deepEqual(tools, ["devflow_workflow", "devflow_normalize", "devflow_goal", "devflow_todo"]);
  assert.deepEqual(commands, ["devflow-models", "devflow"]);
  assert.deepEqual(shortcuts, ["ctrl+shift+d"]);
  assert.deepEqual(events, ["session_start", "session_tree", "session_compact", "session_shutdown", "model_select", "before_agent_start", "agent_settled", "tool_execution_end"]);
  assert.ok(shortcutHandler);
  await shortcutHandler({
    mode: "tui",
    ui: { custom: () => { throw new Error("shortcut must not open the /devflow panel"); } },
  });
});
