# TASK_STATE — K8s 全量无状态化缺口修复

> 分支 `feat/k8s-stateless-completion`，基线 main(031a7cd) + PG-compat WIP。

## 状态：全部 6 项硬缺口已修复并验证，待合并 main

| 项 | 描述 | 状态 | 验证 |
|---|---|---|---|
| A1 | INSERT OR REPLACE → 真 ON CONFLICT(pk) DO UPDATE | ✅ | 翻译器单元 10/10 + 真实 PG |
| A2 | pg-sync-driver INSERT 附加 RETURNING * + 数字强转 | ✅ | 真实 PG lastInsertRowid=1 可回查 |
| A3 | date(col,'localtime') → substr | ✅ | 真实 PG 生成产线形态查询 PASS |
| B1 | IM 连接分布式 leader 选举 | ✅ | 真实 Redis CAS 11/11 |
| B2 | mcp-tools.ts 补 Redis IPC 分支 | ✅ | tsc + channel 与 web-server 一致 |
| B3 | 周期任务 leader 门控 | ✅ | 真实 Redis withOwnership 单执行者 PASS |
| 回归 | SQLite smoke | ✅ | 102/102 |
| 编译 | 后端 + agent-runner tsc | ✅ | exit 0 |

## 提交

- `b3c09ed` baseline: PG-compat WIP（FK 剥离 / sqlite_master→pg catalog / PRAGMA table_info / INSERT OR REPLACE→ON CONFLICT DO NOTHING）
- `9f3…`（Tier A）fix(k8s): PG 数据层三大致命缺口修复 — INSERT OR REPLACE 真 upsert / lastInsertRowid / date(localtime)
- `0a882fe` fix(k8s): 水平扩缩容三大功能性阻塞修复 — IM leader / Claude 引擎 Redis IPC / 周期任务门控
- 测试脚本提交 + 文档提交（见下）

## 验证产物

- `scripts/test-tier-a-translator.mjs`：翻译器单元 10/10
- `scripts/test-tier-a-pg.mjs`：真实 PG 集成 11/11
- `scripts/test-tier-b-redis.mjs`：真实 Redis CAS 11/11
- `docs/test_report/k8s-stateless-completion/TEST_REPORT.html`：HTML 测试报告

## 未推进项（独立大改 / 需云凭证，留待后续）

- Tier C：记忆 / Skills 运行时内容 / MCP server 配置 / WhatsApp baileys auth / embedding 配置 / 工作区产物与文件上传 → 全量迁 DB / 对象存储（共享 RWX PVC 下当前可工作）。
- Tier D：真实云集群 `kubectl apply -k` 端到端（需云凭证，PRD 非目标）。
- IM leader per-user 分片散布（当前单 leader，正确性已达标，吞吐散布为后续优化）。
