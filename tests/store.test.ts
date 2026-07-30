import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addGoal, ProjectStore } from "../src/index.js";
import { ProjectLock } from "../src/store/project-lock.js";

test("project state survives a new store instance", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const clock = () => "2026-07-30T00:00:00.000Z";

  const first = await ProjectStore.open("/repo", { stateRoot, clock });
  const saved = await first.transact((state) => addGoal(state, {
    id: "goal-1",
    title: "Persist me",
    objective: "Survive restart",
    successCriteria: [],
  }, clock()));

  const second = await ProjectStore.open("/repo", { stateRoot, clock });
  const restored = await second.load();
  const snapshot = JSON.parse(await readFile(first.snapshotPath, "utf8")) as { revision: number };

  assert.equal(saved.revision, 1);
  assert.equal(restored.goals["goal-1"]?.title, "Persist me");
  assert.equal(snapshot.revision, 1);
});


test("concurrent stores preserve both committed mutations", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-concurrent-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const clock = () => new Date().toISOString();
  const first = await ProjectStore.open("/repo", { stateRoot, clock });
  const second = await ProjectStore.open("/repo", { stateRoot, clock });

  await Promise.all([
    first.transact((state) => addGoal(state, {
      id: "goal-a", title: "A", objective: "A", successCriteria: [],
    }, clock()), { actor: "first" }),
    second.transact((state) => addGoal(state, {
      id: "goal-b", title: "B", objective: "B", successCriteria: [],
    }, clock()), { actor: "second" }),
  ]);

  const restored = await (await ProjectStore.open("/repo", { stateRoot, clock })).load();
  assert.deepEqual(Object.keys(restored.goals).sort(), ["goal-a", "goal-b"]);
  assert.equal(restored.revision, 2);
});

test("a corrupt snapshot recovers from the journal", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-recovery-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const clock = () => "2026-07-30T00:00:00.000Z";
  const store = await ProjectStore.open("/repo", { stateRoot, clock });
  await store.transact((state) => addGoal(state, {
    id: "goal-1", title: "Recovered", objective: "Recover me", successCriteria: [],
  }, clock()), { actor: "test" });
  await writeFile(store.snapshotPath, "{broken", "utf8");

  const recovered = await (await ProjectStore.open("/repo", { stateRoot, clock })).load();

  assert.equal(recovered.goals["goal-1"]?.title, "Recovered");
  assert.equal(recovered.revision, 1);
});


test("an abandoned lock directory without owner metadata is reclaimed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-devflow-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "lock");
  await mkdir(lockPath);
  const old = new Date(Date.now() - 10_000);
  await utimes(lockPath, old, old);
  const lock = await ProjectLock.acquire(lockPath, { timeoutMs: 2_000, pollMs: 10 });
  await lock.release();
});


test("semantic no-op transactions do not write a revision or notify subscribers", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-devflow-noop-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = await ProjectStore.open("/repo", { stateRoot });
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const result = await store.transact((state) => state, { actor: "test:no-op" });
  assert.equal(result.revision, 0);
  assert.equal(notifications, 0);
});
