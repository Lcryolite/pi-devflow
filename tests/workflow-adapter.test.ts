import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WorkflowRunResult, WorkflowSnapshot } from "@quintinshaw/pi-dynamic-workflows";

import {
  addGoal,
  addTodo,
  createWorkflowBinding,
  DevflowWorkflowAdapter,
  ProjectStore,
  type WorkflowManagerLike,
} from "../src/index.js";

class FakeManager implements WorkflowManagerLike {
  starts = 0;
  startInBackground(_script: string, _args?: unknown, exec?: { onProgress?: (snapshot: WorkflowSnapshot) => void }) {
    this.starts += 1;
    exec?.onProgress?.({
      name: "review", phases: ["Inspect"], currentPhase: "Inspect", logs: [],
      agents: [{ id: 1, callId: "run:1", label: "reader", phase: "Inspect", prompt: "read", status: "done", model: "openai/gpt-small" }],
      agentCount: 1, runningCount: 0, doneCount: 1, errorCount: 0,
    });
    const result: WorkflowRunResult = {
      meta: { name: "review", description: "Review" }, result: {}, logs: [], phases: ["Inspect"], agentCount: 1, durationMs: 1,
    };
    return { runId: "run", promise: Promise.resolve(result) };
  }
  pause() { return true; }
  async resume() { return true; }
  stop() { return true; }
}

class HoldingManager extends EventEmitter implements WorkflowManagerLike {
  starts = 0;
  startInBackground() {
    this.starts += 1;
    return { runId: `held-${this.starts}`, promise: new Promise<WorkflowRunResult>(() => {}) };
  }
  pause() { return true; }
  async resume() { return true; }
  stop() { return true; }
}


class LifecycleManager extends EventEmitter implements WorkflowManagerLike {
  private rejectRun!: (error: Error) => void;
  snapshot: WorkflowSnapshot = {
    name: "review", phases: ["Inspect"], currentPhase: "Inspect", logs: [], agents: [],
    agentCount: 0, runningCount: 0, doneCount: 0, errorCount: 0,
  };

  startInBackground() {
    const promise = new Promise<WorkflowRunResult>((_resolve, reject) => { this.rejectRun = reject; });
    return { runId: "lifecycle-run", promise };
  }
  pause() { this.rejectRun(new Error("aborted for pause")); this.emit("paused", { runId: "lifecycle-run" }); return true; }
  async resume() {
    this.emit("resumed", { runId: "lifecycle-run" });
    this.snapshot = {
      ...this.snapshot,
      agents: [{ id: 1, callId: "lifecycle-run:1", label: "reader", phase: "Inspect", prompt: "read", status: "done", model: "openai/gpt-actual" }],
      agentCount: 1, doneCount: 1,
    };
    this.emit("agentEnd", { runId: "lifecycle-run" });
    this.emit("complete", { runId: "lifecycle-run", result: {} });
    return true;
  }
  stop() { this.emit("stopped", { runId: "lifecycle-run" }); return true; }
  getSnapshot() { return this.snapshot; }
}


class StopManager extends EventEmitter implements WorkflowManagerLike {
  private rejectRun!: (error: Error) => void;
  startInBackground() {
    const promise = new Promise<WorkflowRunResult>((_resolve, reject) => { this.rejectRun = reject; });
    return { runId: "stop-run", promise };
  }
  pause() { return true; }
  async resume() { return true; }
  stop() { this.rejectRun(new Error("aborted for stop")); this.emit("stopped", { runId: "stop-run" }); return true; }
}

test("adapter owns one manager run and projects progress into the Todo tree", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-workflow-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = await ProjectStore.open("/repo", { stateRoot });
  await store.transact((state) => {
    let next = addGoal(state, { id: "goal", title: "Goal", objective: "Review", successCriteria: [] }, new Date().toISOString());
    next = addTodo(next, { id: "todo", goalId: "goal", title: "Review" }, new Date().toISOString());
    return next;
  });
  const manager = new FakeManager();
  const adapter = new DevflowWorkflowAdapter(manager, store, () => "openai/gpt-main", { fanout: "openai/gpt-small" });

  const bindingId = await adapter.start("todo", {
    name: "review", description: "Review", phases: [{ title: "Inspect", role: "fanout", prompts: ["Read code"] }],
  });
  await adapter.wait(bindingId);

  const state = await store.load();
  assert.equal(manager.starts, 1);
  assert.equal(state.workflowRuns[bindingId]?.status, "completed");
  assert.equal(state.workflowRuns[bindingId]?.phases[0]?.agents[0]?.model, "openai/gpt-small");
  assert.equal(state.todos.todo?.status, "completed");
});


test("pause rejection stays paused and resumed manager events restore projection", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-workflow-lifecycle-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = await ProjectStore.open("/repo", { stateRoot });
  await store.transact((state) => {
    let next = addGoal(state, { id: "goal", title: "Goal", objective: "Review", successCriteria: [] }, new Date().toISOString());
    next = addTodo(next, { id: "todo", goalId: "goal", title: "Review" }, new Date().toISOString());
    return next;
  });
  const manager = new LifecycleManager();
  const adapter = new DevflowWorkflowAdapter(manager, store, () => "openai/gpt-main", { fanout: "openai/gpt-small" });
  const bindingId = await adapter.start("todo", {
    name: "review", description: "Review", phases: [{ title: "Inspect", role: "fanout", prompts: ["Read code"] }],
  });

  assert.equal(await adapter.pause(bindingId), true);
  assert.equal((await store.load()).workflowRuns[bindingId]?.status, "paused");
  assert.equal(await adapter.resume(bindingId), true);
  await adapter.wait(bindingId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const resumed = await store.load();
  assert.equal(resumed.workflowRuns[bindingId]?.status, "completed");
  assert.equal(resumed.workflowRuns[bindingId]?.phases[0]?.agents[0]?.model, "openai/gpt-actual");
});


test("stopping a run cannot be overwritten by its aborted promise", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-workflow-stop-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = await ProjectStore.open("/repo", { stateRoot });
  await store.transact((state) => {
    let next = addGoal(state, { id: "goal", title: "Goal", objective: "Review", successCriteria: [] }, new Date().toISOString());
    return addTodo(next, { id: "todo", goalId: "goal", title: "Review" }, new Date().toISOString());
  });
  const adapter = new DevflowWorkflowAdapter(new StopManager(), store, () => "openai/gpt-main", { fanout: "openai/gpt-small" });
  const bindingId = await adapter.start("todo", {
    name: "review", description: "Review", phases: [{ title: "Inspect", role: "work", prompts: ["Read code"] }],
  });
  assert.equal(await adapter.stop(bindingId), true);
  await adapter.wait(bindingId);
  assert.equal((await store.load()).workflowRuns[bindingId]?.status, "stopped");
});


test("concurrent runtimes reserve before starting so only one upstream Workflow launches", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-workflow-race-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const firstStore = await ProjectStore.open("/repo", { stateRoot });
  const secondStore = await ProjectStore.open("/repo", { stateRoot });
  await firstStore.transact((state) => {
    let next = addGoal(state, { id: "goal", ownerSessionId: "session", title: "Goal", objective: "Review", successCriteria: [] }, new Date().toISOString());
    return addTodo(next, { id: "todo", goalId: "goal", title: "Review" }, new Date().toISOString());
  });
  const manager = new HoldingManager();
  const first = new DevflowWorkflowAdapter(manager, firstStore, () => "main", {}, undefined, { sessionId: "session", runtimeId: "one" });
  const second = new DevflowWorkflowAdapter(manager, secondStore, () => "main", {}, undefined, { sessionId: "session", runtimeId: "two" });
  const plan = { name: "review", description: "Review", phases: [{ title: "Inspect", role: "work" as const, prompts: ["Read"] }] };

  const results = await Promise.allSettled([first.start("todo", plan), second.start("todo", plan)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(manager.starts, 1);
});


test("planned cancellation retries the running stop path when launch wins the CAS race", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-workflow-cancel-race-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = await ProjectStore.open("/repo", { stateRoot });
  await store.transact((state) => {
    let next = addGoal(state, { id: "goal", ownerSessionId: "session", title: "Goal", objective: "Review", successCriteria: [] }, new Date().toISOString());
    next = addTodo(next, { id: "todo", goalId: "goal", title: "Review" }, new Date().toISOString());
    return createWorkflowBinding(next, {
      bindingId: "binding", upstreamRunId: "run", todoId: "todo", ownerSessionId: "session", ownerRuntimeId: "runtime", status: "planned",
      phases: [{ title: "Inspect", role: "work" }],
    }, new Date().toISOString());
  });
  const manager = new FakeManager();
  let stops = 0;
  manager.stop = () => { stops += 1; return true; };
  const adapter = new DevflowWorkflowAdapter(manager, store, () => "main", {}, undefined, { sessionId: "session", runtimeId: "runtime" });
  const original = store.transact.bind(store);
  let injected = false;
  store.transact = async (mutator, options = {}) => {
    if (!injected && options.actor === "workflow:binding:cancel-planned") {
      injected = true;
      await original((state) => {
        const next = structuredClone(state);
        next.workflowRuns.binding!.status = "running";
        return next;
      }, { actor: "test:launch-won" });
    }
    return original(mutator, options);
  };

  assert.equal(await adapter.stop("binding"), true);
  assert.equal(stops, 1);
  assert.equal((await store.load()).workflowRuns.binding!.status, "stopped");
});


test("delayed lifecycle events cannot resurrect a stopped Workflow", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-workflow-delayed-event-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = await ProjectStore.open("/repo", { stateRoot });
  await store.transact((state) => {
    let next = addGoal(state, { id: "goal", title: "Goal", objective: "Review", successCriteria: [] }, new Date().toISOString());
    return addTodo(next, { id: "todo", goalId: "goal", title: "Review" }, new Date().toISOString());
  });
  const manager = new LifecycleManager();
  const adapter = new DevflowWorkflowAdapter(manager, store, () => "main", {});
  const bindingId = await adapter.start("todo", { name: "review", description: "Review", phases: [{ title: "Inspect", role: "work", prompts: ["read"] }] });

  assert.equal(await adapter.stop(bindingId), true);
  manager.emit("resumed", { runId: "lifecycle-run" });
  manager.emit("paused", { runId: "lifecycle-run" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal((await store.load()).workflowRuns[bindingId]!.status, "stopped");
  assert.equal((await store.load()).scheduler.activeLeases.todo, undefined);
});


test("a delayed paused echo cannot undo a successful resume", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-workflow-delayed-pause-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = await ProjectStore.open("/repo", { stateRoot });
  await store.transact((state) => {
    let next = addGoal(state, { id: "goal", title: "Goal", objective: "Review", successCriteria: [] }, new Date().toISOString());
    return addTodo(next, { id: "todo", goalId: "goal", title: "Review" }, new Date().toISOString());
  });
  const manager = new HoldingManager();
  const adapter = new DevflowWorkflowAdapter(manager, store, () => "main", {});
  const bindingId = await adapter.start("todo", { name: "review", description: "Review", phases: [{ title: "Inspect", role: "work", prompts: ["read"] }] });

  assert.equal(await adapter.pause(bindingId), true);
  assert.equal(await adapter.resume(bindingId), true);
  manager.emit("paused", { runId: "held-1" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = await store.load();
  assert.equal(state.workflowRuns[bindingId]!.status, "running");
  assert.equal(state.scheduler.activeLeases.todo?.mode, "workflow");
});
