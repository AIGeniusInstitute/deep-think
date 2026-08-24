# dmg 桌面版对话报错 "Host agent exited with code 1: spawn Unknown system error -8"

- 日期：2026-08-24
- 影响面：macOS dmg 桌面版（宿主机模式 agent）+ 所有 `which claude` 解析到坏 binary 的 host 部署
- 状态：已修复（agent-runner CLI 解析加可执行性校验 + 回退）

## 1. 用户现象

用户在本机安装 DeepThink dmg 桌面版后打开应用对话，任何消息（如 `1+1=`）都收不到 AI 回复，反复出现两条系统错误：

```
admin Home 处理失败，已达最大重试次数
Host agent exited with code 1: ocessTicksAndRejections (node:internal/process/task_queues:105:5)
[agent-runner] Agent error errno: Unknown system error -8 exitCode: none
[agent-runner] Exiting with code 1, SIGKILL safety net in 5s
```

每次发送消息后队列按 5s→10s→20s→40s→80s 重试 5 次，全部同样失败。`/clear` 清上下文也无效。

## 2. 问题描述

agent-runner 通过 `which claude` 解析 Claude CLI 路径并交给 Claude Agent SDK 的
`pathToClaudeCodeExecutable`，SDK 在 `spawnLocalProcess()` 中直接 `spawn()` 该路径。
本机 `/opt/homebrew/bin/claude` 实际指向的是一个 **~500 字节、无 shebang 的纯文本占位
stub**（npm tarball 自带，本应由 postinstall 替换成 ~325MB 原生二进制）。对文本文件
执行 `exec` 内核返回 **ENOEXEC（errno 8）**，libuv 以负 errno 上报，Node 无法识别 -8
这个裸值，于是抛出 `spawn Unknown system error -8`。

## 3. 根因

三层因素叠加：

1. **npm 12 的 `allowScripts` 安全默认**：本机 npm 12.0.2（node v26.7.0）。Claude Code
   自动更新在 13:23 / 13:53 两次执行 `npm install -g @anthropic-ai/claude-code@2.1.241`，
   npm 日志（`~/.npm/_logs/2026-08-24T05_23_51_177Z-debug-0.log`、`...05_53_48_147Z...`）
   明确记录：
   ```
   warn install-scripts 1 package had install scripts blocked because they are not covered by allowScripts:
   warn install-scripts   @anthropic-ai/claude-code@2.1.241 (postinstall: node install.cjs)
   ```
   postinstall（`install.cjs`，负责把平台原生二进制落到 `bin/claude.exe`）被拦截。
2. **npm tarball 里的占位 stub**：从 registry 拉取 `@anthropic-ai/claude-code@2.1.241`
   tarball 解包验证，`package/bin/claude.exe` 是 500 字节 ASCII 文本：
   ```
   echo "Error: claude native binary not installed." >&2
   ...
   ```
   无 shebang、无 Mach-O/ELF 魔数 → `exec` 必然 ENOEXEC。
3. **agent-runner 无条件信任 `which claude` 的结果**：`container/agent-runner/src/index.ts`
   在非 Windows 平台用 `which claude` 解析 CLI 路径后直接传给 SDK，未校验文件是否为
   真实可执行体。而 dmg 的 `Resources/agent-runner/node_modules` 里其实自带完好的
   `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`（SDK 默认解析可用），被坏的
   PATH 解析结果挡住了。

错误码解释：libuv 的 `UV_ENOEXEC = -8`；该负值未走 `uv_translate_sys_error` 映射，
Node 将裸值格式化为 `Unknown system error -8`。已用 stub 文件 100% 复现同错
（同 stack：`ChildProcess.spawn (node:internal/child_process:420:11)`）。

用户 14:06 已自行救回：`npm config set allow-scripts=@anthropic-ai/claude-code` +
卸载重装（npm 日志 14:05-14:07 可见）。DeepThink 侧的修复针对第 3 层——即使宿主机
全局 claude 是坏的，桌面版也能自愈。

## 4. 复现路径

1. 准备一个坏 claude：`npm install -g @anthropic-ai/claude-code`（在未放行
   allow-scripts 的 npm 12 上），确认
   `file $(which claude)` 显示 `ASCII text` 而非 `Mach-O`。
2. 打开 DeepThink dmg 桌面版（admin Home 为宿主机模式），发送 `1+1=`。
3. 观察到系统错误 `Host agent exited with code 1 ... Unknown system error -8`，
   重试 5 次后报"已达最大重试次数"。

最小复现（不依赖 DeepThink）：

```bash
mkdir -p /tmp/stub && printf 'echo broken\n' > /tmp/stub/claude && chmod +x /tmp/stub/claude
node -e "require('child_process').spawn('/tmp/stub/claude',['--version'])" \
  # → Error: spawn Unknown system error -8  errno: -8
```

## 5. 诊断方法

```bash
# 1. 看用户侧完整 stack（含 SDK spawnLocalProcess 帧）
tail -60 "$HOME/Library/Application Support/DeepThink/data/groups/main/logs/"host-$(date -u +%Y-%m-%dT%H-%M)*.log | grep -A8 "runQuery error"

# 2. 判定 which 解析到的 claude 是否为真实二进制（关键一步）
file "$(which claude)"
# 健康输出: Mach-O 64-bit executable arm64
# 故障输出: ASCII text  ← 即占位 stub

# 3. 查 npm 是否拦截过 postinstall
grep -l "install scripts blocked" ~/.npm/_logs/*.log | tail -5
grep -A2 "install scripts blocked" ~/.npm/_logs/<时间点>.log

# 4. 确认 dmg 自带 SDK 平台二进制完好
file "/Applications/DeepThink.app/Contents/Resources/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
```

## 6. 修复方案

`container/agent-runner/src/index.ts`，两处改动：

```diff
+// 校验文件是否为可直接 exec 的真实可执行体：原生二进制（Mach-O / ELF / PE）或带
+// shebang 的脚本。npm tarball 里的 @anthropic-ai/claude-code bin/claude.exe 是一个
+// ~500 字节、无 shebang 的文本占位符（postinstall 被拦截时残留）——直接 spawn 它
+// 会以 ENOEXEC 失败，Node 报 "spawn Unknown system error -8"（libuv 负 errno）。
+function isRealExecutable(binPath: string): boolean { ... 魔数检测 ... }

 function resolveBundledClaudeCli(): string | undefined {
   ...
-    const size = fs.statSync(binPath).size;
-    return size > 4096 ? binPath : undefined;
+    return isRealExecutable(binPath) ? binPath : undefined;
 }

 // runQuery() 内 which/commonPaths 解析完成后：
+if (
+  pathToClaudeCodeExecutable &&
+  process.platform !== 'win32' &&
+  !isRealExecutable(pathToClaudeCodeExecutable)
+) {
+  log(`[claude-cli] ${pathToClaudeCodeExecutable} 不是真实可执行文件（疑似 npm allowScripts 拦截 postinstall 残留的占位 stub），回退到内置 CLI。修复全局安装：npm config set allow-scripts=@anthropic-ai/claude-code && npm install -g @anthropic-ai/claude-code`);
+  pathToClaudeCodeExecutable = resolveBundledClaudeCli();
+}
```

选型理由：
- **校验而非更换解析顺序**：保持既有"`which claude` 优先"的解析来源不变（Windows
  兜底逻辑、Linux 容器内全局安装均不受影响），只在结果不可执行时回退，改动面最小。
- **魔数检测（4 字节读取）** 比 `size > 4096` 启发式准确：能同时识别 stub（文本）、
  空文件（SDK optionalDependencies 占位包）和真实二进制；shebang 放行保证脚本型
  CLI 不被误杀。
- **Windows 跳过校验**：`where claude` 常返回无魔数的 `.cmd`/`.ps1` shim，校验会
  误杀正常解析结果。
- **回退链**：`resolveBundledClaudeCli()`（本地依赖真实 binary）→ 留空（SDK 内部
  解析自带平台包，dmg 内已有验证完好的 darwin-arm64 二进制）。

验证记录（修复后 agent-runner，模拟 dmg 故障场景）：
- PATH 首位放 stub claude → 日志出现 `[claude-cli] ... 回退到内置 CLI`，模型回合
  正常完成（`text_delta`/`usage`/`success` 事件齐全），exit 0，无 `Agent error`。
- 正常 PATH（真实 claude）→ 不触发回退日志，行为与修复前一致，exit 0。
- `make typecheck` ✅、`make test` 125 文件 / 1481 用例全过 ✅。

## 7. 处理卡住的状态

用户侧卡死（已达最大重试次数、容器一直失败）时的救活步骤：

```bash
# 方案 A：修宿主机全局 claude（根治）
npm config set allow-scripts=@anthropic-ai/claude-code
npm uninstall -g @anthropic-ai/claude-code && npm install -g @anthropic-ai/claude-code
file "$(which claude)"   # 确认显示 Mach-O

# 方案 B：不依赖全局安装（安装了旧版含本修复的 DeepThink 后自动回退内置 CLI，
# 无需任何操作）
```

## 8. 经验沉淀 / 预防

1. **spawn 类错误先看裸 errno**：`Unknown system error -N` 中 N 取负值即 libuv
   `UV_E*` 常量（-8=ENOEXEC、-13=EACCES…），先翻译再定位，不要被 "Unknown" 迷惑。
2. **不要无条件信任 `which` 的结果**：解析出的可执行文件用前做魔数校验，坏文件
   给出带修复指引的日志并回退，而不是把内核错误透传给终端用户。
3. **npm 12 安全默认（allowScripts / allow-git / allow-remote）是 2026 年新雷区**：
   依赖 postinstall 落地原生二进制的包（claude-code、better-sqlite3 等）在未放行
   的机器上会静默变成 stub。CI / 新机初始化脚本应显式配置
   `npm config set allow-scripts=<pkg>`。
4. **巡检建议**：运维巡检脚本可加入
   `file "$(which claude)" | grep -q "executable"` 一行，非 0 即告警。
5. **本次顺带修复**：main 上 Team Graph commit（9e14b83）只改了
   `src/stream-event.types.ts` 副本、漏改单一真相源 `shared/stream-event.ts`，导致
   新 checkout 上 `make typecheck`（依赖 sync-types）必然失败。已把 graph 事件类型
   回填到 `shared/stream-event.ts`，副本与真相源恢复一致。
