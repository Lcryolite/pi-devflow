import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { blockTodo, markGrillAsked } from "../domain/transitions.js";
import { applySchedulePlan, markContinuation, planSchedule } from "../domain/scheduler.js";
import type { ExecutionScope, ProjectState, WorkflowPlanData } from "../domain/types.js";
import { selectPendingGrill } from "../grill.js";
import type { ProjectStore } from "../store/project-store.js";
import type { DevflowWorkflowAdapter } from "../workflow/adapter.js";

export type ContinuationDecision =
  | { kind: "expire"; key: string }
  | { kind: "mark_sent"; key: string }
  | { kind: "block_missing_plan"; todoId: string; key: string }
  | { kind: "start_workflow"; todoId: string; key: string; plan: WorkflowPlanData }
  | { kind: "send_main"; todoId: string; key: string; title: string };

export type GrillDecision = {
  key: string;
  todoId: string;
  question: string;
  recommendedAnswer?: string;
};

/** Pure: decide what to do for one reserved continuation under the current state. */
export function decideReservedContinuation(state: ProjectState, key: string): ContinuationDecision {
  const record = state.scheduler.continuationKeys[key];
  const todo = record ? state.todos[record.todoId] : undefined;
  if (!record || !todo || todo.status !== "in_progress" || !state.scheduler.activeLeases[todo.id]) {
    return { kind: "expire", key };
  }
  if (todo.execution === "workflow") {
    if (todo.workflowRunId) return { kind: "mark_sent", key };
    if (!todo.workflowPlan) return { kind: "block_missing_plan", todoId: todo.id, key };
    return { kind: "start_workflow", todoId: todo.id, key, plan: todo.workflowPlan };
  }
  return { kind: "send_main", todoId: todo.id, key, title: todo.title };
}

export function filterReservedKeys(state: ProjectState, allowMain: boolean, scope?: ExecutionScope): string[] {
  return Object.values(state.scheduler.continuationKeys)
    .filter((record) => {
      const todo = state.todos[record.todoId];
      return record.status === "reserved"
        && (!scope || (record.ownerSessionId === scope.sessionId && record.ownerRuntimeId === scope.runtimeId))
        && (allowMain || todo?.execution === "workflow");
    })
    .map((record) => record.key);
}

export function decideGrill(state: ProjectState, sessionId?: string): GrillDecision | undefined {
  const grill = selectPendingGrill(state, sessionId);
  if (!grill) return undefined;
  return {
    key: grill.key,
    todoId: grill.todoId,
    question: grill.question,
    ...(grill.recommendedAnswer !== undefined ? { recommendedAnswer: grill.recommendedAnswer } : {}),
  };
}

export function scheduleForDispatch(state: ProjectState, now: string, allowMain: boolean, scope?: ExecutionScope) {
  const plan = planSchedule(state, now, scope);
  return allowMain ? plan : { ...plan, starts: plan.starts.filter((start) => start.mode === "workflow") };
}

export interface DispatchDeps {
  pi: ExtensionAPI;
  getStore(ctx: ExtensionContext): Promise<ProjectStore>;
  getAdapter(ctx: ExtensionContext): Promise<DevflowWorkflowAdapter>;
  getScope(ctx: ExtensionContext): ExecutionScope;
}

async function applyDecision(
  deps: DispatchDeps,
  ctx: ExtensionContext,
  projectStore: ProjectStore,
  decision: ContinuationDecision,
): Promise<void> {
  switch (decision.kind) {
    case "expire":
      await projectStore.transact(
        (draft) => markContinuation(draft, decision.key, "expired"),
        { actor: "extension:continuation" },
      );
      return;
    case "mark_sent":
      await projectStore.transact(
        (draft) => markContinuation(draft, decision.key, "sent"),
        { actor: "extension:continuation" },
      );
      return;
    case "block_missing_plan":
      await projectStore.transact((draft) => {
        const blocked = blockTodo(draft, decision.todoId, {
          kind: "decision",
          reason: "Workflow execution was selected but no workflow plan is attached",
          recommendedAnswer: "Attach a workflow plan or switch execution to main",
          sourceIds: [],
        }, new Date().toISOString());
        return markContinuation(blocked, decision.key, "expired");
      }, { actor: "extension:scheduler" });
      return;
    case "start_workflow":
      try {
        await (await deps.getAdapter(ctx)).start(decision.todoId, decision.plan);
        await projectStore.transact(
          (draft) => markContinuation(draft, decision.key, "sent"),
          { actor: "extension:continuation" },
        );
      } catch (error) {
        await projectStore.transact((draft) => {
          const blocked = blockTodo(draft, decision.todoId, {
            kind: "workflow",
            reason: error instanceof Error ? error.message : String(error),
            sourceIds: [],
          }, new Date().toISOString());
          return markContinuation(blocked, decision.key, "expired");
        }, { actor: "extension:workflow" });
      }
      return;
    case "send_main":
      await projectStore.transact(
        (draft) => markContinuation(draft, decision.key, "sent"),
        { actor: "extension:continuation" },
      );
      deps.pi.sendMessage({
        customType: "devflow-continuation",
        content: `[devflow-continuation:${decision.key}] Continue Todo ${decision.todoId}: ${decision.title}. Update devflow state and evidence as work progresses. Do not bypass Pi permissions or dangerous-operation confirmations.`,
        display: true,
      }, { deliverAs: "followUp", triggerTurn: true });
      return;
  }
}

/** One dispatch pass: schedule → act on reserved continuations → maybe grill. */
export async function runDispatchPass(
  deps: DispatchDeps,
  ctx: ExtensionContext,
  allowMain: boolean,
): Promise<void> {
  const projectStore = await deps.getStore(ctx);
  const scope = deps.getScope(ctx);
  const preview = scheduleForDispatch(await projectStore.load(), new Date().toISOString(), allowMain, scope);
  const now = new Date().toISOString();
  const scheduled = preview.starts.length > 0
    ? await projectStore.transact(
        (draft) => applySchedulePlan(draft, scheduleForDispatch(draft, now, allowMain, scope), now, scope),
        { actor: "extension:scheduler" },
      )
    : await projectStore.load();

  // Decisions use the post-schedule snapshot (same as pre-refactor) so concurrent
  // reserved keys are independent of each other's side effects in this pass.
  const reservedKeys = filterReservedKeys(scheduled, allowMain, scope);
  for (const key of reservedKeys) {
    const decision = decideReservedContinuation(scheduled, key);
    await applyDecision(deps, ctx, projectStore, decision);
  }
  if (reservedKeys.length > 0) return;

  const state = await projectStore.load();
  const grill = decideGrill(state, scope.sessionId);
  if (!grill) return;
  await projectStore.transact((draft) => markGrillAsked(draft, grill.key, scope.sessionId), { actor: "extension:grill" });
  deps.pi.sendMessage({
    customType: "devflow-grill",
    content: `Ask the user exactly one question to unblock Todo ${grill.todoId}: ${grill.question}${grill.recommendedAnswer ? ` Recommended answer: ${grill.recommendedAnswer}` : ""}`,
    display: true,
  }, { deliverAs: "followUp", triggerTurn: true });
}

/** Serializes overlapping dispatchReady calls; ORs allowMain across pending requests. */
export class DispatchGate {
  private dispatching = false;
  private pending = false;
  private pendingAllowsMain = false;
  private pendingContext: ExtensionContext | undefined;

  async run(
    ctx: ExtensionContext,
    allowMain: boolean,
    pass: (ctx: ExtensionContext, allowMain: boolean) => Promise<void>,
  ): Promise<void> {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    if (this.dispatching) {
      this.pending = true;
      this.pendingAllowsMain ||= allowMain;
      this.pendingContext = ctx;
      return;
    }
    this.dispatching = true;
    let passAllowsMain = allowMain;
    let passContext = ctx;
    try {
      do {
        this.pending = false;
        await pass(passContext, passAllowsMain);
        passAllowsMain = this.pendingAllowsMain;
        passContext = this.pendingContext ?? passContext;
        this.pendingAllowsMain = false;
        this.pendingContext = undefined;
      } while (this.pending);
    } finally {
      this.dispatching = false;
    }
  }
}
