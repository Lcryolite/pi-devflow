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
