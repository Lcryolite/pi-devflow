import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowManager } from "@quintinshaw/pi-dynamic-workflows";

import { auditGoal } from "./domain/audit.js";
import { validateProject } from "./domain/invariants.js";
import { applyNormalizationProposal, type NormalizationProposal } from "./domain/normalization.js";
import { applySchedulePlan, markContinuation, planSchedule, recoverInterruptedExecutions } from "./domain/scheduler.js";
import {
  addCriterionEvidence,
  addEvidence,
  addGoal,
  addTodo,
  completeGoal,
  setTodoStatus,
} from "./domain/state.js";
import {
  blockTodo,
  cancelGoal,
  markGrillAsked,
  moveTodo,
  recordTodoFailure,
  retryTodo,
  setSchedulerPaused,
  updateGoal,
  updateTodo,
} from "./domain/transitions.js";
import type { Evidence, ProjectState, SuccessCriterion, TodoStatus } from "./domain/types.js";
import { selectPendingGrill } from "./grill.js";
import { importLegacyBranch } from "./import/legacy.js";
import { registerDevflowWorkflowTool } from "./pi/workflow-tool.js";
import { formatStatus } from "./status.js";
import { ProjectStore } from "./store/project-store.js";
import { DevflowWorkflowAdapter } from "./workflow/adapter.js";
import { describeModelPolicy, loadDevflowModelPolicy, modelPolicyFromTierConfig } from "./workflow/policy.js";
import { openDevflowModelSelector } from "./ui/model-selector.js";
import { DevflowPanel, type DevflowPanelResult } from "./ui/panel.js";
import { renderCompactWidget, syncWidgetExpandedIds } from "./ui/widget.js";

const GoalAction = StringEnum(["create", "list", "get", "update", "audit", "complete", "cancel"] as const);
const TodoAction = StringEnum(["create", "list", "get", "update", "move", "retry", "cancel"] as const);
const TodoStatusSchema = StringEnum(["pending", "ready", "in_progress", "blocked", "completed", "cancelled"] as const);
const ExecutionSchema = StringEnum(["main", "workflow", "undecided"] as const);
const BlockerKindSchema = StringEnum(["decision", "permission", "resource", "tool", "validation", "workflow"] as const);
const EvidenceKindSchema = StringEnum(["test", "file", "command", "review", "workflow", "user", "legacy"] as const);
const ResourceModeSchema = StringEnum(["read", "write", "exclusive"] as const);
const WriteScopeSchema = StringEnum(["none", "known-disjoint", "shared", "unknown"] as const);
const ModelRoleSchema = StringEnum(["fanout", "work", "judge"] as const);

const GoalParams = Type.Object({
  action: GoalAction,
  id: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  objective: Type.Optional(Type.String()),
  successCriteria: Type.Optional(Type.Array(Type.String())),
  constraints: Type.Optional(Type.Array(Type.String())),
  nonGoals: Type.Optional(Type.Array(Type.String())),
  evidenceRequirements: Type.Optional(Type.Array(Type.String())),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  criterionId: Type.Optional(Type.String()),
  evidenceId: Type.Optional(Type.String()),
  evidenceKind: Type.Optional(EvidenceKindSchema),
  evidenceSummary: Type.Optional(Type.String()),
  evidenceLocator: Type.Optional(Type.String()),
  evidenceValid: Type.Optional(Type.Boolean()),
});

const TodoParams = Type.Object({
  action: TodoAction,
  id: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.String()),
  makeRoot: Type.Optional(Type.Boolean()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  execution: Type.Optional(ExecutionSchema),
  status: Type.Optional(TodoStatusSchema),
  blockerKind: Type.Optional(BlockerKindSchema),
  blockerReason: Type.Optional(Type.String()),
  unlockCondition: Type.Optional(Type.String()),
  recommendedAnswer: Type.Optional(Type.String()),
  strategy: Type.Optional(Type.String()),
  evidenceIds: Type.Optional(Type.Array(Type.String())),
  resourceClaims: Type.Optional(Type.Array(Type.Object({ key: Type.String(), mode: ResourceModeSchema }))),
  independentUnits: Type.Optional(Type.Integer({ minimum: 0 })),
  hasSequentialDependency: Type.Optional(Type.Boolean()),
  writeScope: Type.Optional(WriteScopeSchema),
  mergeableResults: Type.Optional(Type.Boolean()),
  estimatedUnits: Type.Optional(Type.Integer({ minimum: 0 })),
  workflowPlan: Type.Optional(Type.Object({
    name: Type.String(),
    description: Type.String(),
    phases: Type.Array(Type.Object({
      title: Type.String(),
      role: ModelRoleSchema,
      prompts: Type.Array(Type.String()),
      escalateJudge: Type.Optional(Type.Boolean()),
    })),
  })),
});

const NormalizeAction = StringEnum(["create_goal", "merge_as_todo", "ask"] as const);
const NormalizeParams = Type.Object({
  action: NormalizeAction,
  proposalId: Type.String(),
  sourceRequest: Type.Optional(Type.String()),
  rationale: Type.Optional(Type.String()),
  targetGoalId: Type.Optional(Type.String()),
  goalId: Type.Optional(Type.String()),
  todoId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  objective: Type.Optional(Type.String()),
  successCriteria: Type.Optional(Type.Array(Type.String())),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  question: Type.Optional(Type.String()),
  recommendedAnswer: Type.Optional(Type.String()),
  missingDecision: Type.Optional(Type.String()),
});

function requireText(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function textResult(text: string, state: ProjectState) {
  return {
    content: [{ type: "text" as const, text }],
    details: { projectId: state.project.id, revision: state.revision },
  };
}

function listGoals(state: ProjectState): string {
  const goals = Object.values(state.goals);
  if (goals.length === 0) return "No goals.";
  return goals.map((goal) => `${goal.status === "completed" ? "✓" : goal.status === "blocked" ? "!" : "●"} ${goal.id} ${goal.title}`).join("\n");
}

function listTodos(state: ProjectState, goalId?: string): string {
  const todos = Object.values(state.todos).filter((todo) => !goalId || todo.goalId === goalId);
  if (todos.length === 0) return "No todos.";
  return todos.map((todo) => `${todo.status.padEnd(11)} #${todo.id} ${todo.title}`).join("\n");
}

export default function devflowExtension(pi: ExtensionAPI) {
  let store: ProjectStore | undefined;
  let storeCwd: string | undefined;
  let currentState: ProjectState | undefined;
  let unsubscribe: (() => void) | undefined;
  let widgetTui: { requestRender(force?: boolean): void } | undefined;
  let workflowManager: WorkflowManager | undefined;
  let workflowManagerCwd: string | undefined;
  let workflowAdapter: DevflowWorkflowAdapter | undefined;
  let mainModel = "inherit";
  const modelPolicy = loadDevflowModelPolicy();
  const widgetExpandedIds = new Set<string>();
  const widgetGoalStatuses = new Map<string, ProjectState["goals"][string]["status"]>();
  let activeContext: ExtensionContext | undefined;
  let dispatchReady: (ctx: ExtensionContext, allowMain?: boolean) => Promise<void> = async () => {};

  const applyModelPolicy = (next: ReturnType<typeof loadDevflowModelPolicy>): void => {
    for (const key of Object.keys(modelPolicy) as Array<keyof typeof modelPolicy>) delete modelPolicy[key];
    Object.assign(modelPolicy, next);
  };


  const getStore = async (ctx: ExtensionContext): Promise<ProjectStore> => {
    const cwd = resolve(ctx.cwd);
    if (!store || storeCwd !== cwd) {
      unsubscribe?.();
      widgetExpandedIds.clear();
      widgetGoalStatuses.clear();
      store = await ProjectStore.open(cwd);
      storeCwd = cwd;
    }
    return store;
  };

  const getWorkflowAdapter = async (ctx: ExtensionContext): Promise<DevflowWorkflowAdapter> => {
    const cwd = resolve(ctx.cwd);
    const projectStore = await getStore(ctx);
    mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "inherit";
    if (!workflowManager || workflowManagerCwd !== cwd) {
      workflowManager = new WorkflowManager({ cwd });
      workflowManagerCwd = cwd;
      applyModelPolicy(loadDevflowModelPolicy());
      workflowAdapter = new DevflowWorkflowAdapter(workflowManager, projectStore, () => mainModel, modelPolicy, () => {
        if (activeContext) void dispatchReady(activeContext, true);
      });
    }
    workflowManager.setMainModel(mainModel === "inherit" ? undefined : mainModel);
    workflowManager.setModelRegistry(ctx.modelRegistry);
    workflowManager.setSessionId(ctx.sessionManager.getSessionId());
    return workflowAdapter!;
  };

  const updateUiState = (ctx: ExtensionContext, state: ProjectState): void => {
    currentState = state;
    syncWidgetExpandedIds(state, widgetExpandedIds, widgetGoalStatuses);
    const active = Object.values(state.goals).filter((goal) => goal.status === "active" || goal.status === "blocked").length;
    ctx.ui.setStatus("devflow", active > 0 ? `devflow:${active}` : undefined);
    widgetTui?.requestRender(true);
  };

  let dispatching = false;
  let dispatchPending = false;
  let pendingAllowsMain = false;
  let pendingContext: ExtensionContext | undefined;

  const dispatchPass = async (ctx: ExtensionContext, allowMain: boolean): Promise<void> => {
    const projectStore = await getStore(ctx);
    const schedule = (state: ProjectState, now: string) => {
      const plan = planSchedule(state, now);
      return allowMain ? plan : { ...plan, starts: plan.starts.filter((start) => start.mode === "workflow") };
    };
    const preview = schedule(await projectStore.load(), new Date().toISOString());
    const now = new Date().toISOString();
    const scheduled = preview.starts.length > 0
      ? await projectStore.transact(
          (draft) => applySchedulePlan(draft, schedule(draft, now), now),
          { actor: "extension:scheduler" },
        )
      : await projectStore.load();
    const reserved = Object.values(scheduled.scheduler.continuationKeys).filter((record) => {
      const todo = scheduled.todos[record.todoId];
      return record.status === "reserved" && (allowMain || todo?.execution === "workflow");
    });
    for (const record of reserved) {
      const todo = scheduled.todos[record.todoId];
      if (!todo || todo.status !== "in_progress" || !scheduled.scheduler.activeLeases[todo.id]) {
        await projectStore.transact((draft) => markContinuation(draft, record.key, "expired"), { actor: "extension:continuation" });
        continue;
      }
      if (todo.execution === "workflow") {
        if (todo.workflowRunId) {
          await projectStore.transact((draft) => markContinuation(draft, record.key, "sent"), { actor: "extension:continuation" });
          continue;
        }
        if (!todo.workflowPlan) {
          await projectStore.transact((draft) => {
            const blocked = blockTodo(draft, todo.id, {
              kind: "decision",
              reason: "Workflow execution was selected but no workflow plan is attached",
              recommendedAnswer: "Attach a workflow plan or switch execution to main",
              sourceIds: [],
            }, new Date().toISOString());
            return markContinuation(blocked, record.key, "expired");
          }, { actor: "extension:scheduler" });
          continue;
        }
        try {
          await (await getWorkflowAdapter(ctx)).start(todo.id, todo.workflowPlan);
          await projectStore.transact((draft) => markContinuation(draft, record.key, "sent"), { actor: "extension:continuation" });
        } catch (error) {
          await projectStore.transact((draft) => {
            const blocked = blockTodo(draft, todo.id, {
              kind: "workflow",
              reason: error instanceof Error ? error.message : String(error),
              sourceIds: [],
            }, new Date().toISOString());
            return markContinuation(blocked, record.key, "expired");
          }, { actor: "extension:workflow" });
        }
      } else {
        await projectStore.transact((draft) => markContinuation(draft, record.key, "sent"), { actor: "extension:continuation" });
        pi.sendMessage({
          customType: "devflow-continuation",
          content: `[devflow-continuation:${record.key}] Continue Todo ${todo.id}: ${todo.title}. Update devflow state and evidence as work progresses. Do not bypass Pi permissions or dangerous-operation confirmations.`,
          display: true,
        }, { deliverAs: "followUp", triggerTurn: true });
      }
    }
    if (reserved.length > 0) return;
    const state = await projectStore.load();
    const grill = selectPendingGrill(state);
    if (!grill) return;
    await projectStore.transact((draft) => markGrillAsked(draft, grill.key), { actor: "extension:grill" });
    pi.sendMessage({
      customType: "devflow-grill",
      content: `Ask the user exactly one question to unblock Todo ${grill.todoId}: ${grill.question}${grill.recommendedAnswer ? ` Recommended answer: ${grill.recommendedAnswer}` : ""}`,
      display: true,
    }, { deliverAs: "followUp", triggerTurn: true });
  };

  dispatchReady = async (ctx: ExtensionContext, allowMain = false): Promise<void> => {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    if (dispatching) {
      dispatchPending = true;
      pendingAllowsMain ||= allowMain;
      pendingContext = ctx;
      return;
    }
    dispatching = true;
    let passAllowsMain = allowMain;
    let passContext = ctx;
    try {
      do {
        dispatchPending = false;
        await dispatchPass(passContext, passAllowsMain);
        passAllowsMain = pendingAllowsMain;
        passContext = pendingContext ?? passContext;
        pendingAllowsMain = false;
        pendingContext = undefined;
      } while (dispatchPending);
    } finally {
      dispatching = false;
    }
  };

  const bindSession = async (ctx: ExtensionContext): Promise<void> => {
    activeContext = ctx;
    const projectStore = await getStore(ctx);
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
      ctx.ui.notify(`Imported legacy state: ${preview.goalIds.length} goal(s), ${preview.todoIds.length} todo(s) at revision ${imported.revision}.`, preview.warnings.length > 0 ? "warning" : "info");
    }
    await getWorkflowAdapter(ctx);
    unsubscribe?.();
    unsubscribe = projectStore.subscribe((state) => {
      updateUiState(ctx, state);
      void dispatchReady(ctx);
    });
    updateUiState(ctx, await projectStore.load());
    void dispatchReady(ctx, true);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget("devflow-tree", (tui, theme) => {
        widgetTui = tui;
        return {
          render: (width: number) => currentState ? renderCompactWidget(currentState, width, theme, widgetExpandedIds) : [],
          invalidate() {},
        };
      });
    }
  };

  const openPanel = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      const state = await (await getStore(ctx)).load();
      ctx.ui.notify(formatStatus(state), "info");
      return;
    }
    while (true) {
      const projectStore = await getStore(ctx);
      const state = await projectStore.load();
      const result = await ctx.ui.custom<DevflowPanelResult>((tui, theme, _keybindings, done) =>
        new DevflowPanel(state, theme, () => tui.requestRender(), done, widgetExpandedIds));
      widgetTui?.requestRender(true);
      if (!result || result.type === "close") return;
      if (result.type === "toggle-pause") {
        await projectStore.transact((draft) => setSchedulerPaused(draft, !draft.scheduler.paused), { actor: "user:/devflow" });
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
  };

  pi.on("session_start", async (_event, ctx) => bindSession(ctx));
  pi.on("session_tree", async (_event, ctx) => updateUiState(ctx, await (await getStore(ctx)).refresh()));
  pi.on("session_compact", async (_event, ctx) => updateUiState(ctx, await (await getStore(ctx)).refresh()));
  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribe?.();
    unsubscribe = undefined;
    const projectStore = await getStore(ctx);
    let state = await projectStore.load();
    if (workflowAdapter) {
      for (const binding of Object.values(state.workflowRuns)) {
        if (binding.status === "running") await workflowAdapter.pause(binding.id);
      }
      state = await projectStore.load();
    }
    if (Object.keys(state.scheduler.activeLeases).length > 0) {
      await projectStore.transact(
        (draft) => recoverInterruptedExecutions(draft, new Date().toISOString()),
        { actor: "extension:session-shutdown" },
      );
    }
    widgetTui = undefined;
    currentState = undefined;
    if (activeContext?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()) activeContext = undefined;
    ctx.ui.setWidget("devflow-tree", undefined);
  });
  pi.on("model_select", async (event) => {
    mainModel = `${event.model.provider}/${event.model.id}`;
    workflowManager?.setMainModel(mainModel);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const projectStore = await getStore(ctx);
    const continuation = event.prompt.match(/\[devflow-continuation:([^\]]+)\]/)?.[1];
    let staleContinuation = "";
    if (continuation) {
      const current = await projectStore.load();
      const record = current.scheduler.continuationKeys[continuation];
      const todo = record ? current.todos[record.todoId] : undefined;
      if (record?.status === "sent" && todo?.status === "in_progress" && current.scheduler.activeLeases[todo.id]) {
        await projectStore.transact((draft) => markContinuation(draft, continuation, "claimed"), { actor: "extension:continuation" });
      } else {
        if (record && record.status !== "expired") {
          await projectStore.transact((draft) => markContinuation(draft, continuation, "expired"), { actor: "extension:continuation" });
        }
        staleContinuation = "\nThis continuation is stale. Do not execute the Todo named in the prompt; re-evaluate current Ready work instead.";
      }
    }
    const state = await projectStore.load();
    if (Object.keys(state.goals).length === 0) return;
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
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await dispatchReady(ctx, true);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName.startsWith("devflow_")) return;
    const projectStore = await getStore(ctx);
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
  });

  pi.registerShortcut("ctrl+shift+d", {
    description: "Open pi-devflow",
    handler: async (ctx) => openPanel(ctx),
  });


  registerDevflowWorkflowTool(pi, {
    getAdapter: getWorkflowAdapter,
    getStore,
  });

  pi.registerTool({
    name: "devflow_normalize",
    label: "Devflow Normalize",
    description: "Normalize a user request into a new independent Goal, merge it into an existing Goal as a Todo, or ask one consequential clarification. Use merge_as_todo when the request has no independent completion value.",
    promptSnippet: "Normalize requests before creating durable Goal/Todo state",
    parameters: NormalizeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectStore = await getStore(ctx);
      if (params.action === "ask") {
        const state = await projectStore.load();
        const proposal: NormalizationProposal = {
          id: params.proposalId,
          action: "ask",
          question: requireText(params.question, "question"),
          recommendedAnswer: requireText(params.recommendedAnswer, "recommendedAnswer"),
          missingDecision: requireText(params.missingDecision, "missingDecision"),
        };
        applyNormalizationProposal(state, proposal, new Date().toISOString());
        return textResult(`${proposal.question}\nRecommended answer: ${proposal.recommendedAnswer}`, state);
      }
      const sourceRequest = requireText(params.sourceRequest, "sourceRequest");
      const rationale = requireText(params.rationale, "rationale");
      const proposal: NormalizationProposal = params.action === "create_goal"
        ? {
            id: params.proposalId,
            action: "create_goal",
            rationale,
            sourceRequest,
            goal: {
              id: params.goalId?.trim() || randomUUID(),
              title: requireText(params.title, "title"),
              objective: requireText(params.objective, "objective"),
              successCriteria: (params.successCriteria ?? []).map((text, index) => ({
                id: `${params.proposalId}:criterion:${index + 1}`, text, required: true, evidenceIds: [],
              })),
              ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
            },
          }
        : {
            id: params.proposalId,
            action: "merge_as_todo",
            rationale,
            sourceRequest,
            targetGoalId: requireText(params.targetGoalId, "targetGoalId"),
            todo: {
              id: params.todoId?.trim() || randomUUID(),
              title: requireText(params.title, "title"),
              ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
            },
          };
      const next = await projectStore.transact(
        (state) => applyNormalizationProposal(state, proposal, new Date().toISOString()),
        { actor: "tool:devflow_normalize" },
      );
      return textResult(`Normalization ${proposal.action} applied: ${proposal.rationale}`, next);
    },
  });

  pi.registerTool({
    name: "devflow_goal",
    label: "Devflow Goal",
    description: "Create and manage project-scoped completion contracts with success criteria and evidence.",
    promptSnippet: "Manage durable project goals and their completion evidence",
    parameters: GoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectStore = await getStore(ctx);
      if (params.action === "list") {
        const state = await projectStore.load();
        return textResult(listGoals(state), state);
      }
      if (params.action === "get") {
        const state = await projectStore.load();
        const goal = state.goals[requireText(params.id, "id")];
        if (!goal) throw new Error(`Goal ${params.id} does not exist`);
        return textResult(JSON.stringify(goal, null, 2), state);
      }
      if (params.action === "audit") {
        const state = await projectStore.load();
        return textResult(JSON.stringify(auditGoal(state, requireText(params.id, "id")), null, 2), state);
      }
      if (params.action === "cancel") {
        const state = await projectStore.load();
        const goalId = requireText(params.id, "id");
        const todoIds = new Set(Object.values(state.todos).filter((todo) => todo.goalId === goalId).map((todo) => todo.id));
        const adapter = await getWorkflowAdapter(ctx);
        for (const binding of Object.values(state.workflowRuns)) {
          if (todoIds.has(binding.todoId) && (binding.status === "running" || binding.status === "paused")) await adapter.stop(binding.id);
        }
      }

      const now = new Date().toISOString();
      const next = await projectStore.transact((state) => {
        if (params.action === "create") {
          const id = params.id?.trim() || randomUUID();
          const criteria: SuccessCriterion[] = (params.successCriteria ?? []).map((text, index) => ({
            id: `${id}:criterion:${index + 1}`,
            text,
            required: true,
            evidenceIds: [],
          }));
          const title = requireText(params.title, "title");
          let created = addGoal(state, {
            id,
            title,
            objective: requireText(params.objective, "objective"),
            successCriteria: criteria,
            ...(params.constraints ? { constraints: params.constraints } : {}),
            ...(params.nonGoals ? { nonGoals: params.nonGoals } : {}),
            ...(params.evidenceRequirements ? { evidenceRequirements: params.evidenceRequirements } : {}),
            ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
          }, now);
          created = addTodo(created, {
            id: `${id}:root`,
            goalId: id,
            title: `Execute ${title}`,
            execution: "main",
            systemManaged: true,
          }, now);
          return created;
        }

        const id = requireText(params.id, "id");
        if (params.action === "update") {
          let updated = updateGoal(state, id, {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.objective !== undefined ? { objective: params.objective } : {}),
            ...(params.constraints !== undefined ? { constraints: params.constraints } : {}),
            ...(params.nonGoals !== undefined ? { nonGoals: params.nonGoals } : {}),
            ...(params.evidenceRequirements !== undefined ? { evidenceRequirements: params.evidenceRequirements } : {}),
          }, now);
          if (params.criterionId || params.evidenceId) {
            const evidenceId = requireText(params.evidenceId, "evidenceId");
            if (params.evidenceSummary || params.evidenceKind || params.evidenceLocator || params.evidenceValid !== undefined) {
              const existing = updated.evidence[evidenceId];
              const evidence: Evidence = {
                id: evidenceId,
                kind: params.evidenceKind ?? existing?.kind ?? "user",
                summary: params.evidenceSummary ?? existing?.summary ?? evidenceId,
                ...(params.evidenceLocator ? { locator: params.evidenceLocator } : existing?.locator ? { locator: existing.locator } : {}),
                observedAt: now,
                valid: params.evidenceValid ?? existing?.valid ?? true,
              };
              updated = addEvidence(updated, evidence);
            }
            updated = addCriterionEvidence(updated, id, requireText(params.criterionId, "criterionId"), evidenceId, now);
          }
          return updated;
        }
        if (params.action === "complete") return completeGoal(state, id, now);
        if (params.action === "cancel") return cancelGoal(state, id, now);
        throw new Error(`Unsupported goal action: ${params.action}`);
      });
      return textResult(`Goal ${params.action} succeeded.`, next);
    },
  });

  pi.registerTool({
    name: "devflow_todo",
    label: "Devflow Todo",
    description: "Manage hierarchical project todos, dependencies, blockers, and bounded recovery attempts.",
    promptSnippet: "Manage hierarchical todos attached to devflow goals",
    parameters: TodoParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectStore = await getStore(ctx);
      if (params.action === "list") {
        const state = await projectStore.load();
        return textResult(listTodos(state, params.goalId), state);
      }
      if (params.action === "get") {
        const state = await projectStore.load();
        const todo = state.todos[requireText(params.id, "id")];
        if (!todo) throw new Error(`Todo ${params.id} does not exist`);
        return textResult(JSON.stringify(todo, null, 2), state);
      }
      if (params.action === "cancel") {
        const state = await projectStore.load();
        const todoId = requireText(params.id, "id");
        const adapter = await getWorkflowAdapter(ctx);
        for (const binding of Object.values(state.workflowRuns)) {
          const ownsTodo = binding.todoId === todoId || binding.phases.some((phase) => phase.todoId === todoId);
          if (ownsTodo && (binding.status === "running" || binding.status === "paused")) await adapter.stop(binding.id);
        }
      }

      const now = new Date().toISOString();
      const next = await projectStore.transact((state) => {
        if (params.action === "create") {
          const hasProfile = [params.independentUnits, params.hasSequentialDependency, params.writeScope, params.mergeableResults, params.estimatedUnits]
            .some((value) => value !== undefined);
          if (hasProfile && [params.independentUnits, params.hasSequentialDependency, params.writeScope, params.mergeableResults, params.estimatedUnits]
            .some((value) => value === undefined)) throw new Error("All execution profile fields are required together");
          return addTodo(state, {
            id: params.id?.trim() || randomUUID(),
            goalId: requireText(params.goalId, "goalId"),
            title: requireText(params.title, "title"),
            ...(params.parentId ? { parentId: params.parentId } : {}),
            ...(params.description ? { description: params.description } : {}),
            ...(params.required !== undefined ? { required: params.required } : {}),
            ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
            ...(params.execution ? { execution: params.execution } : {}),
            ...(params.resourceClaims ? { resourceClaims: params.resourceClaims } : {}),
            ...(hasProfile ? { executionProfile: {
              independentUnits: params.independentUnits!,
              hasSequentialDependency: params.hasSequentialDependency!,
              writeScope: params.writeScope!,
              mergeableResults: params.mergeableResults!,
              estimatedUnits: params.estimatedUnits!,
            } } : {}),
            ...(params.workflowPlan ? { workflowPlan: params.workflowPlan } : {}),
          }, now);
        }

        const id = requireText(params.id, "id");
        if (params.action === "update") {
          if (params.status === "blocked") {
            if (params.strategy?.trim()) {
              return recordTodoFailure(
                state,
                id,
                params.strategy.trim(),
                requireText(params.blockerReason, "blockerReason"),
                params.evidenceIds ?? [],
                now,
              );
            }
            return blockTodo(state, id, {
              kind: params.blockerKind ?? "tool",
              reason: requireText(params.blockerReason, "blockerReason"),
              ...(params.unlockCondition ? { unlockCondition: params.unlockCondition } : {}),
              ...(params.recommendedAnswer ? { recommendedAnswer: params.recommendedAnswer } : {}),
              ...(params.evidenceIds ? { sourceIds: params.evidenceIds } : {}),
            }, now);
          }
          return updateTodo(state, id, {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.required !== undefined ? { required: params.required } : {}),
            ...(params.execution !== undefined ? { execution: params.execution } : {}),
            ...(params.status !== undefined ? { status: params.status as TodoStatus } : {}),
            ...(params.resourceClaims !== undefined ? { resourceClaims: params.resourceClaims } : {}),
            ...(params.workflowPlan !== undefined ? { workflowPlan: params.workflowPlan } : {}),
          }, now);
        }
        if (params.action === "move") return moveTodo(state, id, params.makeRoot ? undefined : requireText(params.parentId, "parentId"), now);
        if (params.action === "retry") return retryTodo(state, id, requireText(params.strategy, "strategy"), now);
        if (params.action === "cancel") return setTodoStatus(state, id, "cancelled", undefined, now);
        throw new Error(`Unsupported todo action: ${params.action}`);
      });
      return textResult(`Todo ${params.action} succeeded.`, next);
    },
  });

  pi.registerCommand("devflow-models", {
    description: "Interactively configure Devflow central/small/medium/big models",
    handler: async (_args, ctx) => {
      await openDevflowModelSelector(pi, ctx, (config) => applyModelPolicy(modelPolicyFromTierConfig(config)));
    },
  });

  pi.registerCommand("devflow", {
    description: "Open pi-devflow or show status and doctor checks",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action) {
        await openPanel(ctx);
        return;
      }
      const projectStore = await getStore(ctx);
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
        await openDevflowModelSelector(pi, ctx, (config) => applyModelPolicy(modelPolicyFromTierConfig(config)));
        return;
      }
      if (action === "doctor") {
        validateProject(state);
        const legacy = pi.getAllTools().filter((tool) => ["todo", "create_goal", "get_goal", "update_goal"].includes(tool.name));
        const warning = legacy.length > 0 ? ` Legacy tools detected: ${legacy.map((tool) => tool.name).join(", ")}.` : "";
        ctx.ui.notify(`Devflow state is valid at revision ${state.revision}. Journal: ${projectStore.journalPath}.${warning}`, legacy.length > 0 ? "warning" : "info");
        return;
      }
      ctx.ui.notify("Usage: /devflow [status|doctor|models|pause|resume]", "error");
    },
  });
}
