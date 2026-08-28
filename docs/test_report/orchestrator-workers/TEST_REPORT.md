# 测试报告 — Orchestrator–Workers（主 Agent 编排子 Agent）

> 需求：支持用户创建主 Agent（编排者），关联多个 Agent Studio 子 Agent（Workers），
> 由主 Agent 自主编排子 Agent 协作完成复杂任务。
>
> 分支：`feat/orchestrator-workers`
> 测试日期：2026-08-28

## 1. 测试结论

**全部通过 ✅**。核心链路（创建编排者 → 关联 Workers → 编排运行 → 生成计划 → 启动 graph run）在隔离实例上端到端验证通过。

| 层 | 结果 |
|---|---|
| 后端类型检查（`tsc --noEmit`） | ✅ 0 错误 |
| 前端类型检查（`web/tsc --noEmit`） | ✅ 0 错误 |
| 构建（backend + web + agent-runner） | ✅ 全部 exit 0 |
| 单元测试（vitest） | ✅ 15/15 通过 |
| 运行时 API 冒烟（隔离实例 PORT=9910） | ✅ 全部通过 |

## 2. 单元测试（tests/orchestrator-plan.test.ts）

15 个用例全部通过：

| 分组 | 用例 | 覆盖点 |
|---|---|---|
| parseOrchestratorPlan | valid plain JSON | 正常解析 + 依赖排序 |
| | fenced json | markdown 代码块剥离 |
| | prose + json + prose | 前后文剥离（驱动修复了 `extractJson` 真实 bug）|
| | workerId not in linked set → null | 越权 worker 拒绝 |
| | dependsOn missing step → null | 依赖完整性 |
| | cyclic dependsOn → null | 环检测（DFS 三色）|
| | empty steps → null | 空计划拒绝 |
| | garbage → null | 非法输入 |
| | null input → null | 空输入 |
| buildFallbackPlan | chains in link order | 顺序兜底 + dependsOn 链 |
| | single worker no deps | 单 worker 无依赖 |
| assembleOrchestratorGraph | agent node agentDefId + goalAnchor | 复用 graph agent 执行路径 |
| | trailing acceptance gate | 验收 gate 节点 |
| | no criteria → gate no assertions | AC4.4 LLM-only gate |
| | unknown worker id throws | 组装失败防御 |

### 单元测试发现并修复的 bug

`orchestrator-plan.ts` 的 `extractJson`：先剥离前导 prose 后再计算 `lastIndexOf('}')`，否则前导 prose 场景下 `last` 索引在 `slice(first)` 后失效，导致 `JSON.parse` 失败。修复为「先 slice 前导 prose，再计算 `last`」。

## 3. 运行时 API 冒烟测试

隔离实例：`DEEPTHINK_DATA_DIR=~/.deepthink-9910 WEB_PORT=9910 node dist/index.js`（等价 `make start-prod`，跳过 Docker 镜像重建），全新数据目录 + `reset:admin` 种子 admin。

| 步骤 | 请求 | 期望 | 结果 |
|---|---|---|---|
| 登录 | POST /api/auth/login admin/88888888 | success=true | ✅ |
| 建 Worker1 | POST /api/paas/agents kind=assistant | `kind:"assistant"` | ✅ |
| 建 Worker2 | POST /api/paas/agents kind=assistant | `kind:"assistant"` | ✅ |
| 建编排者 | POST /api/paas/agents kind=orchestrator | `kind:"orchestrator"` | ✅ |
| 关联 Workers | PUT /:orch/workers [w1,w2] | 返回 2 workers | ✅ |
| 列出 Workers | GET /:orch/workers | 2 个按 position 排序 | ✅ |
| 自关联拒绝 | PUT /:orch/workers [orch] | HTTP 400 `Invalid worker ids` | ✅ |
| 编排运行 | POST /:orch/orchestrate | `{ok,runId,definitionId,plan}` | ✅ |

编排运行返回的 `plan`（LLM 真实拆解）：

```json
{
  "planName": "python-async-best-practices-report",
  "steps": [
    { "id": "step1", "workerId": "<调研员>", "task": "调研 asyncio 最佳实践…", "dependsOn": [] },
    { "id": "step2", "workerId": "<程序员>", "task": "编写并验证代码示例…", "dependsOn": ["step1"] },
    { "id": "step3", "workerId": "<程序员>", "task": "汇总撰写总结报告…", "dependsOn": ["step2"] }
  ]
}
```

服务端日志确认 run 已启动：

```
INFO Orchestrator run started  runId=graph-4e7010b1-...
INFO Graph run started        graphRunId=graph-4e7010b1-...  defId=orchestrator-python-async-best-practices-report
```

无 `graph execution failed` / `context build failed` 错误。

## 4. 验收标准对照

| AC | 描述 | 结果 |
|---|---|---|
| AC1.1 | Agent 支持 kind（assistant / orchestrator） | ✅ |
| AC2.1 | 编排者可关联多个子 Agent（多选） | ✅ |
| AC2.2 | 关联校验（非自身 / 非编排者 / 归属） | ✅ |
| AC3.1 | 编排运行拆解任务并分派给 Workers | ✅ |
| AC3.2 | LLM 计划非法时兜底（sequential fallback） | ✅（单测覆盖）|
| AC4.4 | 无验收标准时 gate 无断言 | ✅（单测覆盖）|
| AC5.1 | 前端类型选择 + Worker 选择器 + 编排入口 | ✅（类型检查通过）|

## 5. 环境备注

- 端口 9898 被桌面端实例占用（运行旧代码），冒烟测试改用 9910 + 全新数据目录，避开冲突且隔离验证。
- `make start-prod` 的 Docker 镜像重建在拉取 ghcr.io/astral-sh/uv 基镜像时网络卡死（0B/s）；镜像 `deepthink-agent:latest` 已存在，通过补建 `.docker-build-sentinel` / `.sandbox-docker-build-sentinel` 跳过重建，等价 `node dist/index.js` 直跑完成验证。
