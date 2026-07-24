# 技术方案：pi 引擎接入 DeepThink

- **版本**：v1.0
- **创建日期**：2026-07-25
- **分支**：`feat/pi-engine`
- **pi 版本**：0.82.0（`~/pi`）

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  DeepThink 主进程 (src/index.ts)                              │
│  - routes/config.ts: /api/config/pi/* (admin)                │
│  - routes/groups.ts: PATCH /api/groups/:jid (engine='pi')     │
│  - runtime-config.ts: getPiConfig/savePiConfig/toPublicPiConfig│
│  - container-runner.ts: 按 group.engine 注入 PI_* 环境变量    │
│  - db.ts: sessions.pi_session_id 列 + getPiSessionId 等 helper │
└───────────────────┬──────────────────────────────────────────┘
                    │ stdin: ContainerInput {engine:'pi', ...}
                    │ env: PI_BINARY_PATH, PI_CLI_SCRIPT_PATH,
                    │      PI_PROVIDERS_JSON, PI_DEFAULT_*, ...
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  Agent Runner (container/agent-runner)                        │
│  index.ts main() 分支 (在 opencode 分支后):                  │
│    if engine === 'pi':                                       │
│       → pi-engine.ts:runPiEngine()                            │
└───────────────────┬──────────────────────────────────────────┘
                    │ spawn `node <cli.js> --mode rpc`
                    │ stdin: JSONL RpcCommand ({type:'prompt',...})
                    │ stdout: JSONL (RpcResponse + AgentSessionEvent)
                    ▼
┌──────────────────────────────────────────────────────────────┐
│  pi --mode rpc (Node 长驻进程)                                │
│  - PI_CODING_AGENT_DIR=<独立目录> (隔离 session)              │
│  - <PROVIDER>_API_KEY env 注入 (anthropic/openai/...)         │
│  - 事件: message_update(text_delta)/tool_execution_*/         │
│         turn_*/agent_end/agent_settled                        │
│  - 终止: SIGTERM 或关闭 stdin                                 │
└──────────────────────────────────────────────────────────────┘
```

pi 是首个 **stdio JSONL 长驻** adapter（codex 是 per-turn spawn JSONL，opencode 是长驻 HTTP+SSE，atomcode 是长驻 HTTP/SSE daemon）。

## 2. 模块变更清单

### 2.1 类型与判别联合（必改，5 处）

1. **`container/agent-runner/src/types.ts:57`** — `engine` 联合加 `| 'pi'`
2. **`src/types.ts:75,81`** — `engine?` 字段与 `AgentEngine` 类型加 `'pi'`
3. **`src/container-runner.ts:279`** — `ContainerInput.engine` 加 `| 'pi'`；`:870-874`/`:1317`/`:1795`/`:2231` 的 `as` 联合同步
4. **`src/schemas.ts:244,253,266`** — group engine enum 加 `'pi'`
5. **`src/routes/groups.ts:126`** — engine 字段联合加 `'pi'`（若该处有显式联合）
6. **`src/db.ts:5118`** — engine 取值校验加 `'pi'`；`:9432` RegisteredGroup.engine 类型加 `'pi'`

### 2.2 数据库层（`src/db.ts`）

**新增列**（与 atomcode/codex/opencode 同模式）：
```ts
ensureColumn('sessions', 'pi_session_id', 'TEXT');
```
插入位置：`src/db.ts:1339`（opencode_session_id 之后）。

**会话 helper**（仿 `getOpencodeSessionId` `:4907`）：
```ts
export function getPiSessionId(groupFolder, agentId?): string | undefined;
export function setPiSessionId(groupFolder, sessionId, agentId?): void;
export function clearPiSessionId(groupFolder, agentId?): void;
```
插入位置：`src/db.ts:4904` 之后（opencode helper 之后）。

**engine 取值校验**（`:5118`）：
```ts
engine:
  row.engine === 'atomcode' || row.engine === 'codex' || row.engine === 'opencode' || row.engine === 'pi'
    ? (row.engine as ...'pi')
    : 'claude',
```

### 2.3 配置存储（`src/runtime-config.ts`）

在 opencode config 之后（`:4503` 后）新增：

```ts
export interface PiProvider {
  provider: string;   // anthropic/openai/deepseek/gemini/qwen/zai/moonshot/xai/groq...
  apiKey: string;
  baseURL: string;    // 可选，空则用 pi-ai 内置端点
  model: string;
}

export interface PiConfig {
  enabled: boolean;
  binaryPath: string;       // 默认 'node'
  cliScriptPath: string;    // 默认 ''，指向 packages/coding-agent/dist/cli.js
  workingDir: string;      // 默认 '/workspace/group'
  defaultProvider: string; // 默认 'anthropic'
  defaultModel: string;    // 默认 'claude-sonnet-4-6'
  thinkingLevel: string;   // 默认 'off'
  providers: PiProvider[];
  updatedAt: string | null;
}

export interface PublicPiConfig extends Omit<PiConfig, 'providers'> {
  providers: Array<Omit<PiProvider, 'apiKey'> & { hasApiKey: boolean }>;
}

const PI_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'pi.json');

const DEFAULT_PI_CONFIG: PiConfig = {
  enabled: false,
  binaryPath: 'node',
  cliScriptPath: '',
  workingDir: '/workspace/group',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  thinkingLevel: 'off',
  providers: [],
  updatedAt: null,
};

export function getPiConfig(): PiConfig;
export function savePiConfig(cfg: Partial<PiConfig>): PiConfig;
export function toPublicPiConfig(cfg: PiConfig): PublicPiConfig;
export function resolvePiProvidersForSave(input, current): PiProvider[]; // 仿 opencode
```

`writeSecretFile`（0600）存储，与 codex/opencode 一致。

### 2.4 Zod schema（`src/schemas.ts`）

在 `OpencodeConfigSchema`（`:341`）之后新增：
```ts
export const PiProviderSchema = z.object({
  provider: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(512).optional(), // GET 不返回；PUT 缺省保留
  baseURL: z.string().max(512).optional(),
  model: z.string().min(1).max(128),
});

export const PiConfigSchema = z.object({
  enabled: z.boolean().optional(),
  binaryPath: z.string().max(512).optional(),
  cliScriptPath: z.string().max(1024).optional(),
  workingDir: z.string().max(512).optional(),
  defaultProvider: z.string().max(64).optional(),
  defaultModel: z.string().max(128).optional(),
  thinkingLevel: z.string().max(32).optional(),
  providers: z.array(PiProviderSchema).optional(),
});
```
并在 `:244`/`:253`/`:266` 的 group engine enum 加 `'pi'`。

### 2.5 env 注入（`src/container-runner.ts:911-936` 之后）

在 opencode 分支后新增 pi 分支：
```ts
if (groupEngine === 'pi') {
  const piCfg = getPiConfig();
  if (!piCfg.enabled || !piCfg.binaryPath) {
    throw new Error(
      `Group ${group.folder} has engine=pi but pi is not enabled or binaryPath is empty. Configure in Settings → pi 引擎.`,
    );
  }
  envLines.push(`PI_BINARY_PATH=${piCfg.binaryPath}`);
  envLines.push(`PI_CLI_SCRIPT_PATH=${piCfg.cliScriptPath || ''}`);
  envLines.push(`PI_WORKING_DIR=${piCfg.workingDir || '/workspace/group'}`);
  envLines.push(`PI_DEFAULT_PROVIDER=${piCfg.defaultProvider}`);
  envLines.push(`PI_DEFAULT_MODEL=${piCfg.defaultModel}`);
  envLines.push(`PI_THINKING_LEVEL=${piCfg.thinkingLevel}`);
  envLines.push(`PI_PROVIDERS_JSON=${JSON.stringify(piCfg.providers).replace(/'/g, "'\\''")}`);
  envLines.push(`DT_CHAT_JID=web:${group.folder}`);
  envLines.push(`DT_GROUP_FOLDER=${group.folder}`);
  envLines.push(`DT_IS_HOME=${!!group.is_home}`);
  envLines.push(`DT_IS_ADMIN_HOME=${!!group.is_home && group.folder === 'main'}`);
  envLines.push(`DT_IPC_DIR=/workspace/ipc`);
  envLines.push(`DT_WORKSPACE_GROUP=/workspace/group`);
  envLines.push(`DT_WORKSPACE_GLOBAL=/workspace/global`);
  envLines.push(`DT_WORKSPACE_MEMORY=/workspace/memory`);
  envLines.push(`DT_DISABLE_MEMORY_LAYER=false`);
}
```

同步 `groupEngine` 的 `as` 联合（`:870-874`）加 `| 'pi'`。

session 选择（在 codex/opencode 的 session 查询区域，仿 `:1992` opencode 分支）：
```ts
if (groupEngine === 'pi') {
  const piSid = getPiSessionId(group.folder, input.agentId || '');
  if (piSid) dockerInput.sessionId = piSid;
}
```
运行结束后 `setPiSessionId`（在 opencode setOpencodeSessionId 调用点附近）。

### 2.6 API 路由（`src/routes/config.ts`，在 `:3530` opencode 路由之后）

```ts
// ─── pi Engine Config ──────────────────────────────────

/** GET /api/config/pi */
configRoutes.get('/pi', authMiddleware, systemConfigMiddleware, (c) => {
  const cfg = getPiConfig();
  return c.json(toPublicPiConfig(cfg));
});

/** PUT /api/config/pi */
configRoutes.put('/pi', authMiddleware, systemConfigMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = PiConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid config', details: validation.error.flatten() }, 400);
  }
  const data = validation.data;
  const current = getPiConfig();
  const providers = Array.isArray(data.providers)
    ? resolvePiProvidersForSave(data.providers, current.providers)
    : undefined;
  const saved = savePiConfig({ ...data, providers });
  const actor = (c.get('user') as AuthUser).username;
  logger.info({ actor, enabled: saved.enabled, providerCount: saved.providers.length }, 'pi config updated');
  return c.json(toPublicPiConfig(saved));
});

/** POST /api/config/pi/test — spawn `pi --mode rpc`, send get_state, check response */
configRoutes.post('/pi/test', authMiddleware, systemConfigMiddleware, async (c) => {
  const cfg = getPiConfig();
  if (!cfg.binaryPath) return c.json({ ok: false, error: 'pi 启动命令未配置' });
  // 调用 pi-engine 的测试逻辑或内联 spawn + get_state RPC
  const result = await testPiRpc(cfg);  // 见 §3.3
  return c.json(result);
});
```

`testPiRpc` 实现：spawn `binaryPath [cliScriptPath] --mode rpc`，写 `{"id":"t","type":"get_state"}` 到 stdin，读 stdout JSONL，15s 内收到 `{type:"response",success:true}` 视为 ok，返回 `{ok, version?, error?}`。

### 2.7 Agent-Runner 引擎分支（`container/agent-runner/src/index.ts:2366` 之后）

在 opencode 分支后插入：
```ts
if (engine === 'pi') {
  log('Engine = pi, routing to pi-engine adapter');
  const { runPiEngine } = await import('./pi-engine.js');
  try {
    await runPiEngine({ containerInput, writeOutput, log });
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Pi engine error: ${err instanceof Error ? err.message : String(err)}`,
      turnId: containerInput.turnId,
    });
  }
  process.exit(0);
}
```
同步 `:2305-2309` 的 `engine as` 联合加 `| 'pi'`。

### 2.8 pi 引擎适配器（`container/agent-runner/src/pi-engine.ts`，新文件）

核心函数：
```ts
export async function runPiEngine(opts: RunOpts): Promise<void>;
```

**RunOpts**（与 atomcode/codex/opencode 一致）：
```ts
interface RunOpts {
  containerInput: ContainerInput;
  writeOutput: (out: ContainerOutput) => void;
  log: (message: string) => void;
}
```

**流程**：
1. 读环境变量 `PI_BINARY_PATH` / `PI_CLI_SCRIPT_PATH` / `PI_WORKING_DIR` / `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL` / `PI_THINKING_LEVEL` / `PI_PROVIDERS_JSON`
2. 校验 binaryPath 存在（若为 `node`，校验 `which node`）；若 cliScriptPath 非空，校验文件存在
3. 解析 providers JSON，按 provider 名注入 `<PROVIDER>_API_KEY` env（见 §3.1 映射表）；未覆盖 provider 收集到 `--api-key` CLI flag
4. 选 `PI_CODING_AGENT_DIR`（`~/.deepthink/pi-homes/{groupFolder}` 独立目录，隔离 session）
5. 构造 spawn args：`[cliScriptPath, '--mode', 'rpc', '--provider', provider, '--model', model, '--thinking', thinkingLevel]`（cliScriptPath 为空时省略首项）；若 `--api-key` 回退则加入
6. spawn 子进程，stdio=['pipe','pipe','pipe']，cwd=workingDir，env=process.env
7. stderr → `data/groups/{folder}/logs/pi-engine.log`
8. stdout 经 readline 行解析 JSON
9. **就绪检测**：spawn 后立即发 `{"id":"init","type":"get_state"}`，30s 内收到对应 `response success` 视为就绪；否则发 error 并退出
10. 处理 `containerInput.prompt`（drain IPC，scheduled task prefix，与 codex 一致）：
    - 写 `{"id":"<turnId>","type":"prompt","message":"<prompt>"}` 到 stdin
11. 读 stdout 事件，翻译为 StreamEvent（见 §3.2 映射表）
12. 收到 `agent_settled` → `writeOutput({status:'success', result: fullText, newSessionId: piSessionId, ...})`
13. IPC 轮询循环：fs.watch `/workspace/ipc/input/`，有新消息 → 写 `prompt` 命令续聊；`_close` sentinel → SIGTERM pi → exit
14. `extension_ui_request` → 写 `{"type":"extension_ui_response","id":"<reqId>","cancelled":true}` 回复
15. SIGINT/SIGTERM handler → SIGTERM pi 子进程 → exit

**事件映射**（§3.2）：

| pi `AgentSessionEvent` | DeepThink StreamEvent | 说明 |
|---|---|---|
| `agent_start` | `init`（首条） | statusText="pi 引擎已启动" |
| `message_update`（`assistantMessageEvent.text_delta`） | `text_delta` | 累积 fullText |
| `message_update`（thinking/reasoning 片段） | `thinking_delta` | |
| `message_update`（tool call 部分 JSON） | 累积，待 `tool_execution_start` | |
| `tool_execution_start` | `tool_use_start` | toolName=tool 名，toolInputSummary=命令摘要 |
| `tool_execution_update` | `tool_progress` | detail=更新摘要 |
| `tool_execution_end` | `tool_use_end` | toolResult=输出摘要 |
| `turn_end` | `status`（可选） | statusText=token usage（若事件携带） |
| `agent_end` | （不发 success，等 settled） | 可能 retry/compaction |
| `agent_settled` | `writeOutput({status:'success'})` | 权威终止信号，捕获 pi_session_id |
| `error` 类事件 | `writeOutput({status:'error'})` | error 消息 |
| `abort`/`stopped` | `writeOutput({status:'success', finalizationReason:'interrupted'})` | |

**pi session 续接**：从 `agent_start`/`session_info_changed` 事件提取 session id，存入 `sessions.pi_session_id`（通过 `writeOutput({newSessionId})` 回传主进程，主进程在 opencode 的 setSession 调用点附近 setPiSessionId）。后续 turn 用 `--session-id <id>` 或 `switch_session` RPC 命令续接（实现时验证哪种更可靠，见 §4 验证项）。

### 2.9 前端

**`web/src/api/client.ts`**（或 `api.ts`）新增：
```ts
export const piApi = {
  getConfig: () => api.get('/api/config/pi'),
  saveConfig: (cfg) => api.put('/api/config/pi', cfg),
  test: () => api.post('/api/config/pi/test'),
};
```

**`web/src/components/chat/EngineSwitcher.tsx`**：
- `:12` `EngineKey` 加 `| 'pi'`
- `:14-19` `ENGINES` 数组加 `{ key: 'pi', label: 'pi' }`
- `:21-25` `EngineAvailability` 加 `pi?: boolean`
- `:34-45` `Promise.all` 加 `api.get('/api/config/pi')`，setAvailability 加 `pi: p?.enabled === true`
- `:55` `engine !== 'claude' && !availability[engine]` 已通用，无需改

**`web/src/components/settings/PiEngineSection.tsx`**（新文件，仿 `OpencodeEngineSection.tsx`）：
- 字段：enabled / binaryPath / cliScriptPath / workingDir / defaultProvider / defaultModel / thinkingLevel
- Provider 管理子组件（列表 + 新增/编辑/删除）
- 测试连接按钮
- 注册到 `SettingsNav.tsx`（key `'pi'`）+ `SettingsPage.tsx` tab 路由
- `SettingsTab` union 加 `'pi'`

**`web/src/pages/EnginesPage.tsx`**：
- `:19` `ENGINES` 数组加 pi 卡片

**`web/src/stores/chat.ts`**：
- `:326` `switchEngine` 签名联合加 `| 'pi'`
- `:1773` 同步

**`web/src/types.ts`**：
- `GroupInfo.engine` 类型加 `'pi'`

### 2.10 文档

- `docs/prd/pi-engine/PRD.md`、`docs/tech_solution/pi-engine/SOLUTION.md`、`docs/task_state/pi-engine/task_state.json`、`docs/test_report/pi-engine/TEST_REPORT.md`

## 3. 关键代码片段

### 3.1 provider→envvar 映射表（pi-engine.ts）

```ts
const PROVIDER_ENV_KEY: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  google: 'GEMINI_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  zai: 'ZAI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  kimi: 'KIMI_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  cloudflare: 'CLOUDFLARE_API_KEY',
};
// 注入：process.env[envKey] = provider.apiKey
// 未覆盖的 provider：args.push('--api-key', provider.apiKey)（仅首个未覆盖 provider）
```

### 3.2 RPC stdin/stdout 行级 JSONL 读写（pi-engine.ts 核心）

```ts
// stdin 写入（行级 JSON + \n）
function sendCommand(proc: ChildProcess, cmd: object): void {
  if (!proc.stdin) throw new Error('pi stdin unavailable');
  proc.stdin.write(JSON.stringify(cmd) + '\n');
}

// stdout 行解析
const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let ev: PiRpcMessage;
  try { ev = JSON.parse(line); } catch { continue; } // 非 JSONL（日志）忽略
  handlePiMessage(ev, ctx); // 分发到 response / AgentSessionEvent / extension_ui_request
}
```

`PiRpcMessage` 为 `RpcResponse | AgentSessionEvent | { type: 'extension_ui_request', ... }` 的判别联合。

### 3.3 testPiRpc（主进程侧测试连接，`src/routes/config.ts` 内联或 helper）

```ts
async function testPiRpc(cfg: PiConfig): Promise<{ ok: boolean; version?: string; error?: string }> {
  const args = cfg.cliScriptPath ? [cfg.cliScriptPath, '--mode', 'rpc'] : ['--mode', 'rpc'];
  return new Promise((resolve) => {
    const proc = spawn(cfg.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill('SIGTERM'); resolve({ ok: false, error: 'timeout' }); }, 15_000);
    const rl = readline.createInterface({ input: proc.stdout });
    let resolved = false;
    rl.on('line', (line) => {
      if (resolved) return;
      let msg: any; try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'response' && msg.command === 'get_state') {
        resolved = true; clearTimeout(timer);
        proc.kill('SIGTERM');
        resolve({ ok: !!msg.success, version: msg.data?.version });
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    // spawn 后立即发 get_state
    proc.stdin.write(JSON.stringify({ id: 't', type: 'get_state' }) + '\n');
  });
}
```

## 4. 验证项（实现时需先确认的行为）

1. **pi `--session-id` 续接行为**：spawn 时传 `--session-id <existing>` 是否能恢复历史？还是必须用 RPC `switch_session` 命令？——实现时先跑 `pi --mode rpc` + `new_session` → 拿 id → `switch_session` 验证，取可靠方式。
2. **pi `agent_start`/`session_info_changed` 事件是否携带 session id**——决定如何捕获 pi_session_id。
3. **pi dist 是否能 `npm run build` 成功**——Phase 5 前置。
4. **`--provider`/`--model`/`--thinking` CLI flag 是否在 RPC 模式生效**——若不生效，改用 settings.json 写入。

## 5. 测试策略

### 5.1 类型与构建
- `make typecheck`（三端）
- `make build`（确认 `pi-engine.js` 产出）

### 5.2 E2E（浏览器 UI 自动化，admin/88888888）
1. 设置页配置 pi binaryPath=node、cliScriptPath、provider → 保存
2. 测试连接 → 收到 ok=true
3. 主对话切换到 pi 引擎 → 发"你好" → 收到流式回复
4. 发"我叫张三" → 发"我叫什么" → 第二轮回答"张三"
5. 切回 Claude → 发消息 → 正常
6. binaryPath 故意配错 → 发消息 → 收到明确错误提示

### 5.3 验收标准
见 PRD §6。

## 6. 回滚策略

- DB 列 `pi_session_id` 默认 NULL，向后兼容
- `engine` 字段缺失时（旧 client），后端默认 `'claude'`
- `pi.json` 不存在时，`getPiConfig()` 返回 `enabled: false`
- 前端切换器检测 `enabled=false` 时置灰
- 所有改动新增分支，不动现有 claude/atomcode/codex/opencode 路径

## 7. 已知限制（首版）

1. pi 引擎下，DeepThink 内置 MCP 工具（send_message/schedule_task/memory_*）不可用 —— pi 无 MCP client，未做桥接（与 atomcode 首版一致）
2. 跨引擎切换会话上下文不连续
3. 首版仅支持宿主机模式 / host-binary bind-mount
4. provider→envvar 映射表内置常见 provider，未覆盖的回退 `--api-key` CLI flag
5. pi session 不进入 DeepThink 的 `conversations/` 归档
6. 图片输入首版不支持
