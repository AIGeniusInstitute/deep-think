# TASK_STATE：企业级工具治理与最小权限基线

> 分支：`feat/tool-governance-least-privilege`
> 工作区：`~/deepthink/.worktrees/feat-enterprise-platform-gaps`

## 进度

- [x] 审计 4 路完成（接入/身份权限、编排/模型、工具/知识、执行/治理）
- [x] PRD 完成（5 功能点 + 验收标准 + 21 测试用例）
- [x] 技术方案完成
- [x] 编码 F1 副作用分级
- [x] 编码 F2 幂等键
- [x] 编码 F3 调用审计
- [x] 编码 F4 限流 + requestId
- [x] 编码 F5 凭据加密
- [x] 前端徽标
- [x] 单元测试（20 例全绿）
- [x] tsc + smoke 通过（10 文件 122 测试零回归）
- [ ] 测试报告
- [ ] 合并 main

## 关键技术决策（2026-09-05）

### 加密依赖解耦：db.ts 内联 AES

**问题**：db.ts 静态 import `mcp-registry/crypto.ts` → crypto.ts 静态 import `runtime-config.ts`
→ runtime-config 模块加载期需要 config.js 的 `ASSISTANT_NAME` 等导出 → 39 个仅部分 mock
config 的既有测试（chat-trace-store、open-platform-validation 等）报
"No ASSISTANT_NAME export defined on config.js mock"。

**解法**：把 AES-256-GCM 逻辑内联到 db.ts（`dbEncryptSecret/dbDecryptSecret/
dbIsEncrypted/dbHashToken`），直接读 `DATA_DIR/config/claude-provider.key`
（与 runtime-config.getOrCreateEncryptionKey 同一文件、同一格式），彻底切断
db.ts → runtime-config 静态链。crypto.ts 保留静态 import 给 engine.ts 用
（engine.ts 仅经 routes 加载，不进 db-only 测试依赖图）。两者密文格式
`enc:v1:<base64(iv[12]||tag[16]||data)>` 完全互操作。

**验证**：tsc exit 0；smoke 10 文件 122 测试全绿（含新增 20 + 既有 102 零回归）。

## 实现顺序

1. crypto.ts（F5 基础）
2. db.ts DDL + 迁移 + 函数
3. governance.ts（F1/F3 基础）
4. rate-limit.ts（F4）
5. engine.ts 接入
6. routes/mcp-registry.ts 接入 + audit-log 路由
7. schemas.ts sideEffect
8. runtime-config.ts export key
9. 前端
10. 测试
