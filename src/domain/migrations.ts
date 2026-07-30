import type { Evidence, ProjectState } from "./types.js";

export function migrateProjectState(value: unknown, now = new Date().toISOString()): ProjectState {
  if (!value || typeof value !== "object") throw new Error("Project state must be an object");
  const source = structuredClone(value) as Record<string, unknown>;
  const version = source.schemaVersion;
  if (version === 2) {
    const state = source as unknown as ProjectState;
    state.evidence ??= {};
    state.appliedProposalIds ??= [];
    state.migrations ??= {};
    state.scheduler.maxConcurrentMain ??= 1;
    state.scheduler.maxConcurrentWorkflow ??= 2;
    state.scheduler.grill ??= {};
    state.scheduler.continuationKeys ??= {};
    state.scheduler.activeLeases ??= {};
    for (const todo of Object.values(state.todos)) {
      todo.resourceClaims ??= [];
      todo.systemManaged ??= false;
      todo.executionGeneration ??= 0;
    }
    return state;
  }
  if (version !== 1) throw new Error(`Unsupported schema version ${String(version)}`);

  const legacy = source as unknown as Omit<ProjectState, "schemaVersion" | "evidence" | "appliedProposalIds" | "migrations"> & {
    schemaVersion: 1;
    evidence?: Record<string, Evidence>;
    scheduler: { paused: boolean; grill?: { lastAskedBlockerKey?: string } };
  };
  const evidence: Record<string, Evidence> = {};
  for (const goal of Object.values(legacy.goals)) {
    for (const criterion of goal.successCriteria) {
      for (const evidenceId of criterion.evidenceIds) {
        evidence[evidenceId] ??= {
          id: evidenceId,
          kind: "legacy",
          summary: `Migrated evidence reference ${evidenceId}`,
          observedAt: now,
          valid: true,
        };
      }
    }
  }
  for (const todo of Object.values(legacy.todos)) {
    todo.resourceClaims ??= [];
    todo.systemManaged ??= false;
    todo.executionGeneration ??= 0;
  }

  return {
    ...(legacy as unknown as ProjectState),
    schemaVersion: 2,
    evidence,
    scheduler: {
      paused: legacy.scheduler.paused,
      maxConcurrentMain: 1,
      maxConcurrentWorkflow: 2,
      grill: legacy.scheduler.grill ?? {},
      continuationKeys: {},
      activeLeases: {},
    },
    appliedProposalIds: [],
    migrations: {
      "schema-v1-to-v2": {
        id: "schema-v1-to-v2",
        source: "schema-v1",
        sourceIds: [],
        appliedAt: now,
        warnings: [],
      },
    },
  };
}
