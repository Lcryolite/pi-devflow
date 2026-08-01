import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowManager } from "@quintinshaw/pi-dynamic-workflows";

import { applyContinuationClaim } from "../domain/continuation.js";
import { validateProject } from "../domain/invariants.js";
import { abandonStaleSessionWorkflows, recoverInterruptedExecutions } from "../domain/scheduler.js";
import { addEvidence } from "../domain/state.js";
import { retryTodo } from "../domain/transitions.js";
import type { ExecutionScope, ProjectState } from "../domain/types.js";
import { selectPendingGrill } from "../grill.js";
import { importLegacyBranch } from "../import/legacy.js";
import { formatStatus } from "../status.js";
import { resolveDevflowProjectRoot } from "../store/project-root.js";
import { ProjectStore } from "../store/project-store.js";
import { openDevflowModelSelector } from "../ui/model-selector.js";
import { DevflowPanel, type DevflowPanelResult } from "../ui/panel.js";
import { hasWidgetActivity, renderDynamicWidget, syncWidgetExpandedIds, syncWidgetView, toggleWidgetView } from "../ui/widget.js";
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
  private scope: ExecutionScope | undefined;
  private widgetTimer: ReturnType<typeof setInterval> | undefined;
  private readonly ephemeralSessionId = `ephemeral:${randomUUID()}`;

  constructor(private readonly pi: ExtensionAPI) {}

  private sessionId(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId() || this.ephemeralSessionId;
  }

  getScope(ctx: ExtensionContext): ExecutionScope {
    const sessionId = this.sessionId(ctx);
    if (!this.scope || this.scope.sessionId !== sessionId) this.scope = { sessionId, runtimeId: randomUUID() };
    return this.scope;
  }

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
    const scope = this.getScope(ctx);
    const managerKey = `${root}:${scope.sessionId}:${scope.runtimeId}`;
    const projectStore = await this.getStore(ctx);
    this.mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "inherit";
    if (!this.workflowManager || this.workflowManagerCwd !== managerKey) {
      this.workflowManager = new WorkflowManager({ cwd: root });
      this.workflowManagerCwd = managerKey;
      this.applyModelPolicy(loadDevflowModelPolicy());
      this.workflowAdapter = new DevflowWorkflowAdapter(
        this.workflowManager,
        projectStore,
        () => this.mainModel,
        this.modelPolicy,
        () => {
          if (this.activeContext) void this.dispatchReady(this.activeContext, true);
        },
        scope,
      );
    }
    this.workflowManager.setMainModel(this.mainModel === "inherit" ? undefined : this.mainModel);
    this.workflowManager.setModelRegistry(ctx.modelRegistry);
    this.workflowManager.setSessionId(this.sessionId(ctx));
    return this.workflowAdapter!;
  }

  async dispatchReady(ctx: ExtensionContext, allowMain = false): Promise<void> {
    await this.gate.run(ctx, allowMain, (passCtx, passMain) =>
      runDispatchPass(
        {
          pi: this.pi,
          getStore: (c) => this.getStore(c),
          getAdapter: (c) => this.getAdapter(c),
          getScope: (c) => this.getScope(c),
        },
        passCtx,
        passMain,
      ));
  }

  private updateUiState(ctx: ExtensionContext, state: ProjectState): void {
    const sessionId = this.getScope(ctx).sessionId;
    this.currentState = state;
    syncWidgetExpandedIds(state, this.widgetExpandedIds, this.widgetGoalStatuses, sessionId);
    syncWidgetView(state, this.widgetView, sessionId);
    const active = Object.values(state.goals).filter((goal) => goal.ownerSessionId === sessionId && (goal.status === "active" || goal.status === "blocked")).length;
    ctx.ui.setStatus("devflow", active > 0 ? `devflow:${active}` : undefined);
    if (hasWidgetActivity(state, sessionId) && !this.widgetTimer) {
      this.widgetTimer = setInterval(() => this.widgetTui?.requestRender(), 1_000);
      this.widgetTimer.unref?.();
    } else if (!hasWidgetActivity(state, sessionId) && this.widgetTimer) {
      clearInterval(this.widgetTimer);
      this.widgetTimer = undefined;
    }
    this.widgetTui?.requestRender(true);
  }

  async bindSession(ctx: ExtensionContext): Promise<void> {
    this.activeContext = ctx;
    this.scope = { sessionId: this.sessionId(ctx), runtimeId: randomUUID() };
    const projectStore = await this.getStore(ctx);
    await projectStore.load();
    const legacyBranch = [...ctx.sessionManager.getBranch()];
    const importNow = new Date().toISOString();
    const legacySourceKey = this.sessionId(ctx);
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
              ? renderDynamicWidget(this.currentState, width, theme, this.widgetExpandedIds, this.widgetView.expanded, this.getScope(ctx).sessionId)
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
    const scope = this.getScope(ctx);
    if (this.workflowAdapter) {
      for (const binding of Object.values(state.workflowRuns)) {
        if (binding.status === "running" && binding.ownerSessionId === scope.sessionId && binding.ownerRuntimeId === scope.runtimeId) {
          await this.workflowAdapter.pause(binding.id);
        }
      }
      state = await projectStore.load();
    }
    await projectStore.transact(
      (draft) => recoverInterruptedExecutions(draft, scope, new Date().toISOString()),
      { actor: "extension:session-shutdown" },
    );
    this.widgetTui = undefined;
    if (this.widgetTimer) clearInterval(this.widgetTimer);
    this.widgetTimer = undefined;
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
      const record = current.scheduler.continuationKeys[continuation];
      const scope = this.getScope(ctx);
      if (!record || record.ownerSessionId !== scope.sessionId || record.ownerRuntimeId !== scope.runtimeId) {
        staleContinuation = "\nThis continuation belongs to another or expired Pi runtime. Do not execute it.";
      } else {
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
    }
    const state = await projectStore.load();
    if (!staleContinuation && !Object.values(state.goals).some((goal) => goal.ownerSessionId === this.getScope(ctx).sessionId)) return undefined;
    const grill = selectPendingGrill(state, this.getScope(ctx).sessionId);
    const grillInstruction = grill
      ? `\nAsk exactly one blocking question: ${grill.question}${grill.recommendedAnswer ? ` Recommended answer: ${grill.recommendedAnswer}` : ""}`
      : "";
    return {
      message: {
        customType: "devflow-state",
        content: `${formatStatus(state, this.getScope(ctx).sessionId)}\nContinue Ready work even when an unrelated todo is blocked.${staleContinuation}${grillInstruction}`,
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
    const scope = this.getScope(ctx);
    const mainLeases = Object.values(state.scheduler.activeLeases).filter((lease) =>
      lease.mode === "main" && lease.ownerSessionId === scope.sessionId && lease.ownerRuntimeId === scope.runtimeId);
    if (mainLeases.length !== 1) return;
    const lease = mainLeases[0]!;
    const now = new Date().toISOString();
    await projectStore.transact((draft) => addEvidence(draft, {
      id: `tool:${event.toolCallId}`,
      ownerSessionId: scope.sessionId,
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
      ctx.ui.notify(formatStatus(state, this.getScope(ctx).sessionId), "info");
      return;
    }
    while (true) {
      const projectStore = await this.getStore(ctx);
      const state = await projectStore.load();
      const result = await ctx.ui.custom<DevflowPanelResult>((tui, theme, _keybindings, done) =>
        new DevflowPanel(state, theme, () => tui.requestRender(), done, this.widgetExpandedIds, this.getScope(ctx).sessionId));
      this.widgetTui?.requestRender(true);
      if (!result || result.type === "close") return;
      if (result.type === "toggle-pause") {
        await projectStore.transact(
          (draft) => {
            const next = structuredClone(draft);
            const sessionId = this.getScope(ctx).sessionId;
            next.scheduler.sessionPaused[sessionId] = !next.scheduler.sessionPaused[sessionId];
            return next;
          },
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
      ctx.ui.notify(formatStatus(state, this.getScope(ctx).sessionId), "info");
      return;
    }
    if (action === "project") {
      ctx.ui.notify(formatStatus(state), "info");
      return;
    }
    if (action === "recover") {
      const scope = this.getScope(ctx);
      const sessionId = scope.sessionId;
      const recovered = await projectStore.transact((draft) => {
        let next = draft;
        const runtimeIds = [...new Set(Object.values(draft.scheduler.activeLeases)
          .filter((lease) => lease.ownerSessionId === sessionId && lease.ownerRuntimeId !== scope.runtimeId)
          .map((lease) => lease.ownerRuntimeId))];
        for (const runtimeId of runtimeIds) {
          next = recoverInterruptedExecutions(next, { sessionId, runtimeId }, new Date().toISOString());
        }
        return abandonStaleSessionWorkflows(next, scope, new Date().toISOString());
      }, { actor: "user:/devflow-recover" });
      ctx.ui.notify(`Recovered stale work owned by this Pi session at revision ${recovered.revision}.`, "info");
      return;
    }
    if (action.startsWith("adopt ")) {
      const goalId = action.slice("adopt ".length).trim();
      const scope = this.getScope(ctx);
      let adoptedCount = 0;
      await projectStore.transact((draft) => {
        if (!draft.goals[goalId]) throw new Error(`Goal ${goalId} does not exist`);
        const adopted = new Set([goalId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const id of [...adopted]) {
            const goal = draft.goals[id]!;
            for (const dependencyId of goal.dependsOn) {
              if (!adopted.has(dependencyId)) { adopted.add(dependencyId); changed = true; }
            }
            const evidenceIds = new Set(goal.successCriteria.flatMap((criterion) => criterion.evidenceIds));
            for (const candidate of Object.values(draft.goals)) {
              if (candidate.dependsOn.some((dependencyId) => adopted.has(dependencyId)) && !adopted.has(candidate.id)) {
                adopted.add(candidate.id);
                changed = true;
              }
              if (candidate.successCriteria.some((criterion) => criterion.evidenceIds.some((id) => evidenceIds.has(id))) && !adopted.has(candidate.id)) {
                adopted.add(candidate.id);
                changed = true;
              }
            }
          }
        }
        for (const id of adopted) {
          const owner = draft.goals[id]?.ownerSessionId;
          if (owner !== "legacy-unowned" && owner !== scope.sessionId) throw new Error(`Connected Goal ${id} belongs to another Pi session`);
        }
        const next = structuredClone(draft);
        const todoIds = new Set(Object.values(next.todos).filter((todo) => adopted.has(todo.goalId)).map((todo) => todo.id));
        for (const id of adopted) next.goals[id]!.ownerSessionId = scope.sessionId;
        for (const goal of [...adopted].map((id) => next.goals[id]!)) {
          for (const evidenceId of goal.successCriteria.flatMap((criterion) => criterion.evidenceIds)) {
            const evidence = next.evidence[evidenceId];
            if (!evidence) continue;
            if (evidence.ownerSessionId !== "legacy-unowned" && evidence.ownerSessionId !== scope.sessionId) {
              throw new Error(`Evidence ${evidenceId} belongs to another Pi session`);
            }
            evidence.ownerSessionId = scope.sessionId;
          }
        }
        for (const binding of Object.values(next.workflowRuns)) {
          if (!todoIds.has(binding.todoId)) continue;
          if (["planned", "running", "paused"].includes(binding.status)) {
            const stoppedAt = new Date().toISOString();
            binding.status = "stopped";
            binding.endedAt = stoppedAt;
            const phaseIds = new Set(binding.phases.map((phase) => phase.todoId));
            for (const phase of binding.phases) {
              const phaseTodo = next.todos[phase.todoId];
              if (!phaseTodo) continue;
              if (phaseTodo.status !== "completed") phaseTodo.status = "cancelled";
              delete phaseTodo.parentId;
              phaseTodo.updatedAt = stoppedAt;
            }
            const parent = next.todos[binding.todoId];
            if (parent) {
              parent.childIds = parent.childIds.filter((id) => !phaseIds.has(id));
              delete parent.workflowRunId;
              parent.status = "blocked";
              parent.blocker = {
                kind: "workflow", reason: "Legacy Workflow was stopped during adoption",
                recommendedAnswer: "Retry with a fresh Workflow", sourceIds: [binding.upstreamRunId],
              };
              parent.updatedAt = stoppedAt;
            }
          }
          binding.ownerSessionId = scope.sessionId;
          binding.ownerRuntimeId = scope.runtimeId;
        }
        for (const [todoId, lease] of Object.entries(next.scheduler.activeLeases)) {
          if (adopted.has(lease.goalId)) delete next.scheduler.activeLeases[todoId];
        }
        for (const record of Object.values(next.scheduler.continuationKeys)) {
          if (todoIds.has(record.todoId) && record.status !== "claimed") record.status = "expired";
        }
        adoptedCount = adopted.size;
        return next;
      }, { actor: "user:/devflow-adopt" });
      ctx.ui.notify(`Adopted ${adoptedCount} connected Goal(s) into this Pi session.`, "info");
      return;
    }
    if (action === "pause" || action === "resume") {
      const paused = action === "pause";
      const sessionId = this.getScope(ctx).sessionId;
      await projectStore.transact((draft) => {
        const next = structuredClone(draft);
        next.scheduler.sessionPaused[sessionId] = paused;
        return next;
      }, { actor: `user:/devflow-${action}` });
      ctx.ui.notify(`Devflow scheduler ${paused ? "paused" : "resumed"} for this Pi session.`, "info");
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
      const unowned = Object.values(state.goals).filter((goal) => goal.ownerSessionId === "legacy-unowned").length;
      const warnings = [
        legacy.length > 0 ? `Legacy tools detected: ${legacy.map((tool) => tool.name).join(", ")}.` : "",
        homeRoot ? `Project root is your home directory (${state.project.root}). Open Pi inside a Git repo so workspaces stay isolated.` : "",
        unowned > 0 ? `${unowned} legacy Goal(s) are quarantined and will not run until adopted.` : "",
      ].filter(Boolean);
      const warningText = warnings.length > 0 ? ` ${warnings.join(" ")}` : "";
      ctx.ui.notify(
        `Devflow OK · root ${state.project.root} · rev ${state.revision} · journal ${projectStore.journalPath}.${warningText}`,
        warnings.length > 0 ? "warning" : "info",
      );
      return;
    }
    ctx.ui.notify("Usage: /devflow [status|project|doctor|models|pause|resume|recover|adopt <goal-id>]", "error");
  }
}
