import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DevflowRuntime } from "./runtime/session.js";
import { registerDevflowTools } from "./tools/register.js";

export default function devflowExtension(pi: ExtensionAPI) {
  const runtime = new DevflowRuntime(pi);

  pi.on("session_start", async (_event, ctx) => runtime.bindSession(ctx));
  pi.on("session_tree", async (_event, ctx) => runtime.refreshUi(ctx));
  pi.on("session_compact", async (_event, ctx) => runtime.refreshUi(ctx));
  pi.on("session_shutdown", async (_event, ctx) => runtime.shutdown(ctx));
  pi.on("model_select", async (event) => runtime.onModelSelect(event));
  pi.on("before_agent_start", async (event, ctx) => runtime.beforeAgentStart(event, ctx));
  pi.on("agent_settled", async (_event, ctx) => {
    await runtime.dispatchReady(ctx, true);
  });
  pi.on("tool_execution_end", async (event, ctx) => runtime.onToolExecutionEnd(event, ctx));

  pi.registerShortcut("ctrl+shift+d", {
    description: "Toggle dynamic Devflow widget",
    handler: () => runtime.toggleWidget(),
  });

  registerDevflowTools(pi, {
    getAdapter: (ctx) => runtime.getAdapter(ctx),
    getStore: (ctx) => runtime.getStore(ctx),
  });

  pi.registerCommand("devflow-models", {
    description: "Interactively configure Devflow central/small/medium/big models",
    handler: async (_args, ctx) => runtime.openModelSelector(ctx),
  });

  pi.registerCommand("devflow", {
    description: "Open pi-devflow or show status and doctor checks",
    handler: async (args, ctx) => runtime.handleCommand(args, ctx),
  });
}
