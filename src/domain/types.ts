export type GoalStatus = "active" | "blocked" | "completed" | "cancelled";
export type TodoStatus = "pending" | "ready" | "in_progress" | "blocked" | "completed" | "cancelled";
export type ExecutionMode = "main" | "workflow" | "undecided";
export type ModelRole = "fanout" | "work" | "judge";

export const LEGACY_UNOWNED_SESSION = "legacy-unowned";

export interface ExecutionScope {
  sessionId: string;
  runtimeId: string;
}

export interface SuccessCriterion {
  id: string;
  text: string;
  required: boolean;
  evidenceIds: string[];
  requiresJudge?: boolean;
}

export interface Evidence {
  id: string;
  ownerSessionId: string;
  kind: "test" | "file" | "command" | "review" | "workflow" | "user" | "legacy";
  summary: string;
  locator?: string;
  goalId?: string;
  todoId?: string;
  observedAt: string;
  valid: boolean;
}

export interface Blocker {
  kind: "dependency" | "resource" | "decision" | "permission" | "tool" | "validation" | "workflow";
  reason: string;
  unlockCondition?: string;
  recommendedAnswer?: string;
  sourceIds: string[];
}

export interface Attempt {
  index: number;
  strategy: string;
  evidenceIds: string[];
  outcome: "succeeded" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
}

export interface ResourceClaim {
  key: string;
  mode: "read" | "write" | "exclusive";
}

export interface ExecutionProfile {
  independentUnits: number;
  hasSequentialDependency: boolean;
  writeScope: "none" | "known-disjoint" | "shared" | "unknown";
  mergeableResults: boolean;
  estimatedUnits: number;
}

export interface WorkflowPlanData {
  name: string;
  description: string;
  phases: Array<{ title: string; role: ModelRole; prompts: string[]; escalateJudge?: boolean }>;
}

export interface Goal {
  id: string;
  ownerSessionId: string;
  title: string;
  objective: string;
  successCriteria: SuccessCriterion[];
  constraints: string[];
  nonGoals: string[];
  evidenceRequirements: string[];
  status: GoalStatus;
  dependsOn: string[];
  rootTodoIds: string[];
  sourceRequest?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface Todo {
  id: string;
  goalId: string;
  parentId?: string;
  title: string;
  description?: string;
  status: TodoStatus;
  required: boolean;
  dependsOn: string[];
  childIds: string[];
  execution: ExecutionMode;
  executionProfile?: ExecutionProfile;
  workflowPlan?: WorkflowPlanData;
  workflowRunId?: string;
  origin?: { kind: "workflow-phase"; bindingId: string; phaseTitle: string };
  resourceClaims: ResourceClaim[];
  systemManaged: boolean;
  executionGeneration: number;
  sourceRequest?: string;
  attempts: Attempt[];
  blocker?: Blocker;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkflowAgentProjection {
  callId: string;
  label: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  model?: string;
  modelConfirmed: boolean;
  error?: string;
  resultPreview?: string;
}

export interface WorkflowPhaseProjection {
  id: string;
  title: string;
  role: ModelRole;
  todoId: string;
  requestedModel?: string;
  actualModels: string[];
  agentTotal: number;
  agentCompleted: number;
  agents: WorkflowAgentProjection[];
}

export interface WorkflowBinding {
  id: string;
  todoId: string;
  upstreamRunId: string;
  ownerSessionId: string;
  ownerRuntimeId: string;
  status: "planned" | "running" | "paused" | "completed" | "failed" | "stopped";
  phases: WorkflowPhaseProjection[];
  lastSnapshotSequence: number;
  startedAt?: string;
  currentPhaseTitle?: string;
  lastProgressAt?: string;
  lastAction?: string;
  endedAt?: string;
}

export interface ContinuationRecord {
  key: string;
  todoId: string;
  revision: number;
  ownerSessionId: string;
  ownerRuntimeId: string;
  status: "reserved" | "sent" | "claimed" | "expired";
  createdAt: string;
}

export interface ExecutionLease {
  id: string;
  todoId: string;
  goalId: string;
  mode: ExecutionMode;
  ownerSessionId: string;
  ownerRuntimeId: string;
  resourceClaims: ResourceClaim[];
  acquiredAt: string;
}

export interface MigrationRecord {
  id: string;
  source: string;
  sourceIds: string[];
  appliedAt: string;
  warnings: string[];
}

export interface ProjectState {
  schemaVersion: 3;
  revision: number;
  project: { id: string; root: string; createdAt: string; updatedAt: string };
  goals: Record<string, Goal>;
  todos: Record<string, Todo>;
  evidence: Record<string, Evidence>;
  workflowRuns: Record<string, WorkflowBinding>;
  locks: Record<string, never>;
  scheduler: {
    paused: boolean;
    maxConcurrentMain: number;
    maxConcurrentWorkflow: number;
    grill: { lastAskedBlockerKey?: string; lastAskedBlockerKeys: Record<string, string> };
    sessionPaused: Record<string, boolean>;
    continuationKeys: Record<string, ContinuationRecord>;
    activeLeases: Record<string, ExecutionLease>;
  };
  appliedProposalIds: string[];
  migrations: Record<string, MigrationRecord>;
}

export interface AddGoalInput {
  id: string;
  ownerSessionId?: string;
  title: string;
  objective: string;
  successCriteria: SuccessCriterion[];
  constraints?: string[];
  nonGoals?: string[];
  evidenceRequirements?: string[];
  dependsOn?: string[];
  sourceRequest?: string;
}

export interface AddTodoInput {
  id: string;
  goalId: string;
  parentId?: string;
  title: string;
  description?: string;
  required?: boolean;
  dependsOn?: string[];
  execution?: ExecutionMode;
  executionProfile?: ExecutionProfile;
  workflowPlan?: WorkflowPlanData;
  resourceClaims?: ResourceClaim[];
  systemManaged?: boolean;
  sourceRequest?: string;
}
