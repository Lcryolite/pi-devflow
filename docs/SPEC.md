# pi-devflow 完整规格

> 状态：Draft 1.0  
> 目标仓库：`/home/lknife/git/pi-devflow`  
> 分发方式：GitHub Pi package，支持 `pi install git:github.com/<owner>/pi-devflow@<ref>`  
> 主入口：`/devflow`

## 1. 产品定义

`pi-devflow` 是面向 Pi 的开发任务控制层。它把按需需求澄清、长期 Goal、层级 Todo、依赖调度和多 Agent Workflow 放进同一套项目状态中。

它解决四个具体问题：

1. Goal 只有一句 objective，缺少清晰的完成契约。
2. 一个任务卡住后，整个 Goal 停摆，其他独立任务也不再执行。
3. Todo 没有子 Todo，也不能展开查看任务细节和 Workflow 进度。
4. Workflow 使用的实际模型不透明，也没有统一、简单的模型路由规则。

## 2. 已确认的产品决策

以下内容是本规格的固定约束：

- 项目名称为 `pi-devflow`，主命令为 `/devflow`。
- 代码托管在 GitHub，先支持 Git 安装，不要求首版发布 npm。
- Goal 与 Todo 使用一套新的共享状态模型，不继续叠加 `pi-codex-goal` 与 `rpiv-todo` 的独立状态。
- `grill-me` 作为按需策略融入 Skill，不复制成常驻问卷状态机。
- `pi-dynamic-workflows` 优先通过公开导出和适配层接入；只有公开接口不足时才维护最小 Fork。
- Goal 明确时零提问；存在影响执行的歧义时才启动 Grill，并且一次只问一个问题。
- Goal 创建后自动开始执行，不设置 Goal/Plan 人工批准门。Pi 原有权限、安全确认和项目信任机制不被绕过。
- Todo 支持子 Todo；父 Todo 在所有必需子项完成后自动完成。
- Workflow 的阶段映射为子 Todo；具体 Agent 只显示在阶段展开详情中。
- Workflow 使用中央调控模型加 `fanout`、`work`、`judge` 三种阶段角色；small/medium/big 可通过 `/devflow-models` 交互配置。
- 多个 Goal 可以并存；只有无语义依赖且无资源冲突的工作才并行。
- 没有独立交付价值的“虚假 Goal”自动降级为现有 Goal 的 Todo。
- 项目状态跨 Pi 会话持久化，重新进入项目后恢复。

## 3. 目标与非目标

### 3.1 目标

- 建立可验证的 Goal 完成契约。
- 保证局部阻塞不会导致无关工作停摆。
- 用简洁的树形 Todo 呈现任务、子任务和 Workflow 阶段。
- 自动判断主 Agent 执行还是 Workflow 执行。
- 让每个 Workflow 阶段使用的实际模型可见。
- 支持多个 Goal 的语义依赖、资源冲突和安全并行。
- 进程退出、`/reload`、会话切换后可恢复。
- TUI、RPC、print、JSON 模式都保持可用；非 TUI 模式不依赖交互组件。

### 3.2 非目标

- 首版不提供通用项目管理系统、看板、日历、工时和团队权限。
- 不把每个 Workflow Agent 都变成顶层 Todo。
- 不实现复杂的动态成本优化器或不可解释的模型评分器。
- 不绕过 Pi 的工具权限、项目信任、沙箱或危险操作确认。
- 不保证不同设备间同步运行状态；GitHub 用于安装代码，不用于同步本地任务状态。
- Phase 1 不实现完整交互 TUI，也不启动真实 Workflow。

## 4. 核心术语

- **Goal**：具有独立交付价值的完成契约。
- **Todo**：完成 Goal 所需的可执行工作项，可以形成树和 DAG。
- **虚假 Goal**：取消其前置 Goal 后便无法独立产生价值的请求，应合并为 Todo。
- **Ready**：依赖满足、未被资源锁阻塞、可以调度的 Todo。
- **Blocked**：当前无法推进，但不代表 Goal 失败或暂停。
- **Workflow binding**：Todo 与一次 Workflow run 的关联。
- **语义依赖**：B 的有效输入或价值依赖 A 的产物。
- **资源冲突**：多个任务同时写相同文件、工作树或独占资源。
- **完成证据**：证明成功标准已满足的文件、命令输出、测试结果或审计记录。

## 5. 总体架构

```text
用户输入
  │
  ▼
Intent/Grill Policy
  │  目标清晰：直接继续
  │  有阻塞性歧义：一次问一个问题
  ▼
Goal Normalizer
  │  新 Goal / 合并到已有 Goal / 跨 Goal 依赖
  ▼
Project State Store
  ├─ Goals
  ├─ Todo trees + dependency edges
  ├─ Evidence
  ├─ Resource locks
  └─ Workflow bindings
  │
  ▼
Central Scheduler
  ├─ Main-agent executor
  └─ Workflow adapter
       └─ pi-dynamic-workflows
  │
  ▼
TUI / tools / commands / continuation
```

建议模块边界：

```text
src/
├── extension.ts
├── domain/
│   ├── types.ts
│   ├── invariants.ts
│   ├── transitions.ts
│   ├── goal-normalizer.ts
│   └── selectors.ts
├── store/
│   ├── paths.ts
│   ├── project-id.ts
│   ├── journal.ts
│   ├── snapshot.ts
│   └── store.ts
├── scheduler/
│   ├── ready.ts
│   ├── blockers.ts
│   ├── conflicts.ts
│   ├── retry-policy.ts
│   └── scheduler.ts
├── workflow/
│   ├── adapter.ts
│   ├── model-router.ts
│   └── phase-projection.ts
├── pi/
│   ├── tools.ts
│   ├── commands.ts
│   ├── lifecycle.ts
│   └── continuation.ts
└── ui/
    ├── tree-model.ts
    ├── widget.ts
    └── panel.ts
```

## 6. 领域模型

### 6.1 ProjectState

```typescript
interface ProjectState {
  schemaVersion: 1;
  revision: number;
  project: {
    id: string;
    root: string;
    createdAt: string;
    updatedAt: string;
  };
  goals: Record<GoalId, Goal>;
  todos: Record<TodoId, Todo>;
  workflowRuns: Record<WorkflowRunId, WorkflowBinding>;
  locks: Record<ResourceKey, ResourceLock>;
  scheduler: SchedulerState;
}
```

`revision` 每次成功事务递增，用于幂等、并发写入和恢复。

### 6.2 Goal

```typescript
interface Goal {
  id: GoalId;
  title: string;
  objective: string;
  successCriteria: SuccessCriterion[];
  constraints: string[];
  nonGoals: string[];
  evidenceRequirements: string[];
  status: "active" | "blocked" | "completed" | "cancelled";
  dependsOn: GoalId[];
  rootTodoIds: TodoId[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface SuccessCriterion {
  id: string;
  text: string;
  required: boolean;
  evidenceIds: string[];
}
```

规则：

- `completed` 仅在所有 required 成功标准都有有效证据时允许。
- `blocked` 是运行态，不是终止态。
- Goal 的依赖必须无环。
- Goal B 依赖 A 时，A 完成前 B 的 Todo 不得进入 Ready。
- Goal 被取消不自动取消其依赖 Goal；调度器重新评估并将无法满足的后继标记为 blocked。

### 6.3 Todo

主列表保持简单，内部模型只保留调度所需信息：

```typescript
interface Todo {
  id: TodoId;
  goalId: GoalId;
  parentId?: TodoId;
  title: string;
  description?: string;
  status: "pending" | "ready" | "in_progress" | "blocked" | "completed" | "cancelled";
  required: boolean;
  dependsOn: TodoId[];
  childIds: TodoId[];
  execution: "main" | "workflow" | "undecided";
  workflowRunId?: WorkflowRunId;
  attempts: Attempt[];
  blocker?: Blocker;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

这些字段不要求全部显示在默认 UI。默认只显示状态、编号、标题和必要的 Workflow/model 徽标。

### 6.4 Attempt 与 Blocker

```typescript
interface Attempt {
  index: number;
  strategy: string;
  evidenceIds: string[];
  outcome: "succeeded" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
}

interface Blocker {
  kind: "dependency" | "resource" | "decision" | "permission" | "tool" | "validation" | "workflow";
  reason: string;
  unlockCondition?: string;
  sourceIds: string[];
}
```

失败恢复最多自动执行两次。第二次必须使用新证据或不同策略；完全相同的重试不计为有效恢复并应被拒绝。

### 6.5 WorkflowBinding

```typescript
interface WorkflowBinding {
  id: WorkflowRunId;
  todoId: TodoId;
  upstreamRunId: string;
  status: "planned" | "running" | "paused" | "completed" | "failed" | "stopped";
  phases: WorkflowPhaseProjection[];
  startedAt?: string;
  endedAt?: string;
}

interface WorkflowPhaseProjection {
  id: string;
  title: string;
  role: "fanout" | "work" | "judge";
  todoId: TodoId;
  requestedModel?: string;
  actualModels: string[];
  agentTotal: number;
  agentCompleted: number;
}
```

Workflow 阶段投影为系统管理的子 Todo。Agent 不生成独立 Todo，只保存在阶段详情中。

## 7. Goal 归一化与语义依赖

每次收到新目标请求，先执行以下判断：

1. 它是否有可独立验证的交付结果？
2. 如果当前 Goal 被取消，它是否仍能独立完成并产生价值？
3. 它是否消费某个现有 Goal 的产物？
4. 它是否只是现有 Goal 的实现、审阅、测试或文档步骤？

决策：

```text
无独立价值
  → 合并为现有 Goal 的 Todo
有独立价值，但依赖现有产物
  → 创建 Goal，并添加 dependsOn
有独立价值且无依赖
  → 创建可并行 Goal
无法可靠判断
  → 启动 Grill，只问一个最关键问题
```

自动合并必须写入事件日志，并保留原始用户表述，方便审计和撤销。

## 8. Grill 策略

Grill 不是固定步骤，而是缺失信息处理策略。

### 8.1 触发条件

只有下列信息缺失且会改变执行路径时触发：

- 独立 Goal 与 Todo 无法区分；
- 成功标准无法判断；
- 关键范围存在互斥解释；
- 依赖关系无法判断；
- 缺少继续执行所必需的用户决定。

### 8.2 行为

- 每次只问一个问题。
- 每个问题附推荐答案。
- 能通过代码库、配置或文档确定的内容不得询问用户。
- 问题解决后立即重新评估，不预先抛出问题清单。
- 一旦足以安全规划就停止 Grill，并自动创建或更新 Goal。

### 8.3 非交互模式

在 print/JSON 模式中，若无法获得必要答案：

- Goal 保持 `active`；
- 运行态设为 `blocked`；
- 记录 `decision` blocker；
- 输出一个最关键问题；
- 不擅自选择高风险假设。

## 9. Todo 树与状态派生

### 9.1 编号

UI 编号按树路径派生：`#1`、`#1.1`、`#1.2`。内部 ID 使用稳定 UUID，移动节点不会改变引用。

### 9.2 父状态

- 所有 required 子项 completed：父项自动 completed。
- 任一子项 in_progress：父项为 in_progress。
- 没有运行或 Ready 子项，且至少一个 required 子项 blocked：父项为 blocked。
- 存在 Ready 子项：父项不得因兄弟项 blocked 而变成全局 blocked。
- optional 子项失败或取消不阻止父项完成。
- 父项取消时，默认递归取消尚未终止的系统管理子项；用户创建的独立子项需要显式处理。

### 9.3 依赖传播

Todo X blocked 只影响：

- 直接或传递依赖 X 的 Todo；
- X 的父级聚合状态；
- 对应成功标准。

它不得影响无依赖路径上的 Ready Todo。

## 10. 中央调度器

调度器在状态事务提交、Agent settled、Workflow 更新、权限结果和项目恢复后运行。

### 10.1 单次调度循环

1. 校验 Goal/Todo DAG 无环且引用有效。
2. 归档已终止运行和过期锁。
3. 根据 Goal 依赖更新候选 Todo。
4. 计算每个 Todo 的 dependency blocker。
5. 计算资源冲突和锁。
6. 将可运行 Todo 标记为 Ready。
7. 为 Ready Todo 选择 `main` 或 `workflow`。
8. 在并发上限内启动任务。
9. 若没有可运行任务，生成 blocked 摘要和一个解锁问题。
10. 提交新 revision；若无状态变化，不触发 continuation。

调度循环必须幂等。同一 revision 的相同输入不能重复启动任务。

### 10.2 自动恢复策略

任务失败后：

```text
第一次失败 → 根据证据生成不同恢复策略
第二次失败 → 最后一次差异化恢复
仍失败     → BLOCKED，继续其他 Ready 分支
```

只有下列情况不自动重试：用户取消、权限明确拒绝、不可逆操作需要新授权、策略完全重复，或继续可能扩大损失。

### 10.3 Goal blocked 条件

Goal 只有在以下条件同时成立时进入 blocked：

- 尚未完成；
- 没有 running Todo；
- 没有 Ready Todo；
- 所有 remaining required Todo 都被阻塞或依赖未完成 Goal。

Goal blocked 时仍保持可恢复，不自动转为 cancelled 或 completed。

### 10.4 多 Goal 并发

先判断语义依赖，再判断资源冲突。

可以并行：只读工作、修改确定不相交的路径、使用隔离 worktree 的 Workflow，或不共享独占资源的任务。

必须串行：修改相同文件或未知写入范围、共享工作树的写任务、Git 仓库级操作、相同部署环境/设备/数据库迁移，以及 B 语义依赖 A 的情况。

首版冲突策略宁可保守串行，不允许为了并发猜测写入范围。

### 10.5 执行方式选择

仅在以下条件全部满足时自动使用 Workflow：

- 至少两个工作单元可以独立执行；
- 聚合收益大于启动和整合成本；
- 结果可以通过汇总或验证阶段合并；
- 不存在无法隔离的写冲突。

单文件修改、顺序强依赖任务和低成本操作由主 Agent 执行。

## 11. Workflow 集成

### 11.1 集成方式

首选直接使用 `@quintinshaw/pi-dynamic-workflows` 的公开导出，例如 `WorkflowManager`、`createWorkflowTool`、`createWorkflowControlTool`、display 和 model-routing API，由 `pi-devflow` 创建并持有同一个 manager。不要同时加载上游完整 extension，以免重复注册 `workflow`、`workflow_control` 和 UI。

若当前公开事件无法提供实际模型或阶段更新，先向上游增加小型公开事件/快照接口；只有无法接受上游变更时才维护最小补丁分支。

### 11.2 进度投影

- Workflow 创建：绑定到一个 Todo。
- Workflow phase 创建：生成系统管理子 Todo。
- Agent start/end：只更新 phase 详情计数。
- Phase 完成：对应子 Todo completed。
- Workflow failed：对应 Todo 进入恢复策略，而不是立即终止整个 Goal。
- Workflow completed：进入结果整合或验证；不能绕过 Goal 完成审计。

### 11.3 模型路由

Workflow 脚本标记角色，不直接要求用户理解模型表：

```text
fanout → small 小模型
work   → medium 中模型
judge  → 中央调控模型；必要时升级 big 大模型
```

judge 升级仅在多个 Agent 结论冲突、验证失败、或涉及架构/安全/不可逆决策时发生。

用户可按 run、phase 或 agent 显式覆盖。优先级：

```text
用户显式覆盖
> Workflow 显式 model
> role 路由
> inherit 主模型
```

无可用映射时回退主模型，并在 UI 中显示实际模型。默认 UI 不展示冗长路由理由。

### 11.4 模型可见性

紧凑视图：

```text
◆ review-auth  4/5 agents · gpt-5.6
◆ audit-repo   8/12 agents · mixed
```

展开视图：

```text
▼ #2 审查认证模块                         [workflow]
  ├─ ✓ #2.1 并行检查                     gpt-5.6-mini
  ├─ ● #2.2 汇总结论                     gpt-5.6
  └─ ○ #2.3 最终验证                     inherit
```

显示 resolved actual model，而不仅是请求的 tier。发生 fallback 时使用短标记，例如 `gpt-5.6 (fallback)`。

## 12. 持久化与并发安全

### 12.1 存储位置

运行状态不提交到项目 Git。默认位置：

```text
~/.pi/agent/devflow/projects/<project-id>/
├── state.json
├── events.jsonl
├── lock/
└── workflows/
```

`project-id` 由 canonical project root 的 SHA-256 短摘要生成。`state.json` 同时保存 root，防止哈希碰撞和误绑定。

### 12.2 写入模型

- 所有修改通过 Store transaction。
- 使用原子创建 lock directory 获取跨进程锁。
- 写入时先追加事件，再写临时 snapshot，`fsync` 后 rename。
- 每个事件包含 eventId、revision、timestamp、actor 和 payload。
- 启动时校验 snapshot；损坏时从 events journal 重建。
- 旧锁只有在持有进程不存在且超过租约后才可回收。

### 12.3 会话与项目状态

项目状态是 canonical source。Pi session entry 只保存轻量引用和最近 revision，用于会话审计，不复制完整状态。

`session_start`、`session_tree`、`session_compact` 和 `/reload` 后重新加载项目状态。项目恢复不得自动重复启动已存在 lease 的任务。

### 12.4 Schema migration

- `schemaVersion` 必填。
- migration 必须是确定性纯函数。
- 迁移前保留备份。
- 不支持的未来版本以只读模式打开，禁止降级写入。

## 13. Pi 接口

### 13.1 Tools

Phase 1 提供两个工具，避免过大的单一 schema：

- `devflow_goal`：`create`、`list`、`get`、`update`、`complete`、`cancel`。
- `devflow_todo`：`create`、`list`、`get`、`update`、`move`、`retry`、`cancel`。

后续增加 `devflow_status`，返回当前项目 Goal、Ready、running、blocked 和 Workflow 摘要。

工具约束：

- 字符串枚举使用 `StringEnum`，兼容 Google API。
- 无效状态转换必须 throw，确保 Pi 标记 `isError`。
- `details` 返回 revision 和最小必要快照，默认文本输出保持简洁。
- 工具输出遵守 50KB/2000 行限制。
- 所有 mutation 使用 Store transaction。

### 13.2 Commands

```text
/devflow                 打开交互面板
/devflow status          显示紧凑状态
/devflow goal <id>       聚焦 Goal
/devflow todo <id>       聚焦 Todo
/devflow models          打开交互式中央/small/medium/big 模型编排器
/devflow-models          同上，作为独立 slash 命令便于发现
/devflow pause           暂停自动调度，不暂停状态更新
/devflow resume          恢复调度
/devflow doctor          检查状态、依赖、Workflow 适配和重复工具
```

Phase 1 只需实现 `/devflow status` 和 `/devflow doctor` 的文本版本；完整面板后续实现。

### 13.3 Lifecycle hooks

- `session_start`：解析项目根、加载状态、恢复 UI、运行一次 reconcile。
- `before_agent_start`：注入当前 Goal、running Todo 和必要调度规则，不注入完整历史。
- `tool_execution_end`：收集与活动 Todo 相关的证据引用。
- `agent_settled`：若有 Ready 工作且无 continuation，排队一次 follow-up。
- `session_shutdown`：释放进程资源和 lease；不删除项目状态。
- `model_select`：更新 inherit 模型显示和后续 Workflow 路由。

### 13.4 自动 continuation

使用 `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`。每条 continuation 带 `(projectId, revision, todoId)` 幂等键。

仅在 Agent 已 settled、存在 Ready Todo、没有同 revision continuation、调度未暂停且没有等待用户决定时触发。

## 14. TUI 规格

### 14.1 默认紧凑视图

```text
Devflow · 2 goals · 3 ready · 1 blocked
▼ #1 修复认证
  ├─ ✓ #1.1 定位问题
  ├─ ● #1.2 实现修复
  └─ ▶ #1.3 验证修复                  [workflow · 2/3 · mixed]
▶ #2 更新文档
```

默认最多显示有限行，优先显示 running、Ready、blocked。完成项可折叠。

### 14.2 交互面板

`/devflow` 打开 `ctx.ui.custom()` 面板：

- Up/Down：移动选择；
- Right/Enter：展开；
- Left：折叠或返回父级；
- `g`：聚焦 Goal；
- `r`：重试 blocked Todo；
- `p`：暂停/恢复调度；
- Escape：关闭。

树组件必须保证每行不超过宽度，使用 `truncateToWidth`，状态更新后调用 `invalidate()` 和 `tui.requestRender()`，主题变化时重建预着色内容，窄终端降级为单行状态。

### 14.3 Widget 与面板关系

动态 Widget 在无 ready/running/blocked 工作时不渲染；工作中默认仅占一行摘要。`Ctrl+Shift+D` 在普通 TUI 状态直接切换完整树与紧凑/隐藏态，不依赖 `/devflow`；`/devflow` 仅保留为可选的逐行管理面板。

### 14.4 非 TUI 模式

RPC/JSON/print 模式返回结构化文本或工具 details，不调用 `ctx.ui.custom()`。

## 15. 完成审计

Goal 不能因为 Todo 全部标记完成就直接完成。完成前必须：

1. 列出 required success criteria；
2. 为每项找到有效 evidence；
3. 检查 required Todo 无 unresolved blocker；
4. 检查跳过或取消项是否影响标准；
5. 必要时启动 judge 验证；
6. 只有全部通过才转为 completed。

最终状态：`DONE`、`PARTIAL`、`BLOCKED` 或 `CANCELLED`。

## 16. 安全与权限

- 自动开始 Goal 不等于自动授权工具。
- 不拦截或弱化 Pi 的 project trust。
- 不在 Skill 中指示模型绕过危险操作确认。
- 未知写入范围按冲突处理，不并行。
- Workflow worktree 合并必须经过验证阶段。
- 状态文件不得保存 API key、OAuth token、环境变量值或完整敏感工具输出。
- Workflow prompt/result 可能包含代码，应在 README 中说明本地持久化位置。

## 17. 可观测性

`/devflow status` 至少显示项目 ID 和 revision、Goal 状态、running/Ready/blocked Todo、当前 Workflow 阶段和实际模型、调度暂停状态、最近 blocker 和下一个计划动作。

`/devflow doctor` 检查状态 schema、Goal/Todo DAG、dangling references、stale locks、重复工具/命令注册、Workflow 依赖版本与公开 API，以及项目根识别。

## 18. 测试规格

### 18.1 Domain

- Goal 与 Todo DAG 拒绝环和悬空依赖。
- 虚假 Goal 合并规则。
- 父 Todo 自动完成。
- blocked 子项不阻塞独立兄弟项。
- optional 子项不阻止父完成。
- Goal 完成必须有 required evidence。
- 两次差异化恢复上限。

### 18.2 Scheduler

- 8 个 Todo 中 1 个 blocked，其他 7 个仍进入 Ready/运行。
- 只有后继依赖链被阻塞。
- 多 Goal 语义依赖优先于资源并行。
- 相同文件写冲突串行。
- 不同只读任务可并行。
- 重复 reconcile 不重复启动。
- 所有 remaining 项 blocked 时 Goal 进入 blocked。

### 18.3 Store

- 原子 snapshot 写入和恢复。
- revision 冲突。
- schema migration 与未来版本只读保护。
- 项目路径隔离。

### 18.4 Pi Extension

使用 fake ExtensionAPI 验证工具与命令注册、session_start 恢复、TUI/headless 分支、`/reload` 幂等和工具错误传播。

### 18.5 Workflow 适配

验证 phase 投影、Agent 详情计数、actual model、mixed、fallback，以及 Workflow failure 不停止整个 Goal。

### 18.6 Package smoke

```text
npm test
npm run typecheck
npm pack
pi -e ./src/extension.ts
pi install ./<tarball-or-local-path>
```

## 19. 兼容与迁移

- 默认不同时加载 `pi-codex-goal` 与 `rpiv-todo`，避免工具和 UI 重复。
- `/devflow doctor` 发现旧扩展时明确警告，不自动删除配置。
- 后续可提供一次性导入器；导入不是 Phase 1 要求。
- Workflow 包版本先使用兼容范围并在 lockfile 固定；公开 API 变化由 adapter 层吸收。

## 20. Phase 1 交付范围

Phase 1 必须交付：

1. TypeScript Pi package 脚手架和 Git 仓库；
2. 本规格和基础 README；
3. Goal、Todo、Blocker、ProjectState 类型；
4. 状态不变量和纯状态转换；
5. 层级 Todo 与父状态派生；
6. Goal/Todo DAG 校验；
7. Ready 计算和局部阻塞传播；
8. 项目级 JSON snapshot 持久化，采用原子写；
9. `devflow_goal`、`devflow_todo` 最小工具；
10. `/devflow status` 文本命令；
11. `devflow` Agent Skill 骨架；
12. 单元测试、typecheck 和 package manifest 验证。

Phase 1 不交付完整交互树、真实 Workflow 启动、多进程 journal/lease、自动 continuation、模型驱动 Goal 归一化和旧状态导入。

## 21. 后续阶段

### Phase 2：TUI 与恢复

交互树、展开箭头、快捷键、完整 journal、跨进程锁、blocker 面板和 Grill 接续。

### Phase 3：Workflow 适配

统一 WorkflowManager、phase-to-Todo 投影、Agent 详情、actual model 可见性和三角色路由。

### Phase 4：中央自动化

Goal 归一化、main/workflow 自动选择、多 Goal 资源调度、幂等 continuation 和完成审计。

### Phase 5：发布与迁移

旧状态导入、GitHub 安装文档、多平台 smoke、版本兼容矩阵和可选 npm 发布。

## 22. Phase 1 验收标准

Phase 1 完成必须同时满足：

- `npm test` 全部通过；
- `npm run typecheck` 通过；
- package manifest 的 extension/skill 路径存在；
- 可创建结构化 Goal；
- 可创建父子 Todo 和依赖边；
- 父 Todo可自动派生完成状态；
- 一个 Todo blocked 时，独立 Todo 仍被计算为 Ready；
- Goal/Todo 环被拒绝；
- 状态可写入项目专属 snapshot 并在新 Store 实例中恢复；
- `/devflow status` 能输出 Goal/Todo 摘要；
- 不包含完整 Workflow/TUI 的伪实现或无测试占位逻辑。
