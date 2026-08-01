import { randomUUID } from "node:crypto";

import type { WorkflowRunResult, WorkflowSnapshot } from "@quintinshaw/pi-dynamic-workflows";

import { resourceClaimsConflict } from "../domain/scheduler.js";
import { LEGACY_UNOWNED_SESSION, type ExecutionScope } from "../domain/types.js";
import { ProjectStore } from "../store/project-store.js";
import {
  applyWorkflowSnapshot,
  completeWorkflowBinding,
  createWorkflowBinding,
  failWorkflowBinding,
} from "./projection.js";
import { buildWorkflowScript, type DevflowWorkflowPlan } from "./script.js";
import type { DevflowModelPolicy } from "./model-router.js";

export interface WorkflowManagerLike {
  startInBackground(
    script: string,
    args?: unknown,
    exec?: { onProgress?: (snapshot: WorkflowSnapshot) => void },
  ): { runId: string; promise: Promise<WorkflowRunResult> };
  pause(runId: string): boolean;
  resume(runId: string): Promise<boolean>;
  stop(runId: string): boolean;
  getSnapshot?(runId: string): WorkflowSnapshot | null;
  on?(event: string, listener: (payload: { runId: string; [key: string]: unknown }) => void): unknown;
}

export class DevflowWorkflowAdapter {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly bindingByRunId = new Map<string, string>();

  constructor(
    private readonly manager: WorkflowManagerLike,
    private readonly store: ProjectStore,
    private readonly mainModel: () => string,
    private readonly policy: DevflowModelPolicy,
    private readonly onTerminal?: () => void,
    private readonly scope: ExecutionScope = { sessionId: LEGACY_UNOWNED_SESSION, runtimeId: LEGACY_UNOWNED_SESSION },
  ) { this.bindManagerEvents(); }

  async start(todoId: string, plan: DevflowWorkflowPlan): Promise<string> {
    const built = buildWorkflowScript(plan, this.mainModel(), this.policy);
    const bindingId = randomUUID();
    await this.store.transact((state) => createWorkflowBinding(state, {
      bindingId,
      upstreamRunId: `pending:${bindingId}`,
      todoId,
      ownerSessionId: this.scope.sessionId,
      ownerRuntimeId: this.scope.runtimeId,
      status: "planned",
      phases: built.phases,
    }, new Date().toISOString()), { actor: `workflow:${bindingId}:reserve` });

    let sequence = 0;
    let ready = false;
    const buffered: Array<{ snapshot: WorkflowSnapshot; sequence: number }> = [];
    let started: ReturnType<WorkflowManagerLike["startInBackground"]>;
    try {
      started = this.manager.startInBackground(built.script, undefined, {
        onProgress: (snapshot) => {
          const item = { snapshot: structuredClone(snapshot), sequence: ++sequence };
          if (!ready) buffered.push(item);
          else void this.enqueue(bindingId, () => this.store.transact(
            (state) => applyWorkflowSnapshot(state, bindingId, item.snapshot, item.sequence, new Date().toISOString()),
            { actor: `workflow:${bindingId}:progress` },
          ));
        },
      });
    } catch (error) {
      await this.store.transact(
        (state) => failWorkflowBinding(state, bindingId, error instanceof Error ? error.message : String(error), new Date().toISOString()),
        { actor: `workflow:${bindingId}:start-failed` },
      );
      throw error;
    }

    try {
      await this.store.transact((state) => {
        const next = structuredClone(state);
        const binding = next.workflowRuns[bindingId];
        if (!binding || binding.status !== "planned" || binding.ownerRuntimeId !== this.scope.runtimeId) {
          throw new Error(`Workflow reservation ${bindingId} was lost`);
        }
        const parent = next.todos[binding.todoId];
        const goal = parent ? next.goals[parent.goalId] : undefined;
        if (!parent || !goal || parent.status === "completed" || parent.status === "cancelled" || goal.status === "completed" || goal.status === "cancelled") {
          throw new Error(`Workflow reservation ${bindingId} was cancelled before launch`);
        }
        binding.upstreamRunId = started.runId;
        binding.status = "running";
        binding.startedAt = new Date().toISOString();
        return next;
      }, { actor: `workflow:${bindingId}:start` });
    } catch (error) {
      this.manager.stop(started.runId);
      await this.store.transact((state) => {
        const binding = state.workflowRuns[bindingId];
        return binding && binding.status === "planned"
          ? failWorkflowBinding(state, bindingId, "Workflow launch could not be committed", new Date().toISOString())
          : state;
      }, { actor: `workflow:${bindingId}:orphan-stop` });
      throw error;
    }

    this.bindingByRunId.set(started.runId, bindingId);
    ready = true;
    for (const item of buffered) {
      void this.enqueue(bindingId, () => this.store.transact(
        (state) => applyWorkflowSnapshot(state, bindingId, item.snapshot, item.sequence, new Date().toISOString()),
        { actor: `workflow:${bindingId}:progress` },
      ));
    }

    const completion = started.promise.then(
      async () => this.enqueue(bindingId, () => this.store.transact((state) => {
        const current = state.workflowRuns[bindingId];
        if (!current || current.status !== "running"
          || current.ownerSessionId !== this.scope.sessionId
          || current.ownerRuntimeId !== this.scope.runtimeId) return state;
        return completeWorkflowBinding(state, bindingId, new Date().toISOString());
      }, { actor: `workflow:${bindingId}:complete` })),
      async (error: unknown) => this.enqueue(bindingId, () => this.store.transact((state) => {
        const current = state.workflowRuns[bindingId];
        if (!current || current.status !== "running"
          || current.ownerSessionId !== this.scope.sessionId
          || current.ownerRuntimeId !== this.scope.runtimeId) return state;
        return failWorkflowBinding(state, bindingId, error instanceof Error ? error.message : String(error), new Date().toISOString());
      }, { actor: `workflow:${bindingId}:failed` })),
    ).then(() => undefined);
    this.completions.set(bindingId, completion);
    return bindingId;
  }

  async pause(bindingId: string): Promise<boolean> {
    const binding = (await this.store.load()).workflowRuns[bindingId];
    if (!binding || binding.status !== "running") return false;
    if (binding.ownerSessionId !== this.scope.sessionId || binding.ownerRuntimeId !== this.scope.runtimeId) return false;
    this.bindingByRunId.set(binding.upstreamRunId, bindingId);
    await this.queues.get(bindingId);
    try {
      await this.store.transact((state) => {
        const current = state.workflowRuns[bindingId];
        if (!current || current.status !== "running" || current.ownerRuntimeId !== this.scope.runtimeId) {
          throw new Error(`Workflow ${bindingId} is no longer owned and running`);
        }
        const next = structuredClone(state);
        next.workflowRuns[bindingId]!.status = "paused";
        delete next.scheduler.activeLeases[binding.todoId];
        return next;
      }, { actor: `workflow:${bindingId}:pause` });
    } catch {
      return false;
    }
    if (this.manager.pause(binding.upstreamRunId)) return true;
    await this.store.transact((state) => {
      const current = state.workflowRuns[bindingId];
      if (!current || current.status !== "paused" || current.ownerRuntimeId !== this.scope.runtimeId) return state;
      const next = structuredClone(state);
      next.workflowRuns[bindingId]!.status = "running";
      const todo = next.todos[binding.todoId]!;
      next.scheduler.activeLeases[todo.id] = {
        id: todo.id, todoId: todo.id, goalId: todo.goalId,
        ownerSessionId: this.scope.sessionId, ownerRuntimeId: this.scope.runtimeId, mode: "workflow",
        resourceClaims: structuredClone(todo.resourceClaims), acquiredAt: new Date().toISOString(),
      };
      return next;
    }, { actor: `workflow:${bindingId}:pause-rollback` });
    return false;
  }

  async resume(bindingId: string): Promise<boolean> {
    const binding = (await this.store.load()).workflowRuns[bindingId];
    if (!binding || binding.status !== "paused" || binding.ownerSessionId !== this.scope.sessionId) return false;
    this.bindingByRunId.set(binding.upstreamRunId, bindingId);
    await this.queues.get(bindingId);
    try {
      await this.store.transact((state) => {
        const current = state.workflowRuns[bindingId];
        const todo = current ? state.todos[current.todoId] : undefined;
        const goal = todo ? state.goals[todo.goalId] : undefined;
        if (!current || current.status !== "paused" || current.ownerSessionId !== this.scope.sessionId) {
          throw new Error(`Workflow ${bindingId} is no longer paused for this session`);
        }
        if (!todo || todo.status === "completed" || todo.status === "cancelled" || !goal || goal.status === "completed" || goal.status === "cancelled") {
          throw new Error(`Workflow ${bindingId} cannot resume terminal work`);
        }
        const otherLeases = Object.values(state.scheduler.activeLeases).filter((lease) => lease.todoId !== todo.id);
        if (resourceClaimsConflict(todo.resourceClaims, otherLeases.flatMap((lease) => lease.resourceClaims))) {
          throw new Error(`Workflow ${bindingId} cannot resume because its resources are busy`);
        }
        if (otherLeases.filter((lease) => lease.mode === "workflow" && lease.ownerSessionId === this.scope.sessionId).length >= state.scheduler.maxConcurrentWorkflow) {
          throw new Error(`Workflow ${bindingId} cannot resume because Workflow capacity is full`);
        }
        const next = structuredClone(state);
        next.workflowRuns[bindingId]!.status = "running";
        next.workflowRuns[bindingId]!.ownerRuntimeId = this.scope.runtimeId;
        next.scheduler.activeLeases[todo.id] = {
          id: todo.id, todoId: todo.id, goalId: todo.goalId,
          ownerSessionId: this.scope.sessionId, ownerRuntimeId: this.scope.runtimeId, mode: "workflow",
          resourceClaims: structuredClone(todo.resourceClaims), acquiredAt: new Date().toISOString(),
        };
        return next;
      }, { actor: `workflow:${bindingId}:resume` });
    } catch {
      return false;
    }
    if (await this.manager.resume(binding.upstreamRunId)) return true;
    await this.store.transact((state) => {
      const current = state.workflowRuns[bindingId];
      if (!current || current.status !== "running" || current.ownerRuntimeId !== this.scope.runtimeId) return state;
      const next = structuredClone(state);
      next.workflowRuns[bindingId]!.status = "paused";
      delete next.scheduler.activeLeases[binding.todoId];
      return next;
    }, { actor: `workflow:${bindingId}:resume-rollback` });
    return false;
  }

  async stop(bindingId: string): Promise<boolean> {
    const binding = (await this.store.load()).workflowRuns[bindingId];
    if (!binding || !["planned", "running", "paused"].includes(binding.status)) return false;
    if (binding.ownerSessionId !== this.scope.sessionId) return false;
    if (binding.status === "running" && binding.ownerRuntimeId !== this.scope.runtimeId) return false;
    if (binding.status === "planned") {
      if (binding.ownerRuntimeId !== this.scope.runtimeId) return false;
      let stopped = false;
      await this.store.transact((state) => {
        const current = state.workflowRuns[bindingId];
        if (!current || current.status !== "planned" || current.ownerRuntimeId !== this.scope.runtimeId) return state;
        const next = structuredClone(state);
        next.workflowRuns[bindingId]!.status = "stopped";
        next.workflowRuns[bindingId]!.endedAt = new Date().toISOString();
        delete next.scheduler.activeLeases[binding.todoId];
        stopped = true;
        return next;
      }, { actor: `workflow:${bindingId}:cancel-planned` });
      if (stopped) return true;
      const latest = (await this.store.load()).workflowRuns[bindingId];
      return latest?.status === "running" ? this.stop(bindingId) : latest?.status === "stopped";
    }
    this.bindingByRunId.set(binding.upstreamRunId, bindingId);
    await this.queues.get(bindingId);
    const priorStatus = binding.status;
    const stoppedAt = new Date().toISOString();
    try {
      await this.store.transact((state) => {
        const current = state.workflowRuns[bindingId];
        if (!current || current.status !== priorStatus || current.ownerSessionId !== this.scope.sessionId) {
          throw new Error(`Workflow ${bindingId} changed before stop`);
        }
        if (current.status === "running" && current.ownerRuntimeId !== this.scope.runtimeId) {
          throw new Error(`Workflow ${bindingId} is running in another runtime`);
        }
        const next = structuredClone(state);
        const owned = next.workflowRuns[bindingId]!;
        owned.ownerRuntimeId = this.scope.runtimeId;
        owned.status = "stopped";
        owned.endedAt = stoppedAt;
        delete next.scheduler.activeLeases[binding.todoId];
        const activePhase = owned.phases.find((phase) => next.todos[phase.todoId]?.status === "in_progress");
        if (activePhase) {
          next.todos[activePhase.todoId]!.status = "blocked";
          next.todos[activePhase.todoId]!.blocker = {
            kind: "workflow", reason: "Workflow was stopped", sourceIds: [binding.upstreamRunId],
          };
        }
        return next;
      }, { actor: `workflow:${bindingId}:stop` });
    } catch {
      return false;
    }
    if (this.manager.stop(binding.upstreamRunId)) return true;
    if (priorStatus === "paused") return true;
    await this.store.transact((state) => {
      const current = state.workflowRuns[bindingId];
      if (!current || current.status !== "stopped" || current.endedAt !== stoppedAt || current.ownerRuntimeId !== this.scope.runtimeId) return state;
      const next = structuredClone(state);
      const owned = next.workflowRuns[bindingId]!;
      owned.status = priorStatus;
      delete owned.endedAt;
      const activePhase = owned.phases.find((phase) => next.todos[phase.todoId]?.blocker?.reason === "Workflow was stopped");
      if (activePhase) {
        next.todos[activePhase.todoId]!.status = "in_progress";
        delete next.todos[activePhase.todoId]!.blocker;
      }
      if (priorStatus === "running") {
        const todo = next.todos[binding.todoId]!;
        next.scheduler.activeLeases[todo.id] = {
          id: todo.id, todoId: todo.id, goalId: todo.goalId,
          ownerSessionId: this.scope.sessionId, ownerRuntimeId: this.scope.runtimeId, mode: "workflow",
          resourceClaims: structuredClone(todo.resourceClaims), acquiredAt: new Date().toISOString(),
        };
      }
      return next;
    }, { actor: `workflow:${bindingId}:stop-rollback` });
    return false;
  }


  private bindManagerEvents(): void {
    if (!this.manager.on) return;
    for (const event of ["phase", "agentStart", "agentEnd", "tokenUsage"]) {
      this.manager.on(event, (payload) => { this.queueSnapshot(payload.runId); });
    }
    this.manager.on("complete", (payload) => { this.queueTerminalEvent(payload.runId, "completed"); });
    this.manager.on("error", (payload) => { this.queueTerminalEvent(payload.runId, "failed", payload.error); });
    // pause()/resume() own the durable CAS; manager echoes can arrive after a newer lifecycle generation.
    this.manager.on("stopped", (payload) => { this.queueTerminalEvent(payload.runId, "stopped"); });
  }

  private queueSnapshot(runId: string): void {
    const bindingId = this.bindingByRunId.get(runId);
    const snapshot = this.manager.getSnapshot?.(runId);
    if (!bindingId || !snapshot) return;
    const captured = structuredClone(snapshot);
    void this.enqueue(bindingId, () => this.store.transact((state) => {
      const binding = state.workflowRuns[bindingId];
      if (!binding) return state;
      if (binding.ownerSessionId !== this.scope.sessionId || binding.ownerRuntimeId !== this.scope.runtimeId) return state;
      return applyWorkflowSnapshot(state, bindingId, captured, binding.lastSnapshotSequence + 1, new Date().toISOString());
    }, { actor: `workflow:${bindingId}:event-progress` }));
  }

  private queueTerminalEvent(
    runId: string,
    status: "completed" | "failed" | "stopped",
    error?: unknown,
  ): void {
    const bindingId = this.bindingByRunId.get(runId);
    if (!bindingId) return;
    void this.enqueue(bindingId, () => this.store.transact((state) => {
      const current = state.workflowRuns[bindingId];
      if (!current) return state;
      if (current.ownerSessionId !== this.scope.sessionId || current.ownerRuntimeId !== this.scope.runtimeId) return state;
      if (status === "completed") {
        return current.status === "running" ? completeWorkflowBinding(state, bindingId, new Date().toISOString()) : state;
      }
      if (status === "failed") {
        return current.status === "running"
          ? failWorkflowBinding(state, bindingId, error instanceof Error ? error.message : String(error ?? "Workflow failed"), new Date().toISOString())
          : state;
      }
      if (current.status !== "planned" && current.status !== "running" && current.status !== "paused") return state;
      const next = structuredClone(state);
      next.workflowRuns[bindingId]!.status = "stopped";
      next.workflowRuns[bindingId]!.endedAt = new Date().toISOString();
      delete next.scheduler.activeLeases[current.todoId];
      return next;
    }, { actor: `workflow:${bindingId}:event-${status}` })).then(() => {
      if (status === "completed" || status === "failed" || status === "stopped") {
        this.bindingByRunId.delete(runId);
        this.onTerminal?.();
      }
    });
  }

  async wait(bindingId: string): Promise<void> {
    await this.completions.get(bindingId);
    await this.queues.get(bindingId);
  }

  private enqueue(bindingId: string, operation: () => Promise<unknown>): Promise<void> {
    const prior = this.queues.get(bindingId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation).then(() => undefined);
    this.queues.set(bindingId, next);
    return next;
  }
}
