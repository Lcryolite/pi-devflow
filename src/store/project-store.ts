import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { validateProject } from "../domain/invariants.js";
import { migrateProjectState } from "../domain/migrations.js";
import { createProjectState, reconcileProject } from "../domain/state.js";
import type { ProjectState } from "../domain/types.js";
import { appendProjectEvent, readLatestJournalState } from "./journal.js";
import { ProjectLock } from "./project-lock.js";

export interface ProjectStoreOptions {
  stateRoot?: string;
  clock?: () => string;
}

export interface TransactionOptions {
  actor?: string;
  signal?: AbortSignal;
}

interface SnapshotCandidate {
  exists: boolean;
  state?: ProjectState;
  error?: unknown;
}


function semanticState(state: ProjectState): string {
  const comparable = structuredClone(state);
  comparable.revision = 0;
  comparable.project.updatedAt = "";
  for (const goal of Object.values(comparable.goals)) goal.updatedAt = "";
  for (const todo of Object.values(comparable.todos)) todo.updatedAt = "";
  return JSON.stringify(comparable);
}

export class ProjectStore {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly stateDirectory: string;
  readonly snapshotPath: string;
  readonly journalPath: string;
  readonly lockPath: string;
  private readonly clock: () => string;
  private state: ProjectState;
  private readonly listeners = new Set<(state: ProjectState) => void>();

  private constructor(state: ProjectState, stateRoot: string, clock: () => string) {
    this.state = state;
    this.projectRoot = state.project.root;
    this.projectId = state.project.id;
    this.stateDirectory = join(stateRoot, state.project.id);
    this.snapshotPath = join(this.stateDirectory, "state.json");
    this.journalPath = join(this.stateDirectory, "events.jsonl");
    this.lockPath = join(this.stateDirectory, "lock");
    this.clock = clock;
  }

  static async open(projectRoot: string, options: ProjectStoreOptions = {}): Promise<ProjectStore> {
    const resolvedRoot = resolve(projectRoot);
    let root = resolvedRoot;
    try {
      root = await realpath(resolvedRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const clock = options.clock ?? (() => new Date().toISOString());
    const initial = createProjectState(root, clock());
    const stateRoot = options.stateRoot ?? join(homedir(), ".pi", "agent", "devflow", "projects");
    const store = new ProjectStore(initial, stateRoot, clock);
    await mkdir(store.stateDirectory, { recursive: true });
    store.state = await store.recoverLatest(initial);
    return store;
  }

  async load(): Promise<ProjectState> {
    return this.refresh();
  }

  async refresh(): Promise<ProjectState> {
    this.state = await this.recoverLatest(this.state);
    return structuredClone(this.state);
  }

  subscribe(listener: (state: ProjectState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async transact(
    mutator: (state: ProjectState) => ProjectState,
    options: TransactionOptions = {},
  ): Promise<ProjectState> {
    const lock = await ProjectLock.acquire(this.lockPath, options.signal ? { signal: options.signal } : {});
    try {
      const current = await this.recoverLatest(this.state);
      const now = this.clock();
      let next = mutator(structuredClone(current));
      next = reconcileProject(next, now);
      validateProject(next);
      if (semanticState(next) === semanticState(current)) {
        this.state = current;
        return structuredClone(current);
      }
      next.revision = current.revision + 1;
      next.project.updatedAt = now;
      await appendProjectEvent(this.journalPath, {
        eventId: randomUUID(),
        revision: next.revision,
        timestamp: now,
        actor: options.actor ?? "extension",
        state: next,
      });
      await this.writeAtomic(next);
      this.state = next;
      const snapshot = structuredClone(next);
      for (const listener of this.listeners) listener(structuredClone(snapshot));
      return snapshot;
    } finally {
      await lock.release();
    }
  }

  private async readSnapshot(): Promise<SnapshotCandidate> {
    try {
      const parsed = migrateProjectState(JSON.parse(await readFile(this.snapshotPath, "utf8")), this.clock());
      if (parsed.project.root !== this.projectRoot) throw new Error(`Project state root mismatch for ${this.projectRoot}`);
      validateProject(parsed);
      return { exists: true, state: parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      return { exists: true, error };
    }
  }

  private async recoverLatest(fallback: ProjectState): Promise<ProjectState> {
    const snapshot = await this.readSnapshot();
    let journal: ProjectState | undefined;
    let journalError: unknown;
    try {
      journal = await readLatestJournalState(this.journalPath);
    } catch (error) {
      journalError = error;
    }

    const candidates = [snapshot.state, journal].filter((state): state is ProjectState => state !== undefined);
    if (candidates.length > 0) {
      const latest = candidates.reduce((left, right) => right.revision > left.revision ? right : left);
      return structuredClone(latest);
    }
    if (snapshot.exists) throw new Error("Unable to recover project state", { cause: snapshot.error ?? journalError });
    if (journalError) throw journalError;
    return structuredClone(fallback);
  }

  private async writeAtomic(state: ProjectState): Promise<void> {
    await mkdir(dirname(this.snapshotPath), { recursive: true });
    const tempPath = `${this.snapshotPath}.${randomUUID()}.tmp`;
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, this.snapshotPath);
    if (process.platform !== "win32") {
      const directory = await open(dirname(this.snapshotPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
  }
  }
}
