/**
 * Container Runner for deepthink
 * Spawns agent execution in Docker container and handles IPC
 */
import {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  spawn,
} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { resolveHostNodeBinary } from './node-resolver.js';
import {
  loadMountAllowlist,
  validateAdditionalMounts,
} from './mount-security.js';
import {
  buildContainerEnvLines,
  getClaudeProviderConfig,
  getContainerEnvConfig,
  getEnabledProviders,
  getBalancingConfig,
  getSystemSettings,
  getEffectiveExternalDir,
  mergeClaudeEnvConfig,
  resolveProviderById,
  shellQuoteEnvLines,
  writeCredentialsFile,
  getAtomcodeConfig,
  getCodexConfig,
  getOpencodeConfig,
  getPiConfig,
} from './runtime-config.js';

import { providerPool } from './provider-pool.js';
import {
  deleteSession,
  getSessionProviderId,
  setSessionProviderId,
  getUserById,
  getAtomcodeSessionId,
  setAtomcodeSessionId,
  clearAtomcodeSessionId,
  getCodexThreadId,
  setCodexThreadId,
  getOpencodeSessionId,
  setOpencodeSessionId,
  getPiSessionId,
  setPiSessionId,
  getAgentDefinition,
  listAgentMounts,
  getKnowledgeBase,
} from './db.js';
import { DEFAULT_LANGUAGE } from './i18n-languages.js';
import { isApiError } from './agent-output-parser.js';
import type { ClaudeProviderConfig } from './runtime-config.js';
import { loadUserMcpServers } from './mcp-utils.js';
import {
  getUserRuntimeRoot,
  loadUserPlugins,
  CONTAINER_PLUGINS_PATH,
  type SdkPluginConfig,
} from './plugin-utils.js';
import { materializeUserRuntime } from './plugin-materializer.js';
import { invalidateUserCommandIndex } from './plugin-command-index.js';
import {
  checkHostCapabilities,
  logCapabilityPreflight,
} from './agent-capabilities.js';
import {
  buildClaudeContextPlan,
  syncHostClaudeContext,
} from './claude-context-resolver.js';
import { MessageSourceKind, RegisteredGroup, StreamEvent } from './types.js';
import type { ClaudeContextAudit } from './stream-event.types.js';
import {
  attachStderrHandler,
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  handleSuccessClose,
  handleTimeoutClose,
  writeRunLog,
  type CloseHandlerContext,
} from './agent-output-parser.js';

/**
 * 宿主机的 ~/.claude.json 路径。
 * 所有工作区共享此文件，确保 deviceId (userID) 一致。
 * 即使 DeepThink 项目删除重建，此文件始终存在于宿主机上。
 */
function getHostClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * 确保宿主机 ~/.claude.json 存在。
 * 如不存在则创建空 JSON，Claude Code 首次运行时会自动生成 userID。
 */
function ensureHostClaudeJson(): string {
  const p = getHostClaudeJsonPath();
  try {
    fs.writeFileSync(p, '{}', { mode: 0o600, flag: 'wx' });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
  return p;
}

/**
 * 为 Docker 容器生成精简版 .claude.json。
 * 宿主机 ~/.claude.json 中的 cachedGrowthBookFeatures 含 tengu_bridge_repl_v2 等
 * feature flags，SDK 初始化时会据此尝试建立 bridge 连接，在容器网络环境中无法完成
 * 导致进程挂起。剥离该字段后其余内容原样保留（userID 等）。
 * 同时剥离 oauthAccount：容器内不走宿主机的 OAuth 登录态，认证完全由
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 环境变量控制，避免 SDK 误检
 * OAuth 凭据后跳过标准 Bearer header（第三方 provider 返回 404）。
 */
function getContainerClaudeJsonPath(): string {
  const containerJsonDir = path.join(DATA_DIR, 'config');
  fs.mkdirSync(containerJsonDir, { recursive: true });
  const containerJsonPath = path.join(containerJsonDir, 'container-claude-json.json');

  try {
    const hostJson = JSON.parse(fs.readFileSync(getHostClaudeJsonPath(), 'utf-8'));
    const stripped = { ...hostJson };
    delete stripped.cachedGrowthBookFeatures;
    delete stripped.oauthAccount;
    stripped.autoUpdates = false;
    fs.writeFileSync(containerJsonPath, JSON.stringify(stripped, null, 2) + '\n', { mode: 0o644 });
  } catch {
    fs.writeFileSync(containerJsonPath, '{"hasCompletedOnboarding":true,"autoUpdates":false}\n', { mode: 0o644 });
  }

  return containerJsonPath;
}

/**
 * 确保 localPath 是指向 targetPath 的 symlink。
 * 如果 localPath 是普通文件或指向错误目标的 symlink，替换它。
 */
function ensureSymlinkTo(localPath: string, targetPath: string): void {
  try {
    const st = fs.lstatSync(localPath);
    if (st.isSymbolicLink() && fs.readlinkSync(localPath) === targetPath) {
      return; // 已经是正确的 symlink
    }
    fs.unlinkSync(localPath); // 普通文件或错误 symlink，删除
  } catch {
    // 文件不存在，继续创建
  }
  try {
    fs.symlinkSync(targetPath, localPath);
  } catch (err) {
    logger.warn({ err, localPath, targetPath }, 'Failed to create symlink for .claude.json, deviceId may differ');
  }
}

/**
 * Required env flags for settings.json — 每次容器/进程启动时强制写入，不可被用户覆盖。
 * 合并模式：仅覆盖这些 key，保留用户自定义的其他 key。
 */
const REQUIRED_SETTINGS_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  // 禁用 SDK 附件注入（token_usage, changed_files, todo_reminders 等 20+ 种动态消息）。
  // 这些附件在每次 query() 时动态生成但不持久化到 JSONL，导致跨进程的消息数组
  // 前缀不匹配，prompt cache 永远失效（cache_read 始终 = 11224 静态 system prompt）。
  // 禁用后历史消息的缓存前缀跨 query() 保持一致，实现 1M 上下文下的增量缓存。
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
};

/**
 * Resolve Zhipu web_search API key for the agent-runner container.
 * Priority: host env ZHIPU_API_KEY > parsed ~/zhipu_web_search/.env (task-designated project).
 * Returns undefined if neither source yields a key — non-fatal (web_search tool returns a clear error).
 */
function resolveZhipuApiKey(): string | undefined {
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY.trim();
  const envPath = process.env.ZHIPU_WEB_SEARCH_ENV || '/home/me/zhipu_web_search/.env';
  try {
    const txt = fs.readFileSync(envPath, 'utf8');
    const m = txt.match(/^ZHIPU_API_KEY\s*=\s*(\S+)/m);
    if (m) return m[1].trim();
  } catch {
    /* file absent / unreadable — skip silently */
  }
  return undefined;
}

/** Read existing settings.json, deep-merge required env keys and mcpServers, write only if changed */
function ensureSettingsJson(
  settingsFile: string,
  mcpServers?: Record<string, Record<string, unknown>>,
): void {
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsFile)) {
      existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch {
    /* ignore parse errors, overwrite */
  }

  const existingEnv = (existing.env as Record<string, string>) || {};
  const mergedEnv = { ...existingEnv, ...REQUIRED_SETTINGS_ENV };
  const merged: Record<string, unknown> = { ...existing, env: mergedEnv };

  // Merge user-configured MCP servers into settings
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    const existingMcp = (existing.mcpServers as Record<string, unknown>) || {};
    merged.mcpServers = { ...existingMcp, ...mcpServers };
  }

  const newContent = JSON.stringify(merged, null, 2) + '\n';

  // Only write when content actually changed
  try {
    if (fs.existsSync(settingsFile)) {
      const current = fs.readFileSync(settingsFile, 'utf8');
      if (current === newContent) return;
    }
  } catch {
    /* write anyway */
  }

  fs.writeFileSync(settingsFile, newContent, { mode: 0o644 });
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  /** Source JID of the latest message that triggered this run (e.g. `discord:123…`).
   * Used by per-channel MCP tools (discord_*, etc.) to identify the current
   * incoming chat. Undefined when chatJid already encodes the IM source. */
  currentSourceJid?: string;
  /** @deprecated Use isHome + isAdminHome instead */
  isMain: boolean;
  turnId?: string;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Isolated task run ID — determines IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** If the last unprocessed message was emitted by a scheduled task prompt,
   * this is that task's ID; propagated into agent-runner so MCP send_message
   * outputs can be attributed back to the task record. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  /**
   * Claude Code plugins to inject into the SDK query (via `options.plugins`).
   * Populated just-in-time by runContainerAgent/runHostAgent from the owner's
   * plugins.json; never set by the caller.
   */
  plugins?: Array<{ type: 'local'; path: string }>;
  /** Runtime context audit bootstrap; agent-runner enriches it with SDK usage. */
  contextAudit?: ClaudeContextAudit;
  /**
   * User's preferred response language (BCP-47-ish code, e.g. 'zh-CN', 'en').
   * Injected into the agent's system prompt as a "respond in this language"
   * directive. Defaults to 'zh-CN' when undefined.
   */
  userLanguage?: string;
  /**
   * Agent execution engine. 'claude' (default, Claude Agent SDK) or 'atomcode'
   * (open-source Rust coding agent via atomcode-daemon HTTP/SSE). 'pi' routes
   * to pi-engine.ts which drives `pi --mode rpc` stdio JSONL.
   * When 'atomcode'/'codex'/'opencode'/'pi', agent-runner branches to the
   * corresponding *-engine.ts instead of calling SDK query().
   */
  engine?: 'claude' | 'atomcode' | 'codex' | 'opencode' | 'pi';
  /** Agent PaaS: 用户自定义 Agent 定义 + 挂载资源（已展平）。 */
  agentDefinition?: {
    id: string;
    systemPrompt?: string;
    model?: string | null;
    maxTurns?: number | null;
    temperature?: number | null;
    mounts: Array<{
      resourceType: 'mcp_server' | 'skill' | 'knowledge_base';
      resourceId: string;
      resourceName?: string;
      mcpConfig?: {
        type: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
      };
      kbId?: string;
      kbName?: string;
    }>;
  };
  /**
   * Super Agent Team: graph linkage. When set (agent node executed by
   * graph-runner), agent-runner tags its trace nodes + tool calls with these
   * so the node-internal sub-graph is traceable. Propagated through the
   * dockerInput/hostInput spreads (no container-runner logic change). Optional
   * — undefined for non-graph (plain chat) runs.
   */
  graphRunId?: string;
  graphNodeId?: string;
  /** Reminder mechanism config. When set and enabled, the agent-runner
   *  periodically re-injects the task goal (via MessageStream.push) to counter
   *  context decay in long tasks, and emits reminder_injected stream events
   *  for the chat UI's Reminder panel. Optional — undefined disables injection. */
  reminderConfig?: {
    enabled: boolean;
    intervalSteps: number;
    goalSnippet: string;
  };
  /** 全托管模式开关：true 时 agent 在单次任务执行期间不主动停下询问用户。
   *  Supervisor clarify 被禁用、端回合检测到提问信号时自动注入续接消息、
   *  硬刹车（轮次/token/循环/破坏性命令）触发时强制退出。 */
  autonomous?: boolean;
  /** 全托管硬刹车上限：轮次计数到 maxTurns 即停止。默认 50。 */
  maxTurns?: number;
  /** 全托管硬刹车上限：累计 token 用量到 maxTokens 即停止。默认 1,000,000。 */
  maxTokens?: number;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  providerFailure?: boolean;
  streamEvent?: StreamEvent;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  /** 'truncated'：上游断流截断的 partial（usage 双零指纹，runner 会自动续写） */
  finalizationReason?: 'completed' | 'interrupted' | 'error' | 'truncated';
  /** 本 result 发出时仍未 settle 的后台任务数（异步 Agent / backgrounded Bash）。
   * >0 时主进程把流式卡片保持在「后台任务运行中」而非定稿。 */
  pendingBgTasks?: number;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Create directory with 0o777 permissions for container volume mounts.
 * Fixes uid mismatch between host user and container node user (uid 1000),
 * especially in rootless podman where uid remapping causes permission denied.
 */
function mkdirForContainer(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    fs.chmodSync(dirPath, 0o777);
  } catch {
    // Ignore — may fail on read-only filesystem or special mounts
  }
}

interface ResolvedProvider {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
}

/**
 * One-time provider overrides per group folder.
 * Set by switchProvider(), consumed (and deleted) by trySelectPoolProvider().
 */
const providerOverrides = new Map<string, string>();

export function setProviderOverride(groupFolder: string, providerId: string): void {
  providerOverrides.set(groupFolder, providerId);
}

/**
 * Read-only prediction of whether the next provider selection will *clear* the
 * resumable Claude session because it has to switch away from the bound
 * provider (the binding is unhealthy or no longer enabled, or a one-time
 * override targets a different provider). Mirrors the `resetSession` conditions
 * in trySelectPoolProvider without mutating sticky bindings.
 *
 * The orchestration layer calls this *before* building the prompt so a
 * proactive provider switch injects recent conversation history into the fresh
 * session — matching the reactive (mid-stream provider-failure) path. Without
 * this, the first turn under the new provider would see an empty conversation.
 *
 * Conservative by design: a false positive only injects redundant history
 * (harmless), never the reverse.
 */
export function willClearSessionOnProviderSwitch(
  groupFolder: string,
  agentId?: string | null,
): boolean {
  // Env-level provider override means the pool is bypassed entirely — no
  // pool-driven switch, so the session is never cleared on this account.
  const override = getContainerEnvConfig(groupFolder);
  if (
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  ) {
    return false;
  }

  const boundId = getSessionProviderId(groupFolder, agentId);
  if (!boundId) return false;

  // One-time override (from switchProvider) targeting a different provider will
  // reset. Peek without consuming — trySelectPoolProvider consumes it later.
  const overrideProviderId = providerOverrides.get(groupFolder);
  if (overrideProviderId) {
    return overrideProviderId !== boundId;
  }

  const enabledProviders = getEnabledProviders();
  if (enabledProviders.length === 0) return false;

  // Bound provider removed/disabled → a fresh one gets picked → reset.
  const stillEnabled = enabledProviders.some((p) => p.id === boundId);
  if (!stillEnabled) return true;

  // Single enabled provider equal to the binding → sticky, no reset.
  if (enabledProviders.length === 1) {
    return enabledProviders[0].id !== boundId;
  }

  // Multiple providers: sticky reuse only when the binding is still healthy.
  // Unhealthy binding falls through to pool selection, which prefers a
  // different healthy provider → reset.
  const balancing = getBalancingConfig();
  providerPool.refreshFromConfig(enabledProviders, balancing);
  return !providerPool.getHealthStatus(boundId).healthy;
}

/**
 * Try to select a provider from the pool. Returns profileId + resolved config,
 * or null if no providers are enabled / group has env-level provider override / selection fails.
 * For single-provider setups, returns the provider for display without pool balancing.
 * One-time overrides (from switchProvider) are consumed on use.
 *
 * Session-sticky binding (when groupFolder + agentId identifies a resumable Claude
 * session): if the session has a previously-bound provider that is still enabled,
 * prefer it over load-balancing. This prevents "Invalid signature in thinking
 * block" 400 errors when a conversation that produced thinking blocks under
 * provider A gets resumed in a fresh container that the pool routes to provider B
 * (different OAuth account / API key). Each successful selection updates the
 * binding via setSessionProviderId().
 */
function trySelectPoolProvider(
  groupFolder: string,
  agentId?: string | null,
): {
  profileId: string;
  resolved: ResolvedProvider;
  previousProviderId?: string;
  resetSession?: boolean;
} | null {
  const override = getContainerEnvConfig(groupFolder);
  const hasOverride = !!(
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  );
  if (hasOverride) return null;

  const existingBoundId = getSessionProviderId(groupFolder, agentId);

  // Check one-time override (consumed on use)
  const overrideProviderId = providerOverrides.get(groupFolder);
  if (overrideProviderId) {
    providerOverrides.delete(groupFolder);
    try {
      const resolved = resolveProviderById(overrideProviderId);
      providerPool.acquireSession(overrideProviderId);
      // Override path also updates sticky binding so subsequent runs follow.
      setSessionProviderId(groupFolder, agentId, overrideProviderId);
      logger.info(
        { groupFolder, providerId: overrideProviderId },
        'Using one-time provider override',
      );
      return {
        profileId: overrideProviderId,
        resolved: { config: resolved.config, customEnv: resolved.customEnv },
        previousProviderId: existingBoundId,
        resetSession:
          !!existingBoundId && existingBoundId !== overrideProviderId,
      };
    } catch (err) {
      logger.warn(
        { err, providerId: overrideProviderId },
        'Provider override failed, falling back to pool',
      );
    }
  }

  // Refresh pool state from V4 config
  const enabledProviders = getEnabledProviders();
  if (enabledProviders.length === 0) return null;
  const balancing = getBalancingConfig();
  providerPool.refreshFromConfig(enabledProviders, balancing);
  const boundId = existingBoundId;

  // Sticky path: respect previous session→provider binding when the bound
  // provider is still enabled. Skip when only one provider exists (single
  // provider already gives stickiness implicitly).
  if (enabledProviders.length > 1) {
    if (boundId && enabledProviders.some((p) => p.id === boundId)) {
      const boundHealth = providerPool.getHealthStatus(boundId);
      if (!boundHealth.healthy) {
        logger.info(
          { groupFolder, agentId: agentId || null, providerId: boundId },
          'Sticky provider is unhealthy, falling back to pool selection',
        );
      } else {
        try {
          const resolved = resolveProviderById(boundId);
          providerPool.acquireSession(boundId);
          logger.debug(
            { groupFolder, agentId: agentId || null, providerId: boundId },
            'Reusing sticky provider binding for resumed session',
          );
          return {
            profileId: boundId,
            resolved: {
              config: resolved.config,
              customEnv: resolved.customEnv,
            },
          };
        } catch (err) {
          logger.warn(
            { err, providerId: boundId },
            'Sticky provider resolution failed, falling back to pool selection',
          );
        }
      }
    } else if (boundId) {
      // Bound provider was disabled or removed — fall through and pick a fresh one.
      logger.info(
        { groupFolder, agentId: agentId || null, providerId: boundId },
        'Sticky provider no longer enabled, falling back to pool selection',
      );
    }
  }

  // Single provider: return its ID for display, acquire session for consistency
  if (enabledProviders.length === 1) {
    try {
      const resolved = resolveProviderById(enabledProviders[0].id);
      providerPool.acquireSession(enabledProviders[0].id);
      setSessionProviderId(groupFolder, agentId, enabledProviders[0].id);
      return {
        profileId: enabledProviders[0].id,
        resolved: { config: resolved.config, customEnv: resolved.customEnv },
        previousProviderId: boundId,
        resetSession: !!boundId && boundId !== enabledProviders[0].id,
      };
    } catch {
      return null;
    }
  }

  try {
    const profileId = providerPool.selectProvider();
    const resolved = resolveProviderById(profileId);
    providerPool.acquireSession(profileId);
    setSessionProviderId(groupFolder, agentId, profileId);
    return {
      profileId,
      resolved: { config: resolved.config, customEnv: resolved.customEnv },
      previousProviderId: boundId,
      resetSession: !!boundId && boundId !== profileId,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Provider pool selection failed, falling back to active profile',
    );
    return null;
  }
}

/**
 * Best-effort pre-spawn materialize for host-mode plugins. Mirrors the docker
 * path's behaviour in `buildVolumeMounts`: v2 config can exist before the
 * runtime/ tree is built (first enable, or after orphan GC), and
 * `loadUserPlugins({runtime:'host'})` only emits paths whose manifests exist
 * on disk. Without this call host agents would silently start with 0 plugins
 * even when the user has plugins enabled. Failure is logged, never thrown —
 * the agent simply starts with whatever subset is already materialized.
 */
export function prepareHostPlugins(ownerId: string | null | undefined): SdkPluginConfig[] {
  if (!ownerId) return [];
  try {
    materializeUserRuntime(ownerId);
  } catch (err) {
    logger.warn(
      { ownerId, err },
      'prepareHostPlugins: materializeUserRuntime failed; host agent will see no plugins',
    );
  }
  // Drop the user's command index cache so a stale empty entry (e.g. a prior
  // /commands hit before runtime existed, see plugin-command-index.ts:235) is
  // rebuilt against the now-materialized tree. Invalidate on both success and
  // failure paths: a partial materialize still wants the cache rebuilt.
  invalidateUserCommandIndex(ownerId);
  return loadUserPlugins(ownerId, { runtime: 'host' });
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isAdminHome: boolean,
  mountUserSkills = true,
  agentId?: string,
  ownerHomeFolder?: string,
  taskRunId?: string,
  resolvedProvider?: ResolvedProvider,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  // Per-user global memory directory:
  // Each user gets their own user-global/{userId}/ mounted as /workspace/global
  const ownerId = group.created_by;
  if (ownerId) {
    const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
    mkdirForContainer(userGlobalDir);
    mounts.push({
      hostPath: userGlobalDir,
      containerPath: '/workspace/global',
      readonly: !group.is_home,
    });
  } else {
    // Legacy fallback for rows without created_by.
    const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
    mkdirForContainer(legacyGlobalDir);
    mounts.push({
      hostPath: legacyGlobalDir,
      containerPath: '/workspace/global',
      readonly: !isAdminHome,
    });
  }

  if (isAdminHome) {
    // Admin home gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Admin home also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Member home and non-home groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Memory directory: home containers write their own; non-home containers read owner's home memory
  const memoryFolder = group.is_home
    ? group.folder
    : ownerHomeFolder || group.folder;
  const memoryDir = path.join(DATA_DIR, 'memory', memoryFolder);
  mkdirForContainer(memoryDir);
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/memory',
    readonly: !group.is_home,
  });

  // Per-group Claude sessions directory (isolated from other groups)
  // Sub-agents get their own session dir under agents/{agentId}/.claude/
  const groupSessionsDir = agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  mkdirForContainer(groupSessionsDir);
  const claudeContextPlan = buildClaudeContextPlan({
    executionMode: 'container',
    group,
    ownerHomeFolder,
    externalClaudeDir: getEffectiveExternalDir(),
    projectRoot,
    dataDir: DATA_DIR,
    groupSessionsDir,
    mountUserSkills,
  });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const mcpServers = ownerId ? loadUserMcpServers(ownerId) : {};
  ensureSettingsJson(settingsFile, mcpServers);

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // 清理 session 目录中 SDK 遗留的 .claude.json（含 cachedGrowthBookFeatures，会导致初始化挂起）。
  // 精简版（不含 feature flags）约 200-400B，SDK 写回的完整版通常 > 10KB。
  const STRIPPED_CLAUDE_JSON_MAX_SIZE = 500;
  const sessionClaudeJson = path.join(groupSessionsDir, '.claude.json');
  try {
    const st = fs.lstatSync(sessionClaudeJson);
    if (!st.isSymbolicLink() && st.size > STRIPPED_CLAUDE_JSON_MAX_SIZE) {
      fs.unlinkSync(sessionClaudeJson);
    }
  } catch { /* not found, ok */ }

  // 挂载精简版 .claude.json（剥离 cachedGrowthBookFeatures），保留 deviceId 一致性
  const containerJson = getContainerClaudeJsonPath();
  mounts.push({
    hostPath: containerJson,
    containerPath: '/home/node/.claude.json',
    readonly: true,
  });

  // Skills：以只读卷挂载宿主机目录（由 entrypoint 创建符号链接）
  // 用户的所有 skills 在其所有工作区中全量生效
  const projectSkillsDir = claudeContextPlan.projectSkillsDir;
  const userSkillsDir = claudeContextPlan.userSkillsDir ?? null;

  // Ensure user skills directory exists so it can always be mounted.
  // Skills may be installed after the group is created; without pre-creating,
  // the existsSync check would skip mounting and the container would never see them.
  if (userSkillsDir) {
    fs.mkdirSync(userSkillsDir, { recursive: true });
  }

  // 全量挂载：用户的所有 skills 在所有工作区中生效
  if (fs.existsSync(projectSkillsDir)) {
    mounts.push({
      hostPath: projectSkillsDir,
      containerPath: '/workspace/project-skills',
      readonly: true,
    });
  }
  if (userSkillsDir) {
    mounts.push({
      hostPath: userSkillsDir,
      containerPath: '/workspace/user-skills',
      readonly: true,
    });
  }

  // Per-user feishu-cli OAuth state (token.json + config.yaml).
  // Without this mount, every container restart loses the user's feishu OAuth
  // authorization, forcing re-auth every IDLE_TIMEOUT (#477).
  if (ownerId) {
    const userFeishuCliDir = path.join(
      DATA_DIR,
      'config',
      'user-cli',
      ownerId,
      'feishu-cli',
    );
    mkdirForContainer(userFeishuCliDir);
    mounts.push({
      hostPath: userFeishuCliDir,
      containerPath: '/home/node/.feishu-cli',
      readonly: false,
    });
  }

  // Claude Code plugins (per-user runtime): read-only mount so the CLI inside
  // the container can load the same plugin directories referenced by
  // ContainerInput.plugins.
  //
  // Admin home runs in `host` mode and bypasses container mounts entirely,
  // so plugin materialization for that path happens inside runHostAgent's
  // host-runtime loadUserPlugins. Here we only handle docker-mode containers.
  //
  // Materialize is synchronous so the runtime tree is on disk before the mount
  // source is picked — loadUserPlugins(docker) returns paths shaped like
  // /workspace/plugins/snapshots/{snap}/{mp}/{plugin}, which only resolve when
  // runtime/{userId}/ is mounted at /workspace/plugins. The runtime root is
  // mkdir'd unconditionally so the bind mount target exists even for users
  // with no enabled plugins yet (an empty mount surfaces nothing to the CLI,
  // matching their config).
  if (ownerId) {
    const runtimeRoot = getUserRuntimeRoot(ownerId);
    fs.mkdirSync(runtimeRoot, { recursive: true });
    try {
      materializeUserRuntime(ownerId);
    } catch (err) {
      logger.warn(
        { ownerId, err },
        'buildVolumeMounts: materializeUserRuntime failed; container will see no plugins',
      );
    }
    // Mirror prepareHostPlugins: drop a stale empty command index that may
    // have been cached before this runtime tree existed (plugin-command-index.ts:235).
    invalidateUserCommandIndex(ownerId);
    mounts.push({
      hostPath: runtimeRoot,
      containerPath: CONTAINER_PLUGINS_PATH,
      readonly: true,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // Sub-agents get their own IPC subdirectory under agents/{agentId}/
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  // Use 0o777 so container (node/1000) and host (agent/1002) can both read/write.
  const groupIpcDir = agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', agentId)
    : taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  mkdirForContainer(groupIpcDir);
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  // Use chmod 777 so both host (agent/1002) and container (node/1000) can write
  for (const sub of ['messages', 'tasks', 'input', 'agents'] as const) {
    const subDir = path.join(groupIpcDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    try {
      fs.chmodSync(subDir, 0o777);
    } catch {
      /* ignore if already correct */
    }
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-container environment file (keeps credentials out of process listings)
  // Global config merged with per-container overrides.
  const envDir = path.join(DATA_DIR, 'env', group.folder);
  fs.mkdirSync(envDir, { recursive: true });
  const globalConfig = resolvedProvider?.config ?? getClaudeProviderConfig();
  const containerOverride = getContainerEnvConfig(group.folder);
  const envLines = buildContainerEnvLines(
    globalConfig,
    containerOverride,
    resolvedProvider?.customEnv,
  );
  // WebSearch 重写：注入智谱 web_search API Key 到 agent-runner 容器。
  // 优先 host env ZHIPU_API_KEY；其次解析 ~/zhipu_web_search/.env（任务指定的项目）。
  // 取不到不阻断启动，web_search 调用时返回明确 error。路径可用 ZHIPU_WEB_SEARCH_ENV 覆盖。
  const zhipuApiKey = resolveZhipuApiKey();
  if (zhipuApiKey) {
    envLines.push(`ZHIPU_API_KEY=${zhipuApiKey}`);
  }
  // SystemSettings.autoCompactWindow > 0 时注入到容器，让 agent-runner 通过 query() settings 传给 SDK
  const sysSettings = getSystemSettings();
  if (sysSettings.autoCompactWindow > 0) {
    envLines.push(`AUTO_COMPACT_WINDOW=${sysSettings.autoCompactWindow}`);
  }
  // SubAgent 模型：仅在显式配置了非默认值时注入。默认 'inherit' 与省略 model 等价，
  // 此时不注入，避免覆盖用户可能在 provider customEnv 里设的 SUBAGENT_MODEL（与 autoCompact 对称）。
  if (sysSettings.subagentModel && sysSettings.subagentModel !== 'inherit') {
    envLines.push(`SUBAGENT_MODEL=${sysSettings.subagentModel}`);
  }
  // AtomCode/Codex/OpenCode 引擎配置：注入到 /workspace/env-dir/env，agent-runner 读取
  // 对应二进制路径等环境变量。仅当 group.engine !== 'claude' 时注入。
  const groupEngine = (group.engine ?? 'claude') as
    | 'claude'
    | 'atomcode'
    | 'codex'
    | 'opencode'
    | 'pi';
  if (groupEngine === 'atomcode') {
    const atomcodeCfg = getAtomcodeConfig();
    if (!atomcodeCfg.enabled || !atomcodeCfg.binaryPath) {
      throw new Error(
        `Group ${group.folder} has engine=atomcode but AtomCode is not enabled or binaryPath is empty. Configure in Settings → AtomCode 引擎.`,
      );
    }
    envLines.push(`ATOMCODE_BINARY_PATH=${atomcodeCfg.binaryPath}`);
    envLines.push(`ATOMCODE_HOST=${atomcodeCfg.host || '127.0.0.1'}`);
    envLines.push(`ATOMCODE_BASE_PORT=${atomcodeCfg.basePort}`);
    envLines.push(`ATOMCODE_PORT_RANGE=${atomcodeCfg.portRange}`);
    if (atomcodeCfg.atomcodeHome) {
      envLines.push(`ATOMCODE_HOME=${atomcodeCfg.atomcodeHome}`);
    }
  }
  if (groupEngine === 'codex') {
    const codexCfg = getCodexConfig();
    if (!codexCfg.enabled || !codexCfg.binaryPath) {
      throw new Error(
        `Group ${group.folder} has engine=codex but Codex is not enabled or binaryPath is empty. Configure in Settings → Codex 引擎.`,
      );
    }
    envLines.push(`CODEX_BINARY_PATH=${codexCfg.binaryPath}`);
    envLines.push(`CODEX_DEFAULT_MODEL=${codexCfg.defaultModel}`);
    envLines.push(`CODEX_WORKING_DIR=${codexCfg.workingDir || '/workspace/group'}`);
    envLines.push(`CODEX_PROVIDERS_JSON=${JSON.stringify(codexCfg.providers).replace(/'/g, "'\\''")}`);
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
  if (groupEngine === 'opencode') {
    const opencodeCfg = getOpencodeConfig();
    if (!opencodeCfg.enabled || !opencodeCfg.binaryPath) {
      throw new Error(
        `Group ${group.folder} has engine=opencode but OpenCode is not enabled or binaryPath is empty. Configure in Settings → OpenCode 引擎.`,
      );
    }
    envLines.push(`OPENCODE_BINARY_PATH=${opencodeCfg.binaryPath}`);
    envLines.push(`OPENCODE_HOST=${opencodeCfg.host || '127.0.0.1'}`);
    envLines.push(`OPENCODE_BASE_PORT=${opencodeCfg.basePort}`);
    envLines.push(`OPENCODE_PORT_RANGE=${opencodeCfg.portRange}`);
    envLines.push(`OPENCODE_PASSWORD=${opencodeCfg.password}`);
    envLines.push(`OPENCODE_PROVIDER_ID=${opencodeCfg.providerID}`);
    envLines.push(`OPENCODE_MODEL_ID=${opencodeCfg.modelID}`);
    envLines.push(`OPENCODE_WORKING_DIR=${opencodeCfg.workingDir || '/workspace/group'}`);
    envLines.push(`OPENCODE_PROVIDERS_JSON=${JSON.stringify(opencodeCfg.providers).replace(/'/g, "'\\''")}`);
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
  if (envLines.length > 0) {
    const envFilePath = path.join(envDir, 'env');
    const quotedLines = shellQuoteEnvLines(envLines);
    fs.writeFileSync(envFilePath, quotedLines.join('\n') + '\n', {
      mode: 0o600,
    });
    try {
      fs.chmodSync(envFilePath, 0o600);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to enforce env file permissions',
      );
    }
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  }

  // Write .credentials.json for OAuth credentials (session dir is already mounted)
  const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
  if (mergedConfig.claudeOAuthCredentials) {
    try {
      writeCredentialsFile(groupSessionsDir, mergedConfig);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to write .credentials.json',
      );
    }
  }

  // Third-party provider: remove any stale .credentials.json so the SDK
  // does not detect OAuth credentials from a previous official-provider run.
  if (mergedConfig.anthropicBaseUrl) {
    try {
      const staleCreds = path.join(groupSessionsDir, '.credentials.json');
      if (fs.existsSync(staleCreds)) fs.unlinkSync(staleCreds);
    } catch { /* ignore */ }
  }

  // Mount agent-runner source from host — recompiled on container startup.
  // Bypasses Docker 镜像构建缓存，确保代码变更生效。
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Admin's effective Claude config: mount CLAUDE.md and rules/ into /workspace/
  // so the SDK's directory traversal (cwd → root) discovers them at /workspace/ level.
  // Only for admin-created workspaces; ordinary users must not inherit host-global config.
  if (claudeContextPlan.isAdminOwned) {
    if (claudeContextPlan.claudeMdSource && fs.existsSync(claudeContextPlan.claudeMdSource)) {
      mounts.push({
        hostPath: claudeContextPlan.claudeMdSource,
        containerPath: '/workspace/CLAUDE.md',
        readonly: true,
      });
    }
    if (claudeContextPlan.rulesSourceDir && fs.existsSync(claudeContextPlan.rulesSourceDir)) {
      mounts.push({
        hostPath: claudeContextPlan.rulesSourceDir,
        containerPath: '/workspace/.claude/rules',
        readonly: true,
      });
    }
    if (claudeContextPlan.externalSkillsDir && fs.existsSync(claudeContextPlan.externalSkillsDir)) {
      mounts.push({
        hostPath: claudeContextPlan.externalSkillsDir,
        containerPath: '/workspace/external-skills',
        readonly: true,
      });
    }
  }

  // Per-group persistent extra directory: provides a durable /workspace/extra/ even when
  // no additionalMounts are configured. User-configured additionalMounts from the allowlist
  // are mounted as subdirectories (/workspace/extra/{name}) and overlay on top.
  const extraDir = path.join(DATA_DIR, 'extra', group.folder);
  mkdirForContainer(extraDir);
  mounts.push({
    hostPath: extraDir,
    containerPath: '/workspace/extra',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isAdminHome,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  tz: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Set timezone so container Node.js processes use local time (Asia/Shanghai)
  args.push('-e', `TZ=${tz}`);

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

/**
 * Agent PaaS: Load a group's bound Agent definition with mounts flattened.
 * Returns null when the group has no agent_def_id or the definition is missing.
 * Reads MCP servers from user's servers.json and flattens matching configs.
 */
function loadGroupAgentDefinition(
  agentDefId: string | null | undefined,
  ownerUserId: string | undefined,
): ContainerInput['agentDefinition'] {
  if (!agentDefId || !ownerUserId) return undefined;
  const def = getAgentDefinition(agentDefId, ownerUserId);
  if (!def) {
    logger.warn(
      { agentDefId, ownerUserId },
      'Agent definition not found for group; falling back to default behavior',
    );
    return undefined;
  }
  const mounts = listAgentMounts(agentDefId);
  const userMcpServers = loadUserMcpServers(ownerUserId);
  const flattened: NonNullable<NonNullable<ContainerInput['agentDefinition']>['mounts'][number]>[] = [];
  for (const m of mounts) {
    const resourceType = m.resource_type as 'mcp_server' | 'skill' | 'knowledge_base';
    const base: {
      resourceType: 'mcp_server' | 'skill' | 'knowledge_base';
      resourceId: string;
      resourceName?: string;
      mcpConfig?: {
        type: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
      };
      kbId?: string;
      kbName?: string;
    } = { resourceType, resourceId: m.resource_id };
    if (resourceType === 'mcp_server') {
      // loadUserMcpServers returns Record<serverId, config>. The key IS the id.
      const config = userMcpServers[m.resource_id];
      if (config) {
        base.resourceName = m.resource_id;
        base.mcpConfig = {
          type: typeof config.type === 'string' ? config.type : 'stdio',
          command: typeof config.command === 'string' ? config.command : undefined,
          args: Array.isArray(config.args) ? (config.args as string[]) : undefined,
          env: config.env && typeof config.env === 'object'
            ? (config.env as Record<string, string>)
            : undefined,
          url: typeof config.url === 'string' ? config.url : undefined,
        };
      } else {
        base.resourceName = '(MCP not found)';
      }
    } else if (resourceType === 'skill') {
      base.resourceName = m.resource_id;
    } else if (resourceType === 'knowledge_base') {
      const kb = getKnowledgeBase(m.resource_id, ownerUserId);
      base.resourceName = kb?.name ?? '(KB not found)';
      base.kbId = m.resource_id;
      base.kbName = kb?.name;
    }
    flattened.push(base);
  }
  return {
    id: def.id,
    systemPrompt: def.system_prompt || undefined,
    model: def.model,
    maxTurns: def.max_turns,
    temperature: def.temperature,
    mounts: flattened,
  };
}

/**
 * Agent PaaS: 写入 project-level CLAUDE.md 到工作区目录。
 *
 * 背景：admin 用户的测试对话组 / 生产组绑定 Agent 后，syncHostClaudeContext 会把
 * 全局 CLAUDE.md 模板（含 "你是 DeepThink" + "品牌口径" 强制规则）符号链接到
 * data/sessions/{folder}/.claude/CLAUDE.md，SDK 把它作为 user memory 加载，
 * 顺序在 systemPrompt.append 之后，覆盖了 <agent-definition> 里的自定义身份。
 *
 * 修复：当 Agent 有 systemPrompt 时，把 prompt 写到 data/groups/{folder}/CLAUDE.md，
 * SDK 把它作为 project memory 加载（在 user memory 之后），压在 "你是 DeepThink" 之上，
 * 让 Agent 自定义身份生效。Agent 有自己的 memory 可写到 MEMORY.md 等其他文件，
 * 提示文案中明确"不要修改上方身份段落"，降低被覆盖概率。
 *
 * 幂等：每次 Agent 启动都重写，确保 systemPrompt 最新。
 */
function writeAgentProjectClaudeMd(
  group: RegisteredGroup,
  agentDef: ContainerInput['agentDefinition'],
  autonomous?: boolean,
): void {
  // Autonomous override: even without agentDef.systemPrompt, write a CLAUDE.md
  // when autonomous=true so the autonomous directive is loaded as project memory.
  if (!agentDef?.systemPrompt && !autonomous) return;
  // Super Agent Team: graph agent nodes run in the shared owner folder but
  // carry their own systemPrompt via the <agent-definition> tag (injected by
  // agent-runner index.ts:1487). Skip the CLAUDE.md write so we don't clobber
  // the owner's group CLAUDE.md with a single member's identity (which would
  // also leak across parallel/serial team members). Agent Studio groups (no
  // marker) keep the existing write-to-project-CLAUDE.md behavior.
  // Autonomous override still applies (we DO want to write CLAUDE.md for
  // autonomous even on graph nodes — the directive must reach every agent).
  if (
    (group as unknown as { _graphAgentNode?: boolean })._graphAgentNode &&
    !autonomous
  ) {
    return;
  }
  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const content = buildAgentProjectClaudeMdContent(agentDef, autonomous);
  try {
    const tmp = `${claudeMdPath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, claudeMdPath);
  } catch (err) {
    logger.warn({ err, folder: group.folder }, 'Failed to write agent project CLAUDE.md');
  }
}

export function buildAgentProjectClaudeMdContent(
  agentDef: NonNullable<ContainerInput['agentDefinition']> | null | undefined,
  autonomous?: boolean,
): string {
  const parts: string[] = [];
  if (agentDef?.systemPrompt) {
    parts.push(
      '# Agent Identity（由 Agent Studio 注入）',
      '',
      agentDef.systemPrompt,
      '',
      '---',
      '',
      '## Identity Override（系统注入，请勿修改）',
      '',
      '本工作区正在运行用户在 Agent Studio 配置的自定义 Agent。该 Agent 的身份与行为由上方 `system_prompt` 定义，',
      '**优先级高于** `~/.claude/CLAUDE.md` 中的 "你是 DeepThink" / "品牌口径" 等身份断言。',
      '',
      '当用户问 "你是谁"、"你是做什么的"、"who are you" 等身份类问题时，**必须按上方 system_prompt 定义的角色身份作答**，',
      '不得回答 "DeepThink" 或平台默认身份，即使其他 memory 文件要求如此。',
      '',
      '如需记录会话记忆，请使用 `MEMORY.md` 或其他文件，不要修改或删除上方身份段落。',
      '',
    );
  }
  if (autonomous) {
    parts.push(
      '---',
      '',
      '## Autonomous Override（系统注入，本任务专用，请勿修改）',
      '',
      '本任务标记为 **全托管模式**（autonomous=true）。以下规则**显式压过** `Think Before Coding` 原则中的 "if unclear, halt and ask"：',
      '',
      '1. **禁止向用户提问**。不得调用 AskUserQuestion 工具，不得在文本中输出征询性短语（"你说一声"、"下一步要继续哪个方向"、"请确认"、"要扩展到 X 字吗" 等）。',
      '2. **缺失信息按合理假设推进**。在响应开头用 `<assumption>...</assumption>` 标签声明你的假设，然后继续执行。',
      '3. **方向分叉时按以下优先级决策**：',
      '   a. 推进进度 > 单节密度 > 篇幅',
      '   b. 任务已交付部分优先扩展至目标，再进入下一节',
      '   c. 任务未全部完成前禁止总结性收尾或征询下一步',
      '4. **唯一允许停止的情况**：硬刹车触发（轮次/token 超限、循环输出、破坏性命令检测）。这些由系统强制终止，你无需也无法干预。',
      '5. 如果你的最佳判断是"任务无法完成"（如目标本质不可达），**直接输出失败原因并停止**，不要询问用户怎么办。',
      '6. 本 override 仅在本任务期间生效，任务结束后自动失效。',
      '',
    );
  }
  return parts.join('\n');
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string, selectedProviderId: string | null) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);

  // ─── Provider Pool selection ───
  const poolResult = trySelectPoolProvider(group.folder, input.agentId);
  const selectedProfileId = poolResult?.profileId ?? null;
  const resolvedProvider = poolResult?.resolved;
  let providerFailureReported = false;
  if (poolResult?.resetSession && input.sessionId) {
    logger.info(
      {
        groupFolder: group.folder,
        agentId: input.agentId || null,
        previousProviderId: poolResult.previousProviderId,
        providerId: selectedProfileId,
      },
      'Clearing Claude session after switching providers',
    );
    // deleteSession removes the whole sessions row, including the provider_id
    // binding trySelectPoolProvider just wrote. Re-bind the freshly-selected
    // provider so the next turn stays sticky to it instead of degrading to a
    // fresh pool pick.
    deleteSession(group.folder, input.agentId);
    if (selectedProfileId) {
      setSessionProviderId(group.folder, input.agentId, selectedProfileId);
    }
    input = { ...input, sessionId: undefined };
  }

  try {
    // Determine if this is an admin home container (full privileges)
    const isAdminHome = !!group.is_home && group.folder === 'main';
    // Per-user skills: always mount if the group has an owner
    const shouldMountUserSkills = !!group.created_by;
    const mounts = buildVolumeMounts(
      group,
      isAdminHome,
      shouldMountUserSkills,
      input.agentId,
      ownerHomeFolder,
      input.taskRunId,
      resolvedProvider,
    );
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const agentSuffix = input.agentId
      ? `-${input.agentId.replace(/[^a-zA-Z0-9-]/g, '-')}`
      : '';
    const containerName = `deepthink-${safeName}${agentSuffix}-${Date.now()}`;
    const containerArgs = buildContainerArgs(mounts, containerName, TIMEZONE);

    logger.debug(
      {
        group: group.name,
        containerName,
        mounts: mounts.map(
          (m) =>
            `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        ),
        containerArgs: containerArgs.join(' '),
      },
      'Container mount configuration',
    );

    logger.info(
      {
        group: group.name,
        containerName,
        mountCount: mounts.length,
        isMain: input.isMain,
      },
      'Spawning container agent',
    );

    const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const result = await new Promise<ContainerOutput>((resolve) => {
      const container = spawn('docker', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      onProcess(container, containerName, selectedProfileId);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // Write input and close stdin (容器需要 EOF 来刷新 stdin 管道)
      container.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Container stdin write failed',
        );
        container.kill();
      });
      // Derive a new input with docker-runtime plugins injected; never mutate
      // the caller's `input` object (queue/log/retry paths reuse the same ref).
      const ownerLanguage = group.created_by
        ? getUserById(group.created_by)?.language ?? DEFAULT_LANGUAGE
        : DEFAULT_LANGUAGE;
      const engine = (group.engine ?? 'claude') as
        | 'claude'
        | 'atomcode'
        | 'codex'
        | 'opencode';
      const dockerAgentDef = loadGroupAgentDefinition(
        group.agentDefId,
        group.created_by,
      );
      writeAgentProjectClaudeMd(group, dockerAgentDef, input.autonomous);
      const dockerInput: ContainerInput = {
        ...input,
        userLanguage: input.userLanguage ?? ownerLanguage,
        engine,
        plugins: group.created_by
          ? loadUserPlugins(group.created_by, { runtime: 'docker' })
          : [],
        agentDefinition: dockerAgentDef,
        contextAudit: buildClaudeContextPlan({
          executionMode: 'container',
          group,
          ownerHomeFolder,
          externalClaudeDir: getEffectiveExternalDir(),
          projectRoot: process.cwd(),
          dataDir: DATA_DIR,
          groupSessionsDir: input.agentId
            ? path.join(DATA_DIR, 'sessions', group.folder, 'agents', input.agentId, '.claude')
            : path.join(DATA_DIR, 'sessions', group.folder, '.claude'),
          mountUserSkills: shouldMountUserSkills,
        }).audit,
      };
      container.stdin.write(JSON.stringify(dockerInput));
      container.stdin.end();

      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, containerName },
          'Container timeout, stopping gracefully',
        );
        execFile(
          'docker',
          ['stop', containerName],
          { timeout: 15000 },
          (err) => {
            if (err) {
              logger.warn(
                { group: group.name, containerName, err },
                'Graceful stop failed, force killing',
              );
              container.kill('SIGKILL');
            }
          },
        );
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };
      const handleOutput = onOutput
        ? async (output: ContainerOutput): Promise<void> => {
            await onOutput(output);
            if (output.providerFailure && selectedProfileId) {
              if (!providerFailureReported) {
                providerFailureReported = true;
                providerPool.reportFailure(selectedProfileId, true);
                logger.warn(
                  {
                    group: group.name,
                    containerName,
                    providerId: selectedProfileId,
                    result: output.result,
                  },
                  'Provider failure detected from streamed output, stopping container',
                );
              }
              exec(`docker stop ${containerName}`, (err) => {
                if (err) {
                  logger.warn(
                    { group: group.name, containerName, err },
                    'Failed to stop container after provider failure',
                  );
                  container.kill('SIGTERM');
                }
              });
            }
          }
        : undefined;

      // Attach stdout/stderr handlers using shared parser
      attachStdoutHandler(container.stdout, stdoutState, {
        groupName: group.name,
        label: 'Container',
        onOutput: handleOutput,
        resetTimeout,
      });
      attachStderrHandler(container.stderr, stderrState, group.name, {
        container: group.folder,
      });

      container.on('close', (code, signal) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Container',
          filePrefix: 'container',
          identifier: containerName,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput,
          resolvePromise: resolve,
          startTime,
          timeoutMs,
          extraSummaryLines: [
            ``,
            `=== Mounts ===`,
            mounts
              .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
              .join('\n'),
          ],
          extraVerboseLines: [
            `=== Container Args ===`,
            containerArgs.join(' '),
            ``,
            `=== Mounts (detailed) ===`,
            mounts
              .map(
                (m) =>
                  `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
              )
              .join('\n'),
          ],
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, containerName, error: err },
          'Container spawn error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container spawn error: ${err.message}`,
        });
      });
    });

    // ─── Provider Pool health reporting ───
    if (selectedProfileId) {
      if (result.providerFailure) {
        if (!providerFailureReported) {
          providerPool.reportFailure(selectedProfileId, true);
        }
      } else if (result.status === 'success' || result.status === 'closed') {
        providerPool.reportSuccess(selectedProfileId);
      } else if (result.status === 'error' && isApiError(result.error || '')) {
        providerPool.reportFailure(selectedProfileId);
      }
    }

    return result;
  } finally {
    // Guarantee session release even if buildVolumeMounts/spawn throws
    if (selectedProfileId) {
      providerPool.releaseSession(selectedProfileId);
    }
  }
}

export function writeTasksSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all tasks, others only see their own
  const filteredTasks = isAdminHome
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  // 删除后重建：容器创建的文件归属 node(1000) 用户，宿主机进程无法覆写
  try {
    fs.unlinkSync(tasksFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only admin home can see all available groups (for activation).
 * Other groups see nothing (they can't activate groups).
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isAdminHome ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  try {
    fs.unlinkSync(groupsFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * 杀死进程及其所有子进程。
 * 如果进程以 detached 模式启动（独立进程组），使用负 PID 杀整个进程组。
 */
export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
      return true;
    }
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * admin 主容器（is_home=1, folder=main）+ 系统设置 disableMemoryLayerForAdminHost 开启时，
 * DeepThink 记忆层被禁用，agent 完全按本机 ~/.claude/ Playbook 运行。
 * 供 host 启动路径多处复用，保证判断口径一致。
 */
function isAdminHomeMemoryDisabled(
  ownerHomeFolder: string | undefined,
  group: RegisteredGroup,
): boolean {
  return (
    ownerHomeFolder === 'main' &&
    !!group.is_home &&
    getSystemSettings().disableMemoryLayerForAdminHost
  );
}

/**
 * Run agent directly on the host machine (no Docker container).
 * Used for host execution mode — the agent gets full access to the host filesystem.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, identifier: string, selectedProviderId: string | null) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const setupInstallHint = 'npm --prefix container/agent-runner install';
  const setupBuildHint = 'npm --prefix container/agent-runner run build';
  const hostModeSetupError = (message: string): ContainerOutput => ({
    status: 'error',
    result: `宿主机模式启动失败：${message}`,
    error: message,
  });

  // 1. 确定工作目录
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  if (!group.customCwd) {
    fs.mkdirSync(defaultGroupDir, { recursive: true });
    // 确保 group 目录是独立 git root，防止 Claude Code 向上找到父项目的 .git
    const gitDir = path.join(defaultGroupDir, '.git');
    if (!fs.existsSync(gitDir)) {
      try {
        execFileSync('git', ['init'], {
          cwd: defaultGroupDir,
          stdio: 'ignore',
        });
        logger.info(
          { folder: group.folder },
          'Initialized git repository for group',
        );
      } catch (err) {
        // Non-fatal: agent still works, just reports wrong working directory
        logger.warn(
          { folder: group.folder, err },
          'Failed to initialize git repository',
        );
      }
    }
  }
  let groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return hostModeSetupError(`工作目录必须是绝对路径：${groupDir}`);
  }
  // Resolve symlinks to prevent TOCTOU attacks
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return hostModeSetupError(`工作目录不存在或无法解析：${groupDir}`);
  }
  if (!fs.statSync(groupDir).isDirectory()) {
    return hostModeSetupError(`工作目录不是目录：${groupDir}`);
  }

  // Runtime allowlist validation for custom CWD (defense-in-depth: web.ts validates at creation,
  // but re-check here in case allowlist was tightened or path was injected via DB)
  if (group.customCwd) {
    const allowlist = loadMountAllowlist();
    if (
      allowlist &&
      allowlist.allowedRoots &&
      allowlist.allowedRoots.length > 0
    ) {
      let allowed = false;
      for (const root of allowlist.allowedRoots) {
        const expandedRoot = root.path.startsWith('~')
          ? path.join(
              process.env.HOME || os.homedir(),
              root.path.slice(root.path.startsWith('~/') ? 2 : 1),
            )
          : path.resolve(root.path);

        let realRoot: string;
        try {
          realRoot = fs.realpathSync(expandedRoot);
        } catch {
          continue;
        }

        const relative = path.relative(realRoot, groupDir);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return hostModeSetupError(
          `工作目录 ${groupDir} 不在允许的根目录下，请检查 mount-allowlist.json`,
        );
      }
    }
  }

  // Always store logs in data/groups/{folder}/logs/, not in customCwd
  const logsBaseDir = path.join(defaultGroupDir, 'logs');
  fs.mkdirSync(logsBaseDir, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'memory', group.folder), {
    recursive: true,
  });

  // 2. 确保目录结构（宿主机模式下限制目录权限）
  // Sub-agents get their own IPC and session directories
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
    : input.taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', input.taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), {
    recursive: true,
    mode: 0o700,
  });
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  fs.mkdirSync(path.join(groupIpcDir, 'agents'), {
    recursive: true,
    mode: 0o700,
  });

  const groupSessionsDir = input.agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        input.agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Symlink .claude.json 到宿主机 ~/.claude.json，确保 deviceId 一致
  const localJson = path.join(groupSessionsDir, '.claude.json');
  ensureSymlinkTo(localJson, ensureHostClaudeJson());

  // 3. 写入 settings.json（合并模式，不覆盖已有用户配置）
  // Load user's global MCP servers (same logic as Docker mode).
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const hostMcpServers = group.created_by ? loadUserMcpServers(group.created_by) : {};
  ensureSettingsJson(settingsFile, hostMcpServers);

  // 4. Skills / Rules / CLAUDE.md 自动链接到 session 目录
  // deepthinkMemoryActive：记忆层未禁用 + admin 原生 ~/.claude/CLAUDE.md 并存时触发 audit 告警。
  // 与下方 disableMemoryLayer 同源（共用 isAdminHomeMemoryDisabled），口径保持一致。
  const hostClaudeContextPlan = buildClaudeContextPlan({
    executionMode: 'host',
    group,
    ownerHomeFolder,
    externalClaudeDir: getEffectiveExternalDir(),
    projectRoot: process.cwd(),
    dataDir: DATA_DIR,
    groupSessionsDir,
    deepthinkMemoryActive: !isAdminHomeMemoryDisabled(ownerHomeFolder, group),
  });
  const hostClaudeContextSync = syncHostClaudeContext(
    hostClaudeContextPlan,
    groupSessionsDir,
  );
  hostClaudeContextPlan.audit.claudeMd.status = hostClaudeContextSync.claudeMdStatus;
  hostClaudeContextPlan.audit.warnings = hostClaudeContextSync.warnings;

  // 5. 构建环境变量
  const groupEngine = (group.engine ?? 'claude') as
    | 'claude'
    | 'atomcode'
    | 'codex'
    | 'opencode'
    | 'pi';
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  // Strip macOS launch-context vars that must not be inherited by child
  // processes. When deepthink is started by a background process manager
  // (pm2 / launchd / ssh / cron) outside a normal login session, XPC_FLAGS=0x2
  // leaks into the environment. The bundled bun/CFNetwork-based claude CLI then
  // can't reach mDNSResponder/securityd through XPC, so DNS resolution and the
  // system CA store fail and every model request dies with FailedToOpenSocket.
  // Plain Node uses its own resolver/TLS stack and is unaffected, which is why
  // this only breaks the host agent. The var is meaningless to a child spawned
  // in a different way, so dropping it restores normal name resolution. No-op
  // on non-macOS hosts (the var does not exist there).
  delete hostEnv['XPC_FLAGS'];

  // ─── Provider Pool selection (host mode) ───
  const containerOverride = getContainerEnvConfig(group.folder);
  const hostPoolResult = trySelectPoolProvider(group.folder, input.agentId);
  const hostSelectedProfileId = hostPoolResult?.profileId ?? null;
  const globalConfig = hostPoolResult?.resolved.config ?? getClaudeProviderConfig();
  let hostProviderFailureReported = false;
  if (hostPoolResult?.resetSession && input.sessionId) {
    logger.info(
      {
        groupFolder: group.folder,
        agentId: input.agentId || null,
        previousProviderId: hostPoolResult.previousProviderId,
        providerId: hostSelectedProfileId,
      },
      'Clearing Claude session after switching providers',
    );
    // deleteSession removes the whole sessions row, including the provider_id
    // binding trySelectPoolProvider just wrote. Re-bind so the next turn stays
    // sticky to the freshly-selected provider (mirrors the container path).
    deleteSession(group.folder, input.agentId);
    if (hostSelectedProfileId) {
      setSessionProviderId(group.folder, input.agentId, hostSelectedProfileId);
    }
    input = { ...input, sessionId: undefined };
  }

  try {
    // 配置层环境变量
    const envLines = buildContainerEnvLines(
      globalConfig,
      containerOverride,
      hostPoolResult?.resolved.customEnv,
    );
    const injectsAnthropicAuthToken = envLines.some((line) =>
      line.startsWith('ANTHROPIC_AUTH_TOKEN='),
    );
    for (const line of envLines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        hostEnv[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
    }

    // Third-party provider: unless this provider explicitly injects
    // ANTHROPIC_AUTH_TOKEN (Bearer proxy mode), remove any inherited host token
    // so API-key mode can take effect.
    if (hostEnv['ANTHROPIC_BASE_URL']) {
      if (!injectsAnthropicAuthToken) {
        delete hostEnv['ANTHROPIC_AUTH_TOKEN'];
      }

      // Also strip oauthAccount from session .claude.json: the SDK detects
      // OAuth credentials in .claude.json and takes the OAuth code path even
      // when ANTHROPIC_AUTH_TOKEN is absent. This causes the same 404 on
      // third-party endpoints. Remove the symlink and write a standalone
      // .claude.json without oauthAccount so the SDK falls back to API key mode.
      try {
        const sessionClaudeJson = path.join(groupSessionsDir, '.claude.json');
        try { fs.unlinkSync(sessionClaudeJson); } catch { /* ignore */ }
        let claudeJson: Record<string, unknown> = {};
        try {
          claudeJson = JSON.parse(fs.readFileSync(getHostClaudeJsonPath(), 'utf-8'));
        } catch { /* ignore */ }
        delete claudeJson.oauthAccount;
        fs.writeFileSync(sessionClaudeJson, JSON.stringify(claudeJson, null, 2) + '\n', { mode: 0o600 });
      } catch (err) {
        logger.warn(
          { folder: group.folder, err },
          'Failed to strip oauthAccount from session .claude.json',
        );
      }

      // Also remove .credentials.json: it contains valid OAuth tokens that the
      // SDK uses regardless of env vars, forcing the OAuth auth path.
      try {
        const credsPath = path.join(groupSessionsDir, '.credentials.json');
        if (fs.existsSync(credsPath)) fs.unlinkSync(credsPath);
      } catch (err) {
        logger.warn(
          { folder: group.folder, err },
          'Failed to remove .credentials.json for third-party provider',
        );
      }
    }

    // Write .credentials.json for OAuth credentials
    const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
    if (mergedConfig.claudeOAuthCredentials) {
      try {
        writeCredentialsFile(groupSessionsDir, mergedConfig);
      } catch (err) {
        logger.warn(
          { folder: group.folder, err },
          'Failed to write .credentials.json for host agent',
        );
      }
    }

    // SystemSettings.autoCompactWindow > 0 时注入到 host 进程，agent-runner 通过 query() settings 传给 SDK
    const hostSysSettings = getSystemSettings();
    if (hostSysSettings.autoCompactWindow > 0) {
      hostEnv['AUTO_COMPACT_WINDOW'] = String(hostSysSettings.autoCompactWindow);
    }
    // SubAgent 模型：仅非默认 'inherit' 时注入，避免覆盖 customEnv 同名值。
    if (hostSysSettings.subagentModel && hostSysSettings.subagentModel !== 'inherit') {
      hostEnv['SUBAGENT_MODEL'] = hostSysSettings.subagentModel;
    }

    // 禁用 DeepThink 记忆层：不注入 memory MCP 工具 / WORKSPACE_GLOBAL/MEMORY env / 记忆提示，
    // 三件套仍通过同步后的 session .claude 生效，避免 externalClaudeDir 漂移。
    // 仅作用于 admin 主容器（is_home=1, folder=main），不影响 admin 创建的其他子群组。
    const disableMemoryLayer = isAdminHomeMemoryDisabled(ownerHomeFolder, group);

    // 路径映射
    hostEnv['DEEPTHINK_WORKSPACE_GROUP'] = groupDir;
    hostEnv['DEEPTHINK_WORKSPACE_IPC'] = groupIpcDir;

    if (!disableMemoryLayer) {
      // Per-user global memory（DeepThink 自带 memory 层）
      const ownerId = group.created_by;
      if (ownerId) {
        const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
        fs.mkdirSync(userGlobalDir, { recursive: true });
        hostEnv['DEEPTHINK_WORKSPACE_GLOBAL'] = userGlobalDir;
      } else {
        const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
        fs.mkdirSync(legacyGlobalDir, { recursive: true });
        hostEnv['DEEPTHINK_WORKSPACE_GLOBAL'] = legacyGlobalDir;
      }
      const memoryFolder = group.is_home
        ? group.folder
        : ownerHomeFolder || group.folder;
      hostEnv['DEEPTHINK_WORKSPACE_MEMORY'] = path.join(
        DATA_DIR,
        'memory',
        memoryFolder,
      );
    }

    // Resolve symlinks so CLAUDE_CONFIG_DIR ends up as the real on-disk path.
    // Host mode also goes through the synchronized session .claude directory so
    // explicit externalClaudeDir is authoritative for CLAUDE.md/rules/skills.
    let resolvedSessionsDir = groupSessionsDir;
    try {
      resolvedSessionsDir = fs.realpathSync(groupSessionsDir);
    } catch {
      // Path may not exist yet on first spawn; fall back to the literal path.
    }
    hostEnv['CLAUDE_CONFIG_DIR'] = resolvedSessionsDir;

    if (disableMemoryLayer) {
      hostEnv['DEEPTHINK_DISABLE_MEMORY_LAYER'] = 'true';
      // 直接注入到进程 env，SDK 按 process.env 读，避免 settings.json 合并差异影响必需项。
      for (const [key, value] of Object.entries(REQUIRED_SETTINGS_ENV)) {
        hostEnv[key] = value;
      }
      // 同样，per-user MCP servers 通过 env 透传，agent-runner 合并进 SDK mcpServers 参数。
      if (hostMcpServers && Object.keys(hostMcpServers).length > 0) {
        hostEnv['DEEPTHINK_USER_MCP_SERVERS_JSON'] =
          JSON.stringify(hostMcpServers);
      }
    }
    // 让 SDK 捕获 CLI 的 stderr 输出，便于排查启动失败
    hostEnv['DEBUG_CLAUDE_AGENT_SDK'] = '1';
    // WebSearch 重写：host 模式同样注入智谱 web_search API Key（与 docker 路径对称）。
    // 优先复用 host 进程既有 ZHIPU_API_KEY；否则从 ~/zhipu_web_search/.env 解析。
    if (!hostEnv['ZHIPU_API_KEY']) {
      const zhipuApiKey = resolveZhipuApiKey();
      if (zhipuApiKey) hostEnv['ZHIPU_API_KEY'] = zhipuApiKey;
    }
    // Claude Code 2.1.114+ 禁止 root 使用 --dangerously-skip-permissions，
    // IS_SANDBOX=1 告知 CLI 当前运行在受控环境中以绕过此限制。
    // host 模式由 deepthink 主进程托管（见 permissionMode: 'bypassPermissions'），
    // 相当于显式沙箱，故无条件声明而不再仅限 root —— 非 root 部署也保留语义对齐。
    hostEnv['IS_SANDBOX'] = '1';

    // AtomCode 引擎：注入 env vars 供 agent-runner 的 atomcode-engine.ts 读取
    if (groupEngine === 'atomcode') {
      const atomcodeCfg = getAtomcodeConfig();
      if (!atomcodeCfg.enabled || !atomcodeCfg.binaryPath) {
        return hostModeSetupError(
          'AtomCode 引擎未启用或二进制路径为空。请在 设置 → AtomCode 引擎 中配置。',
        );
      }
      hostEnv['ATOMCODE_BINARY_PATH'] = atomcodeCfg.binaryPath;
      hostEnv['ATOMCODE_HOST'] = atomcodeCfg.host || '127.0.0.1';
      hostEnv['ATOMCODE_BASE_PORT'] = String(atomcodeCfg.basePort);
      hostEnv['ATOMCODE_PORT_RANGE'] = String(atomcodeCfg.portRange);
      if (atomcodeCfg.atomcodeHome) {
        hostEnv['ATOMCODE_HOME'] = atomcodeCfg.atomcodeHome;
      }
      hostEnv['ATOMCODE_WORKING_DIR'] = groupDir;
    }

    // Determine admin-home flag locally for DT_* env injection (mirrors buildVolumeMounts)
    const isGroupAdminHome = !!group.is_home && group.folder === 'main';

    // Codex 引擎：注入 env vars 供 agent-runner 的 codex-engine.ts 读取
    if (groupEngine === 'codex') {
      const codexCfg = getCodexConfig();
      if (!codexCfg.enabled || !codexCfg.binaryPath) {
        return hostModeSetupError(
          'Codex 引擎未启用或二进制路径为空。请在 设置 → Codex 引擎 中配置。',
        );
      }
      hostEnv['CODEX_BINARY_PATH'] = codexCfg.binaryPath;
      hostEnv['CODEX_DEFAULT_MODEL'] = codexCfg.defaultModel;
      // Host 模式下 workingDir 必须是真实宿主机路径。codexCfg.workingDir 默认值
      // '/workspace/group' 是容器内挂载路径，宿主机不存在该目录 → spawn ENOENT
      // （Node 在 cwd 缺失时抛 spawn <cmd> ENOENT，错误名是命令但实际缺失的是 cwd）。
      // 仅当配置值在宿主机真实存在时采纳，否则回退到 groupDir（主机模式 group 工作目录）。
      hostEnv['CODEX_WORKING_DIR'] =
        codexCfg.workingDir && fs.existsSync(codexCfg.workingDir)
          ? codexCfg.workingDir
          : groupDir;
      // Inject providers JSON for codex-engine to write into temporary config.toml
      hostEnv['CODEX_PROVIDERS_JSON'] = JSON.stringify(codexCfg.providers);
      // MCP bridge context — propagated to the bridge subprocess via generated config.toml
      hostEnv['DT_CHAT_JID'] = `web:${group.folder}`;
      hostEnv['DT_GROUP_FOLDER'] = group.folder;
      hostEnv['DT_IS_HOME'] = String(!!group.is_home);
      hostEnv['DT_IS_ADMIN_HOME'] = String(isGroupAdminHome);
      hostEnv['DT_IPC_DIR'] = groupIpcDir;
      hostEnv['DT_WORKSPACE_GROUP'] = groupDir;
      if (hostEnv['DEEPTHINK_WORKSPACE_GLOBAL']) {
        hostEnv['DT_WORKSPACE_GLOBAL'] = hostEnv['DEEPTHINK_WORKSPACE_GLOBAL'];
      }
      if (hostEnv['DEEPTHINK_WORKSPACE_MEMORY']) {
        hostEnv['DT_WORKSPACE_MEMORY'] = hostEnv['DEEPTHINK_WORKSPACE_MEMORY'];
      }
      hostEnv['DT_DISABLE_MEMORY_LAYER'] = hostEnv['DEEPTHINK_DISABLE_MEMORY_LAYER'] ?? 'false';
    }

    // OpenCode 引擎：注入 env vars 供 agent-runner 的 opencode-engine.ts 读取
    if (groupEngine === 'opencode') {
      const opencodeCfg = getOpencodeConfig();
      if (!opencodeCfg.enabled || !opencodeCfg.binaryPath) {
        return hostModeSetupError(
          'OpenCode 引擎未启用或 binaryPath 为空。请在 设置 → OpenCode 引擎 中配置 opencode 二进制路径。',
        );
      }
      hostEnv['OPENCODE_BINARY_PATH'] = opencodeCfg.binaryPath;
      hostEnv['OPENCODE_HOST'] = opencodeCfg.host || '127.0.0.1';
      hostEnv['OPENCODE_BASE_PORT'] = String(opencodeCfg.basePort);
      hostEnv['OPENCODE_PORT_RANGE'] = String(opencodeCfg.portRange);
      hostEnv['OPENCODE_PASSWORD'] = opencodeCfg.password;
      hostEnv['OPENCODE_PROVIDER_ID'] = opencodeCfg.providerID;
      hostEnv['OPENCODE_MODEL_ID'] = opencodeCfg.modelID;
      hostEnv['OPENCODE_WORKING_DIR'] =
        opencodeCfg.workingDir && fs.existsSync(opencodeCfg.workingDir)
          ? opencodeCfg.workingDir
          : groupDir;
      // Inject providers JSON for opencode-engine to write into temporary opencode.jsonc
      hostEnv['OPENCODE_PROVIDERS_JSON'] = JSON.stringify(opencodeCfg.providers);
      // MCP bridge context
      hostEnv['DT_CHAT_JID'] = `web:${group.folder}`;
      hostEnv['DT_GROUP_FOLDER'] = group.folder;
      hostEnv['DT_IS_HOME'] = String(!!group.is_home);
      hostEnv['DT_IS_ADMIN_HOME'] = String(isGroupAdminHome);
      hostEnv['DT_IPC_DIR'] = groupIpcDir;
      hostEnv['DT_WORKSPACE_GROUP'] = groupDir;
      if (hostEnv['DEEPTHINK_WORKSPACE_GLOBAL']) {
        hostEnv['DT_WORKSPACE_GLOBAL'] = hostEnv['DEEPTHINK_WORKSPACE_GLOBAL'];
      }
      if (hostEnv['DEEPTHINK_WORKSPACE_MEMORY']) {
        hostEnv['DT_WORKSPACE_MEMORY'] = hostEnv['DEEPTHINK_WORKSPACE_MEMORY'];
      }
      hostEnv['DT_DISABLE_MEMORY_LAYER'] = hostEnv['DEEPTHINK_DISABLE_MEMORY_LAYER'] ?? 'false';
    }
    if (groupEngine === 'pi') {
      const piCfg = getPiConfig();
      if (!piCfg.enabled || !piCfg.binaryPath) {
        return hostModeSetupError(
          'pi 引擎未启用或 binaryPath 为空。请在 设置 → pi 引擎 中配置启动命令（binaryPath）。',
        );
      }
      hostEnv['PI_BINARY_PATH'] = piCfg.binaryPath;
      hostEnv['PI_CLI_SCRIPT_PATH'] = piCfg.cliScriptPath || '';
      hostEnv['PI_WORKING_DIR'] =
        piCfg.workingDir && fs.existsSync(piCfg.workingDir)
          ? piCfg.workingDir
          : groupDir;
      hostEnv['PI_DEFAULT_PROVIDER'] = piCfg.defaultProvider;
      hostEnv['PI_DEFAULT_MODEL'] = piCfg.defaultModel;
      hostEnv['PI_THINKING_LEVEL'] = piCfg.thinkingLevel;
      // Inject providers JSON for pi-engine to map provider→env API key / --api-key
      hostEnv['PI_PROVIDERS_JSON'] = JSON.stringify(piCfg.providers);
      // MCP bridge context (kept for parity; pi-engine first version does not bridge MCP)
      hostEnv['DT_CHAT_JID'] = `web:${group.folder}`;
      hostEnv['DT_GROUP_FOLDER'] = group.folder;
      hostEnv['DT_IS_HOME'] = String(!!group.is_home);
      hostEnv['DT_IS_ADMIN_HOME'] = String(isGroupAdminHome);
      hostEnv['DT_IPC_DIR'] = groupIpcDir;
      hostEnv['DT_WORKSPACE_GROUP'] = groupDir;
      if (hostEnv['DEEPTHINK_WORKSPACE_GLOBAL']) {
        hostEnv['DT_WORKSPACE_GLOBAL'] = hostEnv['DEEPTHINK_WORKSPACE_GLOBAL'];
      }
      if (hostEnv['DEEPTHINK_WORKSPACE_MEMORY']) {
        hostEnv['DT_WORKSPACE_MEMORY'] = hostEnv['DEEPTHINK_WORKSPACE_MEMORY'];
      }
      hostEnv['DT_DISABLE_MEMORY_LAYER'] = hostEnv['DEEPTHINK_DISABLE_MEMORY_LAYER'] ?? 'false';
    }

    // 5b. Host capability preflight — detect external tools & inject env vars
    const capResult = await checkHostCapabilities();
    logCapabilityPreflight(group.name, capResult);
    for (const [key, value] of Object.entries(capResult.envVars)) {
      if (!hostEnv[key]) hostEnv[key] = value;
    }

    // Prepend the resolved claude binary directory to PATH so SDK subprocesses
    // (which look up `claude` via PATH) hit the correct binary first. agent-capabilities
    // prefers the SDK-bundled binary over `which` to avoid third-party wrappers
    // (e.g. cmux) that hijack `claude` in PATH and break subprocess invocation.
    if (capResult.resolvedPaths['claude']) {
      const resolvedClaudeDir = path.dirname(capResult.resolvedPaths['claude']);
      const currentPath = hostEnv['PATH'] || process.env.PATH || '';
      // path.delimiter（Windows ';'，POSIX ':'）——硬编码 ':' 会在 Windows 上
      // 把盘符（E:）也当分隔符，PATH 被拼烂导致 claude 目录无法生效。
      hostEnv['PATH'] = `${resolvedClaudeDir}${path.delimiter}${currentPath}`;
      logger.info(
        { group: group.name, resolvedClaudeDir, resolvedPath: capResult.resolvedPaths['claude'] },
        'Host preflight: claude binary resolved',
      );
    }

    // 6. 编译检查
    const projectRoot = process.cwd();
    const agentRunnerRoot = process.env.DEEPTHINK_AGENT_RUNNER_DIR
      ? path.resolve(process.env.DEEPTHINK_AGENT_RUNNER_DIR)
      : path.join(projectRoot, 'container', 'agent-runner');
    const agentRunnerNodeModules = path.join(agentRunnerRoot, 'node_modules');
    const agentRunnerDist = path.join(agentRunnerRoot, 'dist', 'index.js');
    const requiredDeps = ['@anthropic-ai/claude-agent-sdk'];
    const missingDeps = requiredDeps.filter((dep) => {
      const depJson = path.join(
        agentRunnerNodeModules,
        ...dep.split('/'),
        'package.json',
      );
      return !fs.existsSync(depJson);
    });
    if (missingDeps.length > 0) {
      const missing = missingDeps.join(', ');
      logger.error(
        { group: group.name, missingDeps },
        'Host agent preflight failed: dependencies missing',
      );
      return hostModeSetupError(
        `缺少 agent-runner 依赖（${missing}）。请先执行：${setupInstallHint}`,
      );
    }
    if (!fs.existsSync(agentRunnerDist)) {
      logger.error(
        { group: group.name, agentRunnerDist },
        'Host agent preflight failed: dist not found',
      );
      return hostModeSetupError(
        `agent-runner 未编译。请先执行：${setupBuildHint}`,
      );
    }

    // Auto-rebuild if dist is stale (src newer than dist)
    try {
      const distMtime = fs.statSync(agentRunnerDist).mtimeMs;
      const srcDir = path.join(agentRunnerRoot, 'src');
      const srcFiles = fs.readdirSync(srcDir);
      const newestSrc = Math.max(
        ...srcFiles.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs),
      );
      if (newestSrc > distMtime) {
        logger.info(
          { group: group.name },
          'agent-runner dist 已过期，自动重新编译...',
        );
        try {
          const { execSync } = await import('child_process');
          execSync('npm run build', {
            cwd: agentRunnerRoot,
            stdio: 'pipe',
            timeout: 30_000,
          });
          logger.info({ group: group.name }, 'agent-runner 自动编译完成');
        } catch (buildErr) {
          logger.warn(
            { group: group.name, err: buildErr },
            `agent-runner 自动编译失败，使用旧版 dist。手动执行：${setupBuildHint}`,
          );
        }
      }
    } catch {
      // Best effort, don't block execution
    }

    logger.info(
      {
        group: group.name,
        workingDir: groupDir,
        isMain: input.isMain,
      },
      'Spawning host agent',
    );

    const logsDir = logsBaseDir;

    const hostResult = await new Promise<ContainerOutput>((resolve) => {
      let settled = false;
      const resolveOnce = (output: ContainerOutput): void => {
        if (settled) return;
        settled = true;
        resolve(output);
      };

      // 7. 启动进程
      // Resolve absolute node path: bare 'node' fails with ENOENT under
      // PM2 / launchd / GUI launchers where PATH lacks nvm/fnm dirs.
      const hostNodeBinary = resolveHostNodeBinary(hostEnv);
      const proc = spawn(hostNodeBinary, [agentRunnerDist], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: hostEnv,
        cwd: groupDir,
        detached: true,
      });

      const processId = `host-${group.folder}-${Date.now()}`;
      onProcess(proc, processId, hostSelectedProfileId);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // 8. stdin 输入
      proc.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Host agent stdin write failed',
        );
        killProcessTree(proc);
      });
      // Derive a new input with host-runtime plugins injected; never mutate
      // the caller's `input` object (queue/log/retry paths reuse the same ref).
      // prepareHostPlugins mirrors the docker path's pre-spawn materialize so
      // a freshly-enabled v2 user (no runtime/ on disk yet) doesn't see 0
      // plugins.
      const ownerLanguage = group.created_by
        ? getUserById(group.created_by)?.language ?? DEFAULT_LANGUAGE
        : DEFAULT_LANGUAGE;
      // 引擎 session 分流：atomcode/codex/opencode 各走专用列；agent-runner
      // 把对应 session_id 写回该列。Claude 走默认 session_id 列。
      const engineSessionId =
        groupEngine === 'atomcode'
          ? (getAtomcodeSessionId(group.folder, input.agentId || '') ??
            input.sessionId)
          : groupEngine === 'codex'
            ? (getCodexThreadId(group.folder, input.agentId || '') ??
              input.sessionId)
            : groupEngine === 'opencode'
              ? (getOpencodeSessionId(group.folder, input.agentId || '') ??
                input.sessionId)
              : groupEngine === 'pi'
                ? (getPiSessionId(group.folder, input.agentId || '') ??
                  input.sessionId)
                : input.sessionId;
      const hostAgentDef = loadGroupAgentDefinition(
        group.agentDefId,
        group.created_by,
      );
      writeAgentProjectClaudeMd(group, hostAgentDef, input.autonomous);
      const hostInput: ContainerInput = {
        ...input,
        sessionId: engineSessionId,
        engine: groupEngine,
        userLanguage: input.userLanguage ?? ownerLanguage,
        plugins: prepareHostPlugins(group.created_by),
        agentDefinition: hostAgentDef,
        contextAudit: hostClaudeContextPlan.audit,
      };
      proc.stdin.write(JSON.stringify(hostInput));
      proc.stdin.end();

      // 9. 超时管理
      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, processId },
          'Host agent timeout, killing',
        );
        killProcessTree(proc, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            killProcessTree(proc, 'SIGKILL');
          }
        }, 5000);
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };
      const handleOutput = onOutput
        ? async (output: ContainerOutput): Promise<void> => {
            await onOutput(output);
            if (output.providerFailure && hostSelectedProfileId) {
              if (!hostProviderFailureReported) {
                hostProviderFailureReported = true;
                providerPool.reportFailure(hostSelectedProfileId, true);
                logger.warn(
                  {
                    group: group.name,
                    processId,
                    providerId: hostSelectedProfileId,
                    result: output.result,
                  },
                  'Provider failure detected from streamed output, stopping host agent',
                );
              }
              killProcessTree(proc, 'SIGTERM');
            }
          }
        : undefined;

      // 10. stdout/stderr 解析
      attachStdoutHandler(proc.stdout, stdoutState, {
        groupName: group.name,
        label: 'Host agent',
        onOutput: handleOutput,
        resetTimeout,
      });
      attachStderrHandler(proc.stderr, stderrState, group.name, {
        host: group.folder,
      });

      // 11. close 事件处理
      proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Host Agent',
          filePrefix: 'host',
          identifier: processId,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput,
          resolvePromise: resolveOnce,
          startTime,
          timeoutMs,
          extraSummaryLines: [`Working Directory: ${groupDir}`],
          enrichError: (stderrContent, exitLabel) => {
            const missingPackageMatch = stderrContent.match(
              /Cannot find package '([^']+)' imported from/u,
            );
            const userFacingError = missingPackageMatch
              ? `宿主机模式启动失败：缺少依赖 ${missingPackageMatch[1]}。请先执行：${setupInstallHint}`
              : null;
            return {
              result: userFacingError,
              error: `Host agent exited with ${exitLabel}: ${stderrContent.slice(-200)}`,
            };
          },
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, processId, error: err },
          'Host agent spawn error',
        );
        resolveOnce({
          status: 'error',
          result: null,
          error: `Host agent spawn error: ${err.message}`,
        });
      });
    });

    // ─── Provider Pool health reporting (host mode) ───
    if (hostSelectedProfileId) {
      if (hostResult.providerFailure) {
        if (!hostProviderFailureReported) {
          providerPool.reportFailure(hostSelectedProfileId, true);
        }
      } else if (
        hostResult.status === 'success' ||
        hostResult.status === 'closed'
      ) {
        providerPool.reportSuccess(hostSelectedProfileId);
      } else if (
        hostResult.status === 'error' &&
        isApiError(hostResult.error || '')
      ) {
        providerPool.reportFailure(hostSelectedProfileId);
      }
    }

    return hostResult;
  } finally {
    // Guarantee session release even if spawn/setup throws
    if (hostSelectedProfileId) {
      providerPool.releaseSession(hostSelectedProfileId);
    }
  }
}
