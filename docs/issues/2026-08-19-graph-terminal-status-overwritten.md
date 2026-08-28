# Graph 终态被状态持久化覆盖

- **日期**：2026-08-19
- **影响范围**：Graph Engineering / Super Agent Team
- **严重度**：P1
- **状态**：已修复

## 问题现象

Graph 执行到 human 节点后，节点记录为 `paused`，但 run 最终仍显示为
`running`，导致审批接口以 “Run not paused” 拒绝提交。节点执行失败时也会出现
同样的问题：失败原因已经写入，但 run 状态又变回 `running`。

## 根因

`executeGraph()` 在 human、节点失败和 orchestrator 异常分支中，先通过
`updateGraphRunStatus()` 写入 `paused` 或 `failed`，随后调用 `persistState()`。
修复前的 `persistState()` 为了保存 `state_json`，无条件调用：

```ts
updateGraphRunStatus(runId, 'running', { stateJson: JSON.stringify(state) });
```

因此刚写入的生命周期终态会被覆盖。已有审批测试手工构造 `paused` run，没有经过
真实 `executeGraph()`，所以未能发现该回归。

## 修复方案

新增只更新 `graph_runs.state_json` 的 `updateGraphRunState()`，并让
`persistState()` 使用该方法。状态 checkpoint 与生命周期状态更新由此解耦，保存
共享 state 不再改变 `paused`、`failed` 或并发写入的其他状态。

没有采用“读取当前状态再写回”的方案，因为 read-then-write 会在并发暂停或取消时
产生竞态，仍可能覆盖更新后的状态。

## 回归测试

`tests/graph-terminal-state.test.ts` 使用临时 SQLite 数据库，真实执行 orchestrator、
runner 和 scheduler，仅 mock 外部 Agent 进程，覆盖：

1. human 节点执行后 run 保持 `paused`，可成功提交审批并恢复到 `completed`；
2. Agent 节点失败后 run 保持 `failed`，失败原因和 state checkpoint 均保留。

运行：

```bash
npx vitest run tests/graph-terminal-state.test.ts
```
