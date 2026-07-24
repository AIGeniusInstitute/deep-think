# Agent 执行层稳定性 issue（agent 卡 running / docker 容器睡眠 / trace 不持久化）

## 1. 用户现象
超级 Agent 团队（Super Agent Team）执行视图 E2E：TeamPage 里发起的 graph 运行从不进入 completed；
graph_runs 表 16 条全 failed、曾出现 4 条卡 running；4 个 deepthink-agent 容器长时间睡眠（CPU 0%）；
执行视图的 trace 面板按 run 查询为空，但节点 output_summary 有值。

## 2. 问题描述
三个相互关联的缺陷，同源于 agent 执行层：
- graph 运行的 agent 节点 SDK query() 握手后永不产出 event，agent-runner 无 in-query 活体 watchdog，
  graph 路径又不写 IPC sentinel，只能等 30 分钟 containerTimeout → `executeGraph` 的 `Promise.all`
  永久阻塞 → graph_runs 卡 running。
- `runAgentNode` 丢弃 `runAgent` 返回的 ContainerOutput，无条件返回 `completed`，即便容器超时/错误也假完成。
- graph-runner 的 stream 回调只 `broadcastStreamEvent`，漏调 `persistTraceNodeFromStreamEvent`，
  trace_tool_calls / chat_trace_nodes 对 graph 运行始终为空。
- stream-processor 发 tool_use_start 不带 toolInput，即便接线后 input_json 仍空。

## 3. 根因
- `container/agent-runner/src/index.ts:1729` `for await (const message of q)` 永久阻塞；无 in-query watchdog
  （`POST_RESULT_TIMEOUT_MS` 仅在已收 result 后生效；sentinel 中断依赖 host 写 IPC 文件）。
- `src/graph-engineering/graph-runner.ts:322-359` `runAgentNode` 不检查 `runAgent` 返回值，恒返回 `completed`。
- `src/graph-engineering/graph-runner.ts:335-346` stream 回调无 `persistTraceNodeFromStreamEvent` 调用
  （IM 路径 `src/index.ts:3678` 有，graph 路径遗漏）。
- `container/agent-runner/src/stream-processor.ts:378-389` tool_use_start 事件不带 `toolInput` 字段。
- `src/graph-engineering/graph-orchestrator.ts:195` `Promise.all` 无 per-node 超时；阻塞时 completed/failed
  分支都够不到。

证据：DB 查询 `~/.config/DeepThink/data/db/messages.db`：graph_runs 16 failed / 0 completed；
trace_tool_calls 1589 行全 `graph_run_id=NULL`、`tool_name='unknown'`、chat_jid 全是 feishu 主群，
web:main（graph run 的 chat_jid）0 行；graph_node_runs 23 条（2 completed / 21 failed），有 summary 的
全是验收节点断言失败文本。

## 4. 复现路径
1. 启动后端（DATA_DIR=~/.config/DeepThink/data，端口 9898）+ 前端。
2. TeamPage 发起一个 super-agent-team 运行（含 agent 节点）。
3. 观察容器：`docker ps` / `ps aux | grep agent-runner` —— agent-runner 进程 CPU 0%，
   `for await` 卡住；graph_runs.status 停在 running，直到 30min containerTimeout 或进程重启
   （bootRecoverGraphRuns 翻成 failed）。
4. 查 trace：`SELECT count(*) FROM trace_tool_calls WHERE graph_run_id=<该 run>` → 0。

## 5. 诊断方法
```bash
# DB 状态
node -e 'const D=require("better-sqlite3");const d=new D("/home/me/.config/DeepThink/data/db/messages.db",{readonly:true});console.log(d.prepare("SELECT status,count(*)c FROM graph_runs GROUP BY status").all());console.log(d.prepare("SELECT count(*)c FROM trace_tool_calls WHERE graph_run_id IS NOT NULL").get());'
# 进程态
ps aux | grep agent-runner | grep -v grep
docker ps -a --filter name=deepthink-agent
```

## 6. 修复方案
- **agent-runner in-query 活体 watchdog**（`container/agent-runner/src/index.ts`）：
  init 后 `INACTIVITY_TIMEOUT_MS=600_000`（10min）无任何流式 event → `interruptQueryForShutdown` +
  `stalledDuringQuery=true` + `stream.end()`；runQuery 返回 `stalledDuringQuery`，主循环 `writeOutput(error)` +
  `forceExitWithSafetyNet(1)`。仅当 `containerInput.graphRunId` 非空（graph agent 节点）时启用，避免
  IM 人机交互（AskUserQuestion 等）误杀。解决"握手后无 event 永久阻塞"（pre-result 卡死）。
- **graph 单次运行退出**（`container/agent-runner/src/index.ts` 主循环尾部）：`containerInput.graphRunId`
  非空时，query 结束并完成 truncation-continue / memory flush / session update 后直接 `break` 退出主循环，
  不进入 `waitForIpcMessage()`。graph 路径 host 从不写 `_close/_drain` sentinel，进入 waitForIpcMessage 会
  永久阻塞至 30min containerTimeout（容器睡眠、CPU 0%、runContainerAgent promise 不 resolve、节点卡 running）。
  解决"成功结果后容器睡眠"（post-result 卡死）。
- **runAgentNode 返回值检查**（`graph-runner.ts`）：捕获 `runAgent` 的 ContainerOutput，
  `status==='error'||'closed'` → `outcome.status='failed'` + `error`。
- **trace 持久化接线**（`graph-runner.ts` stream 回调）：`persistTraceNodeFromStreamEvent(ctx.chatJid, streamed.streamEvent)`。
- **toolInput 补全**（`stream-processor.ts` tool_use_start）：emit 加 `toolInput: block.input as Record<string, unknown>`。

未改 `executeGraph` 的 `Promise.all`（watchdog 使容器必退，`Promise.all` 不再永久阻塞；30min containerTimeout 仍为兜底）。

## 7. 处理卡住的状态
- 残留卡 running 的 graph_runs：进程重启时 `bootRecoverGraphRuns`（`graph-recovery.ts:50`）自动翻 failed。
- 残留睡眠容器 / agent-runner 进程：`pkill -f 'agent-runner/dist/index.js'` + `docker rm -f` 旧容器。

## 8. 经验沉淀 / 预防
- agent-runner 缺 in-query watchdog 是系统性缺口：轻量路径 `sdk-query.ts` 有 abortController 超时，
  重量 agent-runner 路径无。后续可加统一活体探活（首 event 超时 + 中途静默超时 + 挂起工具白名单）。
- 同类"只 broadcast 不 persist"缺陷还存在于 `loop-orchestrator.ts:322`、`task-scheduler.ts:645`，
  本 issue 仅修 graph 路径（范围内）；另两条建议单独 issue 跟进。
- E2E TC13 单测手动构造 toolInput 通过，与 stream-processor 实际产出不符——后续应加 end-to-end
  贯穿 graph-runner 的 trace 持久化测试，避免"单测绿、E2E 红"。
