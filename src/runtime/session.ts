import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowManager } from "@quintinshaw/pi-dynamic-workflows";

import { applyContinuationClaim } from "../domain/continuation.js";
import { validateProject } from "../domain/invariants.js";
import { recoverInterruptedExecutions } from "../domain/scheduler.js";
import { addEvidence } from "../domain/state.js";
import { retryTodo, setSchedulerPaused } from "../domain/transitions.js";
import type { ProjectState } from "../domain/types.js";
import { selectPendingGrill } from "../grill.js";
import { importLegacyBranch } from "../import/legacy.js";
import { formatStatus } from "../status.js";
import { resolveDevflowProjectRoot } from "../store/project-root.js";
import { ProjectStore } from "../store/project-store.js";
import { openDevflowModelSelector } from "../ui/model-selector.js";
import { DevflowPanel, type DevflowPanelResult } from "../ui/panel.js";
import { renderDynamicWidget, syncWidgetExpandedIds, syncWidgetView, toggleWidgetView } from "../ui/widget.js";
import { DevflowWorkflowAdapter } from "../workflow/adapter.js";
import type { DevflowModelPolicy } from "../workflow/model-router.js";
import { loadDevflowModelPolicy, modelPolicyFromTierConfig } from "../workflow/policy.js";
import { DispatchGate, runDispatchPass } from "./dispatch.js";

type WidgetTui = { requestRender(force?: boolean): void };

/**
 * Owns session-scoped store, workflow adapter, UI widget state, and dispatch.
 * Extension entrypoint only wires Pi hooks/tools/commands to this runtime.
 */
export class DevflowRuntime {
  private store: ProjectStore | undefined;
  private storeCwd: string | undefined;
  private currentState: ProjectState | undefined;
  private unsubscribe: (() => void) | undefined;
  private widgetTui: WidgetTui | undefined;
  private workflowManager: WorkflowManager | undefined;
  private workflowManagerCwd: string | undefined;
  private workflowAdapter: DevflowWorkflowAdapter | undefined;
  private mainModel = "inherit";
  private readonly modelPolicy: DevflowModelPolicy = loadDevflowModelPolicy();
  private readonly widgetExpandedIds = new Set<string>();
  private readonly widgetGoalStatuses = new Map<string, ProjectState["goals"][string]["status"]>();
  private readonly widgetView = { expanded: false, hadActivity: undefined as boolean | undefined };
  private activeContext: ExtensionContext | undefined;
  private readonly gate = new DispatchGate();

  constructor(private readonly pi: ExtensionAPI) {}

  applyModelPolicy(next: DevflowModelPolicy): void {
    for (const key of Object.keys(this.modelPolicy) as Array<keyof DevflowModelPolicy>) {
      delete this.modelPolicy[key];
    }
    Object.assign(this.modelPolicy, next);
  }

  async getStore(ctx: ExtensionContext): Promise<ProjectStore> {
    const root = await resolveDevflowProjectRoot(ctx.cwd);
    if (!this.store || this.storeCwd !== root) {
      this.unsubscribe?.();
      this.widgetExpandedIds.clear();
      this.widgetGoalStatuses.clear();
      this.widgetView.expanded = false;
      this.widgetView.hadActivity = undefined;
      this.store = await ProjectStore.open(root);
      this.storeCwd = root;
    }
    return this.store;
  }

  async getAdapter(ctx: ExtensionContext): Promise<DevflowWorkflowAdapter> {
    const root = await resolveDevflowProjectRoot(ctx.cwd);
    const projectStore = await this.getStore(ctx);
    this.mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "inherit";
    if (!this.workflowManager || this.workflowManagerCwd !== root) {
      this.workflowManager = new WorkflowManager({ cwd: root });
      this.workflowManagerCwd = root;
      this.applyModelPolicy(loadDevflowModelPolicy());
      this.workflowAdapter = new DevflowWorkflowAdapter(
        this.workflowManager,
        projectStore,
        () => this.mainModel,
        this.modelPolicy,
        () => {
          if (this.activeContext) void this.dispatchReady(this.activeContext, true);
        },
      );
    }
    this.workflowManager.setMainModel(this.mainModel === "inherit" ? undefined : this.mainModel);
    this.workflowManager.setModelRegistry(ctx.modelRegistry);
    this.workflowManager.setSessionId(ctx.sessionManager.getSessionId());
    return this.workflowAdapter!;
  }

  async dispatchReady(ctx: ExtensionContext, allowMain = false): Promise<void> {
    await this.gate.run(ctx, allowMain, (passCtx, passMain) =>
      runDispatchPass(
        {
          pi: this.pi,
          getStore: (c) => this.getStore(c),
          getAdapter: (c) => this.getAdapter(c),
        },
        passCtx,
        passMain,
      ));
  }

  private updateUiState(ctx: ExtensionContext, state: ProjectState): void {
    this.currentState = state;
    syncWidgetExpandedIds(state, this.widgetExpandedIds, this.widgetGoalStatuses);
    syncWidgetView(state, this.widgetView);
    const active = Object.values(state.goals).filter((goal) => goal.status === "active" || goal.status === "blocked").length;
    ctx.ui.setStatus("devflow", active > 0 ? `devflow:${active}` : undefined);
    this.widgetTui?.requestRender(true);
  }

  async bindSession(ctx: ExtensionContext): Promise<void> {
    this.activeContext = ctx;
    const projectStore = await this.getStore(ctx);
    const loaded = await projectStore.load();
    if (Object.keys(loaded.scheduler.activeLeases).length > 0) {
      await projectStore.transact(
        (draft) => recoverInterruptedExecutions(draft, new Date().toISOString()),
        { actor: "extension:session-recovery" },
      );
    }
    const legacyBranch = [...ctx.sessionManager.getBranch()];
    const importNow = new Date().toISOString();
    const legacySourceKey = ctx.sessionManager.getSessionId() || "unknown-session";
    const preview = importLegacyBranch(await projectStore.load(), legacyBranch, importNow, legacySourceKey);
    if (preview.applied) {
      const imported = await projectStore.transact(
        (draft) => importLegacyBranch(draft, legacyBranch, importNow, legacySourceKey).state,
        { actor: "extension:legacy-import" },
      );
      ctx.ui.notify(
        `Imported legacy state: ${preview.goalIds.length} goal(s), ${preview.todoIds.length} todo(s) at revision ${imported.revision}.`,
        preview.warnings.length > 0 ? "warning" : "info",
      );
    }
    await this.getAdapter(ctx);
    this.unsubscribe?.();
    this.unsubscribe = projectStore.subscribe((state) => {
      this.updateUiState(ctx, state);
      void this.dispatchReady(ctx);
    });
    this.updateUiState(ctx, await projectStore.load());
    void this.dispatchReady(ctx, true);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget("devflow-tree", (tui, theme) => {
        this.widgetTui = tui;
        return {
          render: (width: number) =>
            this.currentState
              ? renderDynamicWidget(this.currentState, width, theme, this.widgetExpandedIds, this.widgetView.expanded)
              : [],
          invalidate() {},
        };
      });
    }
  }

  async shutdown(ctx: ExtensionContext): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const projectStore = await this.getStore(ctx);
    let state = await projectStore.load();
    if (this.workflowAdapter) {
      for (const binding of Object.values(state.workflowRuns)) {
        if (binding.status === "running") await this.workflowAdapter.pause(binding.id);
      }
      state = await projectStore.load();
    }
    if (Object.keys(state.scheduler.activeLeases).length > 0) {
      await projectStore.transact(
        (draft) => recoverInterruptedExecutions(draft, new Date().toISOString()),
        { actor: "extension:session-shutdown" },
      );
    }
    this.widgetTui = undefined;
    this.currentState = undefined;
    if (this.activeContext?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()) {
      this.activeContext = undefined;
    }
    ctx.ui.setWidget("devflow-tree", undefined);
  }

  async refreshUi(ctx: ExtensionContext): Promise<void> {
    this.updateUiState(ctx, await (await this.getStore(ctx)).refresh());
  }

  onModelSelect(event: { model: { provider: string; id: string } }): void {
    this.mainModel = `${event.model.provider}/${event.model.id}`;
    this.workflowManager?.setMainModel(this.mainModel);
  }

  async beforeAgentStart(
    event: { prompt: string },
    ctx: ExtensionContext,
  ): Promise<{ message: { customType: string; content: string; display: boolean } } | undefined> {
    const projectStore = await this.getStore(ctx);
    const continuation = event.prompt.match(/\[devflow-continuation:([^\]]+)\]/)?.[1];
    let staleContinuation = "";
    if (continuation) {
      const current = await projectStore.load();
      const preview = applyContinuationClaim(current, continuation);
      if (preview.outcome === "claimed" || preview.outcome === "expired") {
        await projectStore.transact(
          (draft) => applyContinuationClaim(draft, continuation).state,
          { actor: "extension:continuation" },
        );
      }
      if (preview.stale) {
        staleContinuation = "\nThis continuation is stale. Do not execute the Todo named in the prompt; re-evaluate current Ready work instead.";
      }
    }
    const state = await projectStore.load();
    if (Object.keys(state.goals).length === 0) return undefined;
    const grill = selectPendingGrill(state);
    const grillInstruction = grill
      ? `\nAsk exactly one blocking question: ${grill.question}${grill.recommendedAnswer ? ` Recommended answer: ${grill.recommendedAnswer}` : ""}`
      : "";
    return {
      message: {
        customType: "devflow-state",
        content: `${formatStatus(state)}\nContinue Ready work even when an unrelated todo is blocked.${staleContinuation}${grillInstruction}`,
        display: false,
      },
    };
  }

  async onToolExecutionEnd(
    event: { toolName: string; toolCallId: string; isError: boolean },
    ctx: ExtensionContext,
  ): Promise<void> {
    if (event.toolName.startsWith("devflow_")) return;
    const projectStore = await this.getStore(ctx);
    const state = await projectStore.load();
    const mainLeases = Object.values(state.scheduler.activeLeases).filter((lease) => lease.mode === "main");
    if (mainLeases.length !== 1) return;
    const lease = mainLeases[0]!;
    const now = new Date().toISOString();
    await projectStore.transact((draft) => addEvidence(draft, {
      id: `tool:${event.toolCallId}`,
      kind: event.toolName === "bash" ? "command" : "user",
      summary: `${event.toolName} ${event.isError ? "failed" : "succeeded"}`,
      locator: `tool-call:${event.toolCallId}`,
      goalId: lease.goalId,
      todoId: lease.todoId,
      observedAt: now,
      valid: !event.isError,
    }), { actor: "extension:evidence" });
  }

  toggleWidget(): void {
    toggleWidgetView(this.widgetView);
    this.widgetTui?.requestRender(true);
  }

  async openPanel(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      const state = await (await this.getStore(ctx)).load();
      ctx.ui.notify(formatStatus(state), "info");
      return;
    }
    while (true) {
      const projectStore = await this.getStore(ctx);
      const state = await projectStore.load();
      const result = await ctx.ui.custom<DevflowPanelResult>((tui, theme, _keybindings, done) =>
        new DevflowPanel(state, theme, () => tui.requestRender(), done, this.widgetExpandedIds));
      this.widgetTui?.requestRender(true);
      if (!result || result.type === "close") return;
      if (result.type === "toggle-pause") {
        await projectStore.transact(
          (draft) => setSchedulerPaused(draft, !draft.scheduler.paused),
          { actor: "user:/devflow" },
        );
      } else if (result.type === "retry") {
        const strategy = await ctx.ui.input("Retry strategy", "Describe a new recovery strategy");
        if (strategy?.trim()) {
          await projectStore.transact(
            (draft) => retryTodo(draft, result.todoId, strategy.trim(), new Date().toISOString()),
            { actor: "user:/devflow" },
          );
        }
      }
    }
  }

  async openModelSelector(ctx: ExtensionCommandContext): Promise<void> {
    await openDevflowModelSelector(this.pi, ctx, (config) => this.applyModelPolicy(modelPolicyFromTierConfig(config)));
  }

  async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const action = args.trim();
    if (!action) {
      await this.openPanel(ctx);
      return;
    }
    const projectStore = await this.getStore(ctx);
    const state = await projectStore.load();
    if (action === "status") {
      ctx.ui.notify(formatStatus(state), "info");
      return;
    }
    if (action === "pause" || action === "resume") {
      const paused = action === "pause";
      await projectStore.transact((draft) => setSchedulerPaused(draft, paused), { actor: `user:/devflow-${action}` });
      ctx.ui.notify(`Devflow scheduler ${paused ? "paused" : "resumed"}.`, "info");
      return;
    }
    if (action === "models") {
      await this.openModelSelector(ctx);
      return;
    }
    if (action === "doctor") {
      validateProject(state);
      const legacy = this.pi.getAllTools().filter((tool) =>
        ["todo", "create_goal", "get_goal", "update_goal"].includes(tool.name));
      const homeRoot = state.project.root === homedir() || state.project.root === `${homedir()}/`;
      const warnings = [
        legacy.length > 0 ? `Legacy tools detected: ${legacy.map((tool) => tool.name).join(", ")}.` : "",
        homeRoot ? `Project root is your home directory (${state.project.root}). Open Pi inside a Git repo so workspaces stay isolated.` : "",
      ].filter(Boolean);
      const warningText = warnings.length > 0 ? ` ${warnings.join(" ")}` : "";
      ctx.ui.notify(
        `Devflow OK · root ${state.project.root} · rev ${state.revision} · journal ${projectStore.journalPath}.${warningText}`,
        warnings.length > 0 ? "warning" : "info",
      );
      return;
    }
    ctx.ui.notify("Usage: /devflow [status|doctor|models|pause|resume]", "error");
  }
}
