# 技术方案：企业级工具治理与最小权限基线

> 对应 PRD：`docs/prd/tool-governance-least-privilege/PRD.md`
> 分支：`feat/tool-governance-least-privilege`
> 原则：Surgical Changes（仅改工具网关链路，不动 agent-runner/sandbox/编排）；Simplicity First（复用既有 AES/audit/ensureColumn 模式，不引新依赖）。

## 1. 改动文件清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/db.ts` | DDL + DB 函数 + 迁移 | side_effect 列、audit/idempotency 新表、token_hash 列、schema_version 60、明文迁移函数 |
| `src/mcp-registry/engine.ts` | 解密 authHeader + 副作用推断 + 幂等接口 | executeRegistryTool 增 ctx 参数（requestId/idempotencyKey/userId），写 audit/idempotency |
| `src/mcp-registry/crypto.ts` | 新文件 | AES-256-GCM 加解密封装（复用 runtime-config key） |
| `src/mcp-registry/rate-limit.ts` | 新文件 | 滑动窗口限流器（内存） |
| `src/mcp-registry/governance.ts` | 新文件 | 副作用分级推断 + audit 写入 + idempotency 查询/写入 |
| `src/routes/mcp-registry.ts` | 注入 requestId/限流 + 调用链 | tools/call 与 /tools/:id/test 接入 governance |
| `src/schemas.ts` | sideEffect 字段 | RegistryToolCreate/UpdateSchema |
| `src/runtime-config.ts` | 导出 getOrCreateEncryptionKey | 从私有改 export（或新增公共 accessor） |
| `web/src/stores/mcp-registry.ts` | sideEffect 类型 | RegistryTool/CandidateTool 接口 |
| `web/src/components/mcp-servers/RegistryPanel.tsx` | 展示副作用徽标 | method 徽标旁加 read/write/admin |
| `web/src/components/mcp-registry/ToolEditorDialog.tsx` | sideEffect 选择器 | 可选覆盖自动推断 |
| `tests/units/tool-governance.test.ts` | 新测试 | F1–F5 单元 + 集成 |

## 2. 数据模型

### 2.1 DDL（追加到 db.ts 主 schema 块，PG/SQLite 双兼容）

```sql
CREATE TABLE IF NOT EXISTS tool_call_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  side_effect TEXT NOT NULL,
  args_hash TEXT NOT NULL,        -- sha16 前 16 字符
  request_id TEXT,
  idempotency_key TEXT,
  result_status TEXT NOT NULL,   -- success|error
  http_status INTEGER,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tca_user ON tool_call_audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tca_tool ON tool_call_audit_log(tool_id, created_at);

CREATE TABLE IF NOT EXISTS tool_call_idempotency (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_content TEXT NOT NULL,  -- JSON of McpToolResult
  result_is_error INTEGER NOT NULL,
  http_status INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, tool_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_tci_expire ON tool_call_idempotency(created_at);
```

### 2.2 ensureColumn（迁移兼容）

```ts
ensureColumn('mcp_registry_tools', 'side_effect', "TEXT NOT NULL DEFAULT 'read'");
ensureColumn('mcp_registry_servers', 'rate_limit_override', 'TEXT');
ensureColumn('mcp_registry_tokens', 'token_hash', 'TEXT');
```

### 2.3 schema_version 60

主 schema 块末尾 `routerState` 写入逻辑已有 `setRouterStateInternal('schema_version','59')`；本次把 fresh 库默认值升到 60，并在版本门控加 v60 迁移块（调用 `migrateToolGovernanceV60()` 做明文迁移）。

## 3. 模块设计

### 3.1 crypto.ts（AES-256-GCM）

```ts
import { getOrCreateEncryptionKey } from '../runtime-config.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
export function encryptSecret(plain: string): string {
  const key = getOrCreateEncryptionKey();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain,'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // 兼容未迁移明文
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0,12), tag = buf.subarray(12,28), data = buf.subarray(28);
  const key = getOrCreateEncryptionKey();
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
export function isEncrypted(s: string): boolean { return s.startsWith(PREFIX); }
```

### 3.2 governance.ts

```ts
export type SideEffect = 'read'|'write'|'admin';
export function inferSideEffect(method: string): SideEffect {
  if (method==='DELETE') return 'admin';
  if (['POST','PUT','PATCH'].includes(method)) return 'write';
  return 'read';
}
export function resolveSideEffect(explicit?: SideEffect|null, method?: string): SideEffect {
  if (explicit) return explicit;
  if (method) return inferSideEffect(method);
  return 'read'; // 最保守
}
export function hashArgs(args: Record<string,unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0,16);
}
// logToolCallAudit(row): INSERT tool_call_audit_log（fire-and-forget, try/catch warn）
// getIdempotencyRecord(userId,toolId,key) / saveIdempotencyRecord(...)
```

### 3.3 rate-limit.ts（滑动窗口）

```ts
// 内存 Map<key, number[] timestamps>，清理 >60s。
// checkRateLimit(userId, toolId, sideEffect): {allowed, retryAfterMs}
// 配额：read=120, write=30, admin=10 per 60s
const LIMITS: Record<SideEffect,number> = { read:120, write:30, admin:10 };
```

### 3.4 engine.ts 改动

`executeRegistryTool` 签名扩展为接受可选 `ctx`：

```ts
export interface ExecCtx {
  userId: string;
  requestId?: string;
  idempotencyKey?: string;
}
```

内部：
1. 解密 authHeader.value（若 isEncrypted）。
2. 由 governance 写 audit 行（成功/失败分支都写）。
3. 写工具 + 有 idempotencyKey：先查 idempotency 命中且 result_is_error=0 → 直接回放；未命中执行后 saveIdempotencyRecord。

为保持"引擎层不抛错"原则，audit/idempotency 写入失败仅 warn log，不影响返回。

### 3.5 routes/mcp-registry.ts 改动

- `handleMcp` 入口与 `/tools/:id/test`：
  - 生成/取 requestId（`X-Request-Id` 头），响应头回写。
  - tools/call 前 `checkRateLimit`，超限返 -32000（HTTP 429）。
  - 透传 idempotencyKey（`Idempotency-Key` 头）。
- 新增 `GET /audit-log`（admin）。

## 4. 前端改动

- `RegistryTool`/`CandidateTool` 接口加 `sideEffect?: SideEffect`。
- `RegistryPanel.tsx:178` method 徽标旁加副作用徽标（read 绿 / write 黄 / admin 红）。
- `ToolEditorDialog.tsx` 加 sideEffect Select（"自动推断 / read / write / admin"），默认自动推断（不传，后端按 method 推断）。

## 5. 迁移策略

启动时 `migrateToolGovernanceV60()`（幂等）：
1. 遍历 `mcp_registry_tools`，`http_binding` JSON 中 authHeader.value 非 enc:v1: → 加密回写。
2. 遍历 `mcp_registry_tokens`，token_hash 为空 → 写 sha256(token)，token 列保留（兼容期，鉴权改用 hash 比对）。
3. 全程 try/catch + warn，不阻断启动。

## 6. 测试策略

- 单元：`tests/units/tool-governance.test.ts` 覆盖 F1–F5 全部 TC。用 in-memory DB（复用现有测试 db setup）+ mock fetch。
- smoke：加入 `Makefile test-smoke` 列表（确保 CI 门禁覆盖）。
- 手动 e2e：登录 http://127.0.0.1:9999 → MCP Registry 页面创建带 authHeader 的写工具 → 查 DB 加密 → 试调 → 查审计行 → 限流触发截图。

## 7. 回归保护

- 不动 `mcp_registry_tools` 既有列含义；新增列均有默认值，老客户端不感知新字段仍可工作。
- engine.ts 新 ctx 参数可选，不传时行为与旧版完全一致（无审计/幂等），保证未接入路径零回归。
- 加密迁移幂等，可重复执行。
