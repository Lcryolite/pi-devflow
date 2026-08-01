import { LEGACY_UNOWNED_SESSION, type Evidence, type ProjectState } from "./types.js";

export function migrateProjectState(value: unknown, now = new Date().toISOString()): ProjectState {
  if (!value || typeof value !== "object") throw new Error("Project state must be an object");
  const source = structuredClone(value) as Record<string, any>;
  const version = source.schemaVersion;

  if (version === 3) {
    const state = source as ProjectState;
    state.evidence ??= {};
    state.appliedProposalIds ??= [];
    state.migrations ??= {};
    state.scheduler.maxConcurrentMain ??= 1;
    state.scheduler.maxConcurrentWorkflow ??= 2;
    state.scheduler.grill ??= { lastAskedBlockerKeys: {} };
    state.scheduler.grill.lastAskedBlockerKeys ??= {};
    state.scheduler.sessionPaused ??= {};
    state.scheduler.continuationKeys ??= {};
    state.scheduler.activeLeases ??= {};
    for (const goal of Object.values(state.goals)) goal.ownerSessionId ??= LEGACY_UNOWNED_SESSION;
    for (const evidence of Object.values(state.evidence)) evidence.ownerSessionId ??= LEGACY_UNOWNED_SESSION;
    for (const todo of Object.values(state.todos)) {
      todo.resourceClaims ??= [];
      todo.systemManaged ??= false;
      todo.executionGeneration ??= 0;
    }
    return state;
  }

  if (version === 2) {
    source.schemaVersion = 3;
    source.evidence ??= {};
    source.appliedProposalIds ??= [];
    source.migrations ??= {};
    source.scheduler.maxConcurrentMain ??= 1;
    source.scheduler.maxConcurrentWorkflow ??= 2;
    source.scheduler.grill ??= {};
    source.scheduler.grill.lastAskedBlockerKeys ??= {};
    source.scheduler.sessionPaused ??= {};
    source.scheduler.continuationKeys ??= {};
    source.scheduler.activeLeases ??= {};
    for (const goal of Object.values(source.goals ?? {}) as Array<Record<string, any>>) {
      goal.ownerSessionId ??= LEGACY_UNOWNED_SESSION;
    }
    for (const evidence of Object.values(source.evidence ?? {}) as Array<Record<string, any>>) {
      evidence.ownerSessionId ??= LEGACY_UNOWNED_SESSION;
    }
    for (const todo of Object.values(source.todos ?? {}) as Array<Record<string, any>>) {
      todo.resourceClaims ??= [];
      todo.systemManaged ??= false;
      todo.executionGeneration ??= 0;
    }
    for (const record of Object.values(source.scheduler.continuationKeys) as Array<Record<string, any>>) {
      record.ownerSessionId ??= LEGACY_UNOWNED_SESSION;
      record.ownerRuntimeId ??= LEGACY_UNOWNED_SESSION;
      if (record.status === "reserved" || record.status === "sent") record.status = "expired";
    }
    for (const binding of Object.values(source.workflowRuns ?? {}) as Array<Record<string, any>>) {
      binding.ownerSessionId ??= LEGACY_UNOWNED_SESSION;
      binding.ownerRuntimeId ??= LEGACY_UNOWNED_SESSION;
      if (!["planned", "running", "paused"].includes(binding.status)) continue;
      binding.status = "stopped";
      binding.endedAt = now;
      const phaseIds = new Set<string>((binding.phases ?? []).map((phase: Record<string, any>) => phase.todoId));
      for (const phaseId of phaseIds) {
        const phaseTodo = source.todos?.[phaseId];
        if (!phaseTodo) continue;
        if (phaseTodo.status !== "completed") phaseTodo.status = "cancelled";
        delete phaseTodo.parentId;
        phaseTodo.updatedAt = now;
      }
      const parent = source.todos?.[binding.todoId];
      if (!parent) continue;
      parent.childIds = (parent.childIds ?? []).filter((id: string) => !phaseIds.has(id));
      delete parent.workflowRunId;
      parent.status = "blocked";
      parent.blocker = {
        kind: "workflow",
        reason: "Legacy Workflow was quarantined during the session-isolation upgrade",
        recommendedAnswer: "Adopt this Goal, then retry with a fresh Workflow",
        sourceIds: [binding.upstreamRunId],
      };
      parent.updatedAt = now;
    }
    for (const [todoId, lease] of Object.entries(source.scheduler.activeLeases) as Array<[string, Record<string, any>]>) {
      lease.ownerSessionId ??= LEGACY_UNOWNED_SESSION;
      lease.ownerRuntimeId ??= LEGACY_UNOWNED_SESSION;
      const todo = source.todos?.[lease.todoId];
      if (lease.mode === "main" && todo?.status === "in_progress") {
        todo.status = "blocked";
        todo.blocker = {
          kind: "tool",
          reason: "Legacy execution was interrupted by the session-isolation upgrade",
          recommendedAnswer: "Adopt this Goal, then retry with a fresh strategy",
          sourceIds: [lease.id],
        };
      }
      delete source.scheduler.activeLeases[todoId];
    }
    source.migrations["schema-v2-to-v3"] = {
      id: "schema-v2-to-v3",
      source: "schema-v2",
      sourceIds: [],
      appliedAt: now,
      warnings: ["Existing Goals were quarantined as legacy-unowned; adopt them explicitly before execution."],
    };
    return migrateProjectState(source, now);
  }

  if (version !== 1) throw new Error(`Unsupported schema version ${String(version)}`);
  const legacy = source;
  const evidence: Record<string, Evidence> = {};
  for (const goal of Object.values(legacy.goals ?? {}) as Array<Record<string, any>>) {
    for (const criterion of goal.successCriteria ?? []) {
      for (const evidenceId of criterion.evidenceIds ?? []) {
        evidence[evidenceId] ??= {
          id: evidenceId,
          ownerSessionId: LEGACY_UNOWNED_SESSION,
          kind: "legacy",
          summary: `Migrated evidence reference ${evidenceId}`,
          observedAt: now,
          valid: true,
        };
      }
    }
  }
  legacy.schemaVersion = 2;
  legacy.evidence = evidence;
  legacy.scheduler = {
    paused: legacy.scheduler?.paused ?? false,
    maxConcurrentMain: 1,
    maxConcurrentWorkflow: 2,
    grill: legacy.scheduler?.grill ?? {},
    continuationKeys: {},
    activeLeases: {},
  };
  legacy.appliedProposalIds = [];
  legacy.migrations = {
    "schema-v1-to-v2": {
      id: "schema-v1-to-v2",
      source: "schema-v1",
      sourceIds: [],
      appliedAt: now,
      warnings: [],
    },
  };
  return migrateProjectState(legacy, now);
}
