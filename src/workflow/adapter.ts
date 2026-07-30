import { randomUUID } from "node:crypto";

import type { WorkflowRunResult, WorkflowSnapshot } from "@quintinshaw/pi-dynamic-workflows";

import { resourceClaimsConflict } from "../domain/scheduler.js";
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
  ) { this.bindManagerEvents(); }

  async start(todoId: string, plan: DevflowWorkflowPlan): Promise<string> {
    const built = buildWorkflowScript(plan, this.mainModel(), this.policy);
    const bindingId = randomUUID();
    let sequence = 0;
    let ready = false;
    const buffered: Array<{ snapshot: WorkflowSnapshot; sequence: number }> = [];
    const started = this.manager.startInBackground(built.script, undefined, {
      onProgress: (snapshot) => {
        const item = { snapshot: structuredClone(snapshot), sequence: ++sequence };
        if (!ready) buffered.push(item);
        else this.enqueue(bindingId, () => this.store.transact(
          (state) => applyWorkflowSnapshot(state, bindingId, item.snapshot, item.sequence, new Date().toISOString()),
          { actor: `workflow:${bindingId}:progress` },
        ));
      },
    });

    await this.store.transact((state) => createWorkflowBinding(state, {
      bindingId,
      upstreamRunId: started.runId,
      todoId,
      phases: built.phases,
    }, new Date().toISOString()), { actor: `workflow:${bindingId}:start` });
    this.bindingByRunId.set(started.runId, bindingId);
    ready = true;
    for (const item of buffered) {
      this.enqueue(bindingId, () => this.store.transact(
        (state) => applyWorkflowSnapshot(state, bindingId, item.snapshot, item.sequence, new Date().toISOString()),
        { actor: `workflow:${bindingId}:progress` },
      ));
    }

    const completion = started.promise.then(
      async () => this.enqueue(bindingId, async () => {
        const binding = (await this.store.load()).workflowRuns[bindingId];
        if (!binding || binding.status === "completed" || binding.status === "stopped") return;
        await this.store.transact(
          (state) => completeWorkflowBinding(state, bindingId, new Date().toISOString()),
          { actor: `workflow:${bindingId}:complete` },
        );
      }),
      async (error: unknown) => this.enqueue(bindingId, async () => {
        const binding = (await this.store.load()).workflowRuns[bindingId];
        if (!binding || binding.status === "paused" || binding.status === "stopped") return;
        await this.store.transact(
          (state) => failWorkflowBinding(state, bindingId, error instanceof Error ? error.message : String(error), new Date().toISOString()),
          { actor: `workflow:${bindingId}:failed` },
        );
      }),
    ).then(() => undefined);
    this.completions.set(bindingId, completion);
    return bindingId;
  }

  async pause(bindingId: string): Promise<boolean> {
    const binding = (await this.store.load()).workflowRuns[bindingId];
    if (!binding || binding.status !== "running") return false;
    this.bindingByRunId.set(binding.upstreamRunId, bindingId);
    await this.queues.get(bindingId);
    await this.store.transact((state) => {
      const next = structuredClone(state);
      next.workflowRuns[bindingId]!.status = "paused";
      delete next.scheduler.activeLeases[binding.todoId];
      return next;
    }, { actor: `workflow:${bindingId}:pause` });
    if (this.manager.pause(binding.upstreamRunId)) return true;
    await this.store.transact((state) => {
      const next = structuredClone(state);
      next.workflowRuns[bindingId]!.status = "running";
      const todo = next.todos[binding.todoId]!;
      next.scheduler.activeLeases[todo.id] = {
        id: todo.id, todoId: todo.id, goalId: todo.goalId, mode: "workflow",
        resourceClaims: structuredClone(todo.resourceClaims), acquiredAt: new Date().toISOString(),
      };
      return next;
    }, { actor: `workflow:${bindingId}:pause-rollback` });
    return false;
  }

  async resume(bindingId: string): Promise<boolean> {
    const binding = (await this.store.load()).workflowRuns[bindingId];
    if (!binding || binding.status !== "paused") return false;
    this.bindingByRunId.set(binding.upstreamRunId, bindingId);
    await this.queues.get(bindingId);
    await this.store.transact((state) => {
      const next = structuredClone(state);
      const todo = next.todos[binding.todoId];
      if (!todo) throw new Error(`Workflow todo ${binding.todoId} does not exist`);
      const otherLeases = Object.values(next.scheduler.activeLeases).filter((lease) => lease.todoId !== todo.id);
      if (resourceClaimsConflict(todo.resourceClaims, otherLeases.flatMap((lease) => lease.resourceClaims))) {
        throw new Error(`Workflow ${bindingId} cannot resume because its resources are busy`);
      }
      if (otherLeases.filter((lease) => lease.mode === "workflow").length >= next.scheduler.maxConcurrentWorkflow) {
        throw new Error(`Workflow ${bindingId} cannot resume because Workflow capacity is full`);
      }
      next.workflowRuns[bindingId]!.status = "running";
      next.scheduler.activeLeases[todo.id] = {
        id: todo.id, todoId: todo.id, goalId: todo.goalId, mode: "workflow",
        resourceClaims: structuredClone(todo.resourceClaims), acquiredAt: new Date().toISOString(),
      };
      return next;
    }, { actor: `workflow:${bindingId}:resume` });
    if (await this.manager.resume(binding.upstreamRunId)) return true;
    await this.store.transact((state) => {
      const next = structuredClone(state);
      next.workflowRuns[bindingId]!.status = "paused";
      delete next.scheduler.activeLeases[binding.todoId];
      return next;
    }, { actor: `workflow:${bindingId}:resume-rollback` });
    return false;
  }

  async stop(bindingId: string): Promise<boolean> {
    const before = await this.store.load();
    const binding = before.workflowRuns[bindingId];
    if (!binding || (binding.status !== "running" && binding.status !== "paused")) return false;
    this.bindingByRunId.set(binding.upstreamRunId, bindingId);
    await this.queues.get(bindingId);
    await this.store.transact((state) => {
      const next = structuredClone(state);
      next.workflowRuns[bindingId]!.status = "stopped";
      next.workflowRuns[bindingId]!.endedAt = new Date().toISOString();
      delete next.scheduler.activeLeases[binding.todoId];
      const activePhase = binding.phases.find((phase) => next.todos[phase.todoId]?.status === "in_progress");
      if (activePhase) {
        next.todos[activePhase.todoId]!.status = "blocked";
        next.todos[activePhase.todoId]!.blocker = {
          kind: "workflow", reason: "Workflow was stopped", sourceIds: [binding.upstreamRunId],
        };
      }
      return next;
    }, { actor: `workflow:${bindingId}:stop` });
    if (this.manager.stop(binding.upstreamRunId)) return true;
    await this.store.transact(() => before, { actor: `workflow:${bindingId}:stop-rollback` });
    return false;
  }


  private bindManagerEvents(): void {
    if (!this.manager.on) return;
    for (const event of ["phase", "agentStart", "agentEnd", "tokenUsage"]) {
      this.manager.on(event, (payload) => { this.queueSnapshot(payload.runId); });
    }
    this.manager.on("complete", (payload) => { this.queueTerminalEvent(payload.runId, "completed"); });
    this.manager.on("error", (payload) => { this.queueTerminalEvent(payload.runId, "failed", payload.error); });
    this.manager.on("paused", (payload) => { this.queueTerminalEvent(payload.runId, "paused"); });
    this.manager.on("resumed", (payload) => { this.queueTerminalEvent(payload.runId, "running"); });
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
      return applyWorkflowSnapshot(state, bindingId, captured, binding.lastSnapshotSequence + 1, new Date().toISOString());
    }, { actor: `workflow:${bindingId}:event-progress` }));
  }

  private queueTerminalEvent(
    runId: string,
    status: "completed" | "failed" | "paused" | "running" | "stopped",
    error?: unknown,
  ): void {
    const bindingId = this.bindingByRunId.get(runId);
    if (!bindingId) return;
    void this.enqueue(bindingId, () => this.store.transact((state) => {
      const current = state.workflowRuns[bindingId];
      if (!current) return state;
      if (status === "completed") {
        if (current.status === "stopped") return state;
        return completeWorkflowBinding(state, bindingId, new Date().toISOString());
      }
      if (status === "failed") {
        if (current.status === "paused" || current.status === "stopped") return state;
        return failWorkflowBinding(state, bindingId, error instanceof Error ? error.message : String(error ?? "Workflow failed"), new Date().toISOString());
      }
      const next = structuredClone(state);
      next.workflowRuns[bindingId]!.status = status;
      if (status === "stopped") next.workflowRuns[bindingId]!.endedAt = new Date().toISOString();
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
    const next = prior.then(operation).then(() => undefined);
    this.queues.set(bindingId, next);
    return next;
  }
}
