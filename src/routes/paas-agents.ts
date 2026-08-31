/**
 * Agent PaaS: User-level Agent Definitions CRUD + Mounts.
 *
 * 用户级 Agent 定义实体（DB-backed），与现有 /api/agent-definitions（管理
 * ~/.claude/agents/*.md 全局文件）不同。挂载在 /api/paas/agents。
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { isSchemaValid } from '../graph-engineering/json-schema-validator.js';
import {
  listAgentDefinitions,
  getAgentDefinition,
  createAgentDefinition,
  updateAgentDefinition,
  deleteAgentDefinition,
  listAgentMounts,
  addAgentMount,
  deleteAgentMount,
  setAgentWorkers,
  listAgentWorkers,
  countAgentDefinitions,
  getUserAgentQuota,
  listKnowledgeBases,
  saveAgentVersionSnapshot,
  listAgentVersions,
  getAgentVersionSnapshot,
  restoreAgentVersion,
  createAgentShare,
  listAgentShares,
  deleteAgentShare,
  addAgentCollaborator,
  removeAgentCollaborator,
  listAgentCollaborators,
  getAgentCollaboratorRole,
  getRegisteredGroup,
  setRegisteredGroup,
  ensureChatExists,
  updateChatName,
  addGroupMember,
  updateAgentDefValidation,
  type AgentDefinitionRow,
  type AgentMountRow,
  type KnowledgeBaseRow,
  type AgentShareRow,
} from '../db.js';
import {
  AgentDefinitionCreateSchema,
  AgentDefinitionPatchSchema,
  AgentMountCreateSchema,
} from '../schemas.js';
import type { AgentDefinition, AgentMount, ResourceType, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { getWebDeps } from '../web-context.js';
import { GROUPS_DIR } from '../config.js';
import { generateAgentContent, optimizeAgentContent } from '../agent-ai.js';
import fs from 'node:fs';
import path from 'node:path';
import { discoverSkills, type Skill } from './skills.js';

export const paasAgentsRoute = new Hono<{ Variables: Variables }>();

paasAgentsRoute.use('*', authMiddleware);

function serializeAgentDef(row: AgentDefinitionRow): AgentDefinition {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    model: row.model,
    engine: row.engine === 'atomcode' ? 'atomcode' : 'claude',
    avatarEmoji: row.avatar_emoji,
    avatarColor: row.avatar_color,
    maxTurns: row.max_turns,
    temperature: row.temperature,
    enabled: row.enabled === 1,
    kind: row.kind === 'orchestrator' ? 'orchestrator' : 'assistant',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeMount(row: AgentMountRow): AgentMount {
  return {
    id: row.id,
    agentDefId: row.agent_def_id,
    resourceType: row.resource_type as ResourceType,
    resourceId: row.resource_id,
    createdAt: row.created_at,
  };
}

paasAgentsRoute.get('/', (c) => {
  const user = c.get('user');
  const rows = listAgentDefinitions(user.id);
  const result = rows.map((row) => {
    const def = serializeAgentDef(row);
    const mounts = listAgentMounts(row.id).map(serializeMount);
    return { ...def, mounts };
  });
  return c.json({
    agents: result,
    quota: getUserAgentQuota(user.id),
    used: rows.length,
  });
});

paasAgentsRoute.get('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getAgentDefinition(id, user.id);
  if (!row) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const def = serializeAgentDef(row);
  const mounts = listAgentMounts(row.id).map(serializeMount);
  return c.json({ ...def, mounts });
});

// POST /generate — AI-generate a structured Agent config from name + description.
// Returns fields for preview/editing; does NOT persist to DB (caller POSTs to /
// to actually create once the user confirms/edits).
paasAgentsRoute.post('/generate', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({})) as {
    description?: unknown;
    name?: unknown;
  };
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length < 10) {
    return c.json({ error: 'description must be at least 10 characters' }, 400);
  }
  const suggestedName =
    typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;

  const result = await generateAgentContent(description, suggestedName);
  if ('error' in result) {
    return c.json({ error: result.error }, 502);
  }
  return c.json({ fields: result.fields });
});

paasAgentsRoute.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const validation = AgentDefinitionCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const used = countAgentDefinitions(user.id);
  const quota = getUserAgentQuota(user.id);
  if (used >= quota) {
    return c.json(
      { error: `Agent quota exceeded (${used}/${quota})` },
      402,
    );
  }
  try {
    const row = createAgentDefinition(user.id, {
      name: validation.data.name,
      description: validation.data.description,
      system_prompt: validation.data.system_prompt,
      model: validation.data.model ?? null,
      engine: validation.data.engine,
      avatar_emoji: validation.data.avatar_emoji ?? null,
      avatar_color: validation.data.avatar_color ?? null,
      max_turns: validation.data.max_turns ?? null,
      temperature: validation.data.temperature ?? null,
      enabled: validation.data.enabled,
      kind: validation.data.kind,
    });
    return c.json({ agent: serializeAgentDef(row), mounts: [] }, 201);
  } catch (err) {
    logger.error({ err }, 'Failed to create agent definition');
    return c.json({ error: 'Failed to create agent definition' }, 500);
  }
});

paasAgentsRoute.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const validation = AgentDefinitionPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const row = updateAgentDefinition(id, user.id, {
    name: validation.data.name,
    description: validation.data.description,
    system_prompt: validation.data.system_prompt,
    model: validation.data.model,
    engine: validation.data.engine,
    avatar_emoji: validation.data.avatar_emoji,
    avatar_color: validation.data.avatar_color,
    max_turns: validation.data.max_turns,
    temperature: validation.data.temperature,
    enabled: validation.data.enabled,
    kind: validation.data.kind,
  });
  if (!row) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({ agent: serializeAgentDef(row) });
});

// PATCH /api/paas/agents/:id/validation — 配置结果校验策略（v58 开放平台）
paasAgentsRoute.patch('/:id/validation', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  // 复用 getAgentDefinition 做归属校验
  const existing = getAgentDefinition(id, user.id);
  if (!existing) return c.json({ error: 'Agent definition not found' }, 404);
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (body.validation_schema != null && body.validation_schema !== '') {
    if (typeof body.validation_schema !== 'string') {
      return c.json({ error: 'validation_schema must be a JSON Schema string' }, 400);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.validation_schema);
    } catch (err) {
      return c.json({ error: `validation_schema is not valid JSON: ${(err as Error).message}` }, 400);
    }
    if (!isSchemaValid(parsed as Record<string, unknown>)) {
      return c.json({ error: 'validation_schema is not a compilable JSON Schema' }, 400);
    }
  }
  const allowedHookActions = new Set(['passthrough', 'block', 'retry']);
  const allowedSchemaActions = new Set(['fail', 'retry', 'passthrough']);
  if (body.hook_failure_action != null && !allowedHookActions.has(body.hook_failure_action as string)) {
    return c.json({ error: 'hook_failure_action must be one of passthrough|block|retry' }, 400);
  }
  if (body.on_schema_fail != null && !allowedSchemaActions.has(body.on_schema_fail as string)) {
    return c.json({ error: 'on_schema_fail must be one of fail|retry|passthrough' }, 400);
  }
  updateAgentDefValidation(id, {
    validationSchema: (body.validation_schema as string | null | undefined) ?? null,
    validationHookUrl: (body.validation_hook_url as string | null | undefined) ?? null,
    hookSecret: (body.hook_secret as string | null | undefined) ?? null,
    hookFailureAction: (body.hook_failure_action as string | null | undefined) ?? null,
    onSchemaFail: (body.on_schema_fail as string | null | undefined) ?? null,
  });
  const row = getAgentDefinition(id, user.id);
  return c.json({
    validation: row
      ? {
          has_schema: !!row.validation_schema,
          has_hook: !!row.validation_hook_url,
          hook_failure_action: row.hook_failure_action ?? 'passthrough',
          on_schema_fail: row.on_schema_fail ?? 'fail',
        }
      : null,
  });
});

paasAgentsRoute.delete('/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const ok = deleteAgentDefinition(id, user.id);
  if (!ok) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({ success: true });
});

paasAgentsRoute.post('/:id/mounts', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = AgentMountCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid input', issues: validation.error.issues }, 400);
  }
  const row = addAgentMount(
    id,
    validation.data.resource_type,
    validation.data.resource_id,
  );
  return c.json({ mount: serializeMount(row) }, 201);
});

paasAgentsRoute.delete('/:id/mounts/:mountId', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const mountId = c.req.param('mountId');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const ok = deleteAgentMount(mountId, id);
  if (!ok) {
    return c.json({ error: 'Mount not found' }, 404);
  }
  return c.json({ success: true });
});

// ─── Orchestrator–Workers（主 Agent 编排子 Agent）───────────────

// GET /:id/workers — 列出编排者已关联的子 Agent（按 position 排序）。
paasAgentsRoute.get('/:id/workers', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const orchestrator = getAgentDefinition(id, user.id);
  if (!orchestrator) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const workers = listAgentWorkers(id);
  return c.json({ workers: workers.map(serializeAgentDef) });
});

// PUT /:id/workers — 整体替换编排者的 Worker 集合（幂等）。
paasAgentsRoute.put('/:id/workers', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const orchestrator = getAgentDefinition(id, user.id);
  if (!orchestrator) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const workerIds: unknown = body.workerIds;
  if (!Array.isArray(workerIds) || !workerIds.every((w) => typeof w === 'string')) {
    return c.json({ error: 'workerIds must be an array of strings' }, 400);
  }

  // 校验每个 worker：必须是当前用户自己的、非编排者自身、非编排者类型的 Agent。
  const ids = workerIds as string[];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const wid of ids) {
    if (wid === id) {
      invalid.push(wid);
      continue;
    }
    if (seen.has(wid)) continue; // 去重，允许重复传但只保留一个
    seen.add(wid);
    const w = getAgentDefinition(wid, user.id);
    if (!w || w.kind === 'orchestrator') invalid.push(wid);
  }
  if (invalid.length) {
    return c.json({ error: 'Invalid worker ids', invalid }, 400);
  }

  setAgentWorkers(id, [...seen]);
  const workers = listAgentWorkers(id);
  return c.json({ workers: workers.map(serializeAgentDef) });
});

/**
 * 为编排者创建/复用确定性的运行工作区（web:agent-orch-{agentId}），与 test-chat
 * 同构。编排运行（orchestrate）缺省 groupFolder/chatJid 时使用，前端无需感知
 * 工作区概念即可一键运行。
 */
function ensureOrchestratorWorkspace(
  agentId: string,
  agentName: string,
  user: { id: string; role?: string },
): { jid: string; folder: string } {
  const jid = `web:agent-orch-${agentId}`;
  const folder = `agent-orch-${agentId}`;
  const name = `编排: ${agentName}`;
  const now = new Date().toISOString();

  const existing = getRegisteredGroup(jid);
  if (existing) {
    if (existing.agentDefId !== agentId || existing.name !== name) {
      const updated: RegisteredGroup = {
        ...existing,
        name,
        agentDefId: agentId,
      };
      setRegisteredGroup(jid, updated);
      updateChatName(jid, name);
      const deps = getWebDeps();
      if (deps) deps.getRegisteredGroups()[jid] = updated;
    }
    return { jid, folder: existing.folder };
  }

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: user.role === 'admin' ? 'host' : 'container',
    created_by: user.id,
    agentDefId: agentId,
  };
  setRegisteredGroup(jid, group);
  ensureChatExists(jid);
  updateChatName(jid, name);
  addGroupMember(folder, user.id, 'owner', user.id);

  try {
    fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
  } catch (err) {
    logger.error({ folder, err }, 'Failed to create orchestrator workspace dir');
  }

  const deps = getWebDeps();
  if (deps) deps.getRegisteredGroups()[jid] = group;

  return { jid, folder };
}

// POST /:id/orchestrate — 运行编排者：拆解任务 → 分派给已关联 Workers → 启动 graph run。
paasAgentsRoute.post('/:id/orchestrate', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const orchestrator = getAgentDefinition(id, user.id);
  if (!orchestrator) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  if (orchestrator.kind !== 'orchestrator') {
    return c.json({ error: 'This agent is not an orchestrator' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const task = typeof body.task === 'string' ? body.task.trim() : '';
  if (!task) {
    return c.json({ error: 'task is required' }, 400);
  }
  const background =
    typeof body.background === 'string' && body.background.trim()
      ? body.background.trim()
      : undefined;
  const acceptanceCriteria =
    typeof body.acceptanceCriteria === 'string' && body.acceptanceCriteria.trim()
      ? body.acceptanceCriteria.trim()
      : undefined;

  let groupFolder =
    typeof body.groupFolder === 'string' && body.groupFolder.trim()
      ? body.groupFolder.trim()
      : undefined;
  let chatJid =
    typeof body.chatJid === 'string' && body.chatJid.trim()
      ? body.chatJid.trim()
      : undefined;
  if (!groupFolder || !chatJid) {
    const ws = ensureOrchestratorWorkspace(id, orchestrator.name, user);
    if (!groupFolder) groupFolder = ws.folder;
    if (!chatJid) chatJid = ws.jid;
  }

  const webDeps = getWebDeps();
  if (!webDeps?.runOrchestrator) {
    return c.json({ error: 'Orchestrator runner not initialized' }, 503);
  }
  const result = await webDeps.runOrchestrator({
    orchestratorId: id,
    task,
    background,
    acceptanceCriteria,
    ownerUserId: user.id,
    groupFolder,
    chatJid,
  });
  if ('error' in result) {
    return c.json({ error: result.error, detail: result.detail }, 400);
  }
  return c.json({
    ok: true,
    runId: result.runId,
    definitionId: result.definitionId,
    plan: result.plan,
  });
});

// Phase 2: 版本历史
paasAgentsRoute.get('/:id/versions', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const rows = listAgentVersions(id);
  return c.json({
    versions: rows.map((r) => ({
      id: r.id,
      version: r.version,
      created_at: r.created_at,
      created_by: r.created_by,
    })),
  });
});

// Phase 2: 回滚到指定版本
paasAgentsRoute.post('/:id/versions/:vid/restore', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const snapshot = getAgentVersionSnapshot(vid);
  if (!snapshot) {
    return c.json({ error: 'Version not found' }, 404);
  }
  const restored = restoreAgentVersion(id, vid, user.id);
  if (!restored) {
    return c.json({ error: 'Restore failed' }, 500);
  }
  return c.json({
    agent: serializeAgentDef(restored),
    mounts: listAgentMounts(id).map(serializeMount),
  });
});

// 便捷端点: 列出当前用户可挂载的所有资源（供前端挂载面板选择器）
paasAgentsRoute.get('/resources/available', async (c) => {
  const user = c.get('user');
  const mcpServers = await loadUserMcpServersMeta(user.id);
  const kbs = listKnowledgeBases(user.id).map((r: KnowledgeBaseRow) => ({
    id: r.id,
    name: r.name,
    doc_count: r.doc_count,
  }));
  const skills = listMountableSkills(user.id, user.role);
  return c.json({
    mcp_servers: mcpServers,
    knowledge_bases: kbs,
    skills,
  });
});

function listMountableSkills(
  userId: string,
  userRole?: string,
): Array<{ id: string; name: string; description: string; source: string }> {
  try {
    const all = discoverSkills(userId, userRole);
    return all
      .filter((s) => s.enabled)
      .map((s: Skill) => ({
        id: s.id,
        name: s.name || s.id,
        description: s.description || '',
        source: s.source,
      }));
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to list mountable skills');
    return [];
  }
}

async function loadUserMcpServersMeta(
  userId: string,
): Promise<Array<{ id: string; name: string; type: string; enabled: boolean }>> {
  try {
    const { getUserMcpServersDir } = await import('./mcp-servers.js');
    const dir = getUserMcpServersDir(userId);
    const file = path.join(dir, 'servers.json');
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as
      | { servers?: Record<string, { name?: string; type?: string; enabled?: boolean }> }
      | { servers?: Array<{ id?: string; name?: string; type?: string; enabled?: boolean }> };
    const raw = data.servers;
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.map((s) => ({
        id: s.id ?? '',
        name: s.name ?? s.id ?? '',
        type: s.type ?? 'stdio',
        enabled: s.enabled !== false,
      }));
    }
    return Object.entries(raw).map(([id, s]) => ({
      id,
      name: s.name ?? id,
      type: s.type ?? 'stdio',
      enabled: s.enabled !== false,
    }));
  } catch {
    return [];
  }
}

// Phase 3: Agent 分享
paasAgentsRoute.post('/:id/share', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  await c.req.json().catch(() => ({}));
  const share = createAgentShare(id, user.id, null);
  const shareUrl = `/share/${share.share_token}`;
  return c.json({ shareId: share.id, shareToken: share.share_token, shareUrl }, 201);
});

paasAgentsRoute.get('/:id/shares', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const shares = listAgentShares(id);
  return c.json({
    shares: shares.map((s: AgentShareRow) => ({
      id: s.id,
      shareToken: s.share_token,
      shareUrl: `/share/${s.share_token}`,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      installCount: s.install_count,
    })),
  });
});

paasAgentsRoute.delete('/:id/shares/:shareId', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const shareId = c.req.param('shareId');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const ok = deleteAgentShare(shareId);
  if (!ok) {
    return c.json({ error: 'Share not found' }, 404);
  }
  return c.json({ success: true });
});

// Phase 3: Agent 协作者
paasAgentsRoute.get('/:id/collaborators', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    // 也允许 collaborator 查看
    const role = getAgentCollaboratorRole(id, user.id);
    if (!role) {
      return c.json({ error: 'Agent definition not found' }, 404);
    }
  }
  const collabs = listAgentCollaborators(id);
  return c.json({
    collaborators: collabs.map((r) => ({
      userId: r.user_id,
      username: r.username ?? r.user_id.slice(0, 8),
      role: r.role,
      addedBy: r.added_by,
      addedAt: r.added_at,
    })),
  });
});

paasAgentsRoute.post('/:id/collaborators', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Only owner can add collaborators' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const role = body.role === 'editor' || body.role === 'viewer' ? body.role : 'viewer';
  if (!userId) {
    return c.json({ error: 'userId required' }, 400);
  }
  if (userId === user.id) {
    return c.json({ error: 'Owner is implicit, no need to add as collaborator' }, 400);
  }
  const row = addAgentCollaborator(id, userId, role, user.id);
  return c.json({
    collaborator: {
      userId: row.user_id,
      role: row.role,
      addedBy: row.added_by,
      addedAt: row.added_at,
    },
  }, 201);
});

paasAgentsRoute.delete('/:id/collaborators/:userId', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    return c.json({ error: 'Only owner can remove collaborators' }, 403);
  }
  const ok = removeAgentCollaborator(id, targetUserId);
  if (!ok) {
    return c.json({ error: 'Collaborator not found' }, 404);
  }
  return c.json({ success: true });
});

// Phase 3: 版本 diff
paasAgentsRoute.get('/:id/versions/:vid/diff', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const agent = getAgentDefinition(id, user.id);
  if (!agent) {
    const role = getAgentCollaboratorRole(id, user.id);
    if (!role) {
      return c.json({ error: 'Agent definition not found' }, 404);
    }
  }
  const snapshot = getAgentVersionSnapshot(vid);
  if (!snapshot) {
    return c.json({ error: 'Version not found' }, 404);
  }
  const current = getAgentDefinition(id, user.id);
  if (!current) {
    return c.json({ error: 'Current agent state not available' }, 404);
  }
  const currentMounts = listAgentMounts(id).map((m) => `${m.resource_type}:${m.resource_id}`).sort();
  const targetMounts = (snapshot.mounts ?? []).map((m) => `${m.resource_type}:${m.resource_id}`).sort();
  const fields: Array<{ name: string; before: string; after: string; same: boolean }> = [
    { name: 'name', before: snapshot.name, after: current.name, same: snapshot.name === current.name },
    { name: 'description', before: snapshot.description ?? '', after: current.description ?? '', same: snapshot.description === current.description },
    { name: 'model', before: snapshot.model ?? '', after: current.model ?? '', same: snapshot.model === current.model },
    { name: 'engine', before: snapshot.engine, after: current.engine, same: snapshot.engine === current.engine },
    { name: 'max_turns', before: String(snapshot.max_turns ?? ''), after: String(current.max_turns ?? ''), same: snapshot.max_turns === current.max_turns },
    { name: 'temperature', before: String(snapshot.temperature ?? ''), after: String(current.temperature ?? ''), same: snapshot.temperature === current.temperature },
    { name: 'enabled', before: String(snapshot.enabled), after: String(!!current.enabled), same: snapshot.enabled === !!current.enabled },
    {
      name: 'mounts',
      before: targetMounts.join('\n'),
      after: currentMounts.join('\n'),
      same: JSON.stringify(targetMounts) === JSON.stringify(currentMounts),
    },
  ];
  // systemPrompt 按行 diff
  const beforeLines = (snapshot.system_prompt ?? '').split('\n');
  const afterLines = (current.system_prompt ?? '').split('\n');
  const promptDiff: Array<{ op: '+' | '-' | '='; line: string }> = [];
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < maxLen; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === undefined) {
      promptDiff.push({ op: '+', line: a ?? '' });
    } else if (a === undefined) {
      promptDiff.push({ op: '-', line: b });
    } else if (b === a) {
      promptDiff.push({ op: '=', line: a });
    } else {
      promptDiff.push({ op: '-', line: b });
      promptDiff.push({ op: '+', line: a });
    }
  }
  return c.json({
    versionId: vid,
    fields,
    promptDiff,
    promptSame: snapshot.system_prompt === current.system_prompt,
  });
});

// POST /:id/optimize — AI-optimize the agent's description + system_prompt.
// Returns a preview; does NOT write.
paasAgentsRoute.post('/:id/optimize', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getAgentDefinition(id, user.id);
  if (!row) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({})) as { feedback?: unknown };
  const feedback = typeof body.feedback === 'string' && body.feedback.trim()
    ? body.feedback.trim()
    : undefined;

  const result = await optimizeAgentContent(
    { name: row.name, description: row.description, system_prompt: row.system_prompt },
    feedback,
  );
  if ('error' in result) {
    return c.json({ error: result.error }, 502);
  }
  return c.json({
    optimized_description: result.fields.description,
    optimized_system_prompt: result.fields.system_prompt,
    original_description: row.description,
    original_system_prompt: row.system_prompt,
  });
});

// POST /:id/optimize/apply — apply a previously-previewed optimization.
// Writes back the provided description/system_prompt (only soft fields).
paasAgentsRoute.post('/:id/optimize/apply', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = getAgentDefinition(id, user.id);
  if (!row) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const body = await c.req.json().catch(() => ({})) as {
    description?: unknown;
    system_prompt?: unknown;
  };
  const patch: { description?: string; system_prompt?: string } = {};
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.system_prompt === 'string') patch.system_prompt = body.system_prompt;
  if (!Object.keys(patch).length) {
    return c.json({ error: 'No fields to apply' }, 400);
  }
  const updated = updateAgentDefinition(id, user.id, patch);
  if (!updated) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({ agent: serializeAgentDef(updated) });
});

// POST /api/paas/agents/:id/test-chat
// 为该 Agent 创建/复用确定性测试 group（jid=web:agent-test-{agentId}），
// 绑定 agent_def_id，返回 { jid, folder, name }，前端跳转 /chat/{folder} 即可对话。
paasAgentsRoute.post('/:id/test-chat', (c) => {
  const user = c.get('user');
  const agentId = c.req.param('id');
  const def = getAgentDefinition(agentId, user.id);
  if (!def) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  if (!def.enabled) {
    return c.json({ error: 'Agent is disabled, enable it first' }, 400);
  }

  const jid = `web:agent-test-${agentId}`;
  const folder = `agent-test-${agentId}`;
  const name = `测试: ${def.name}`;
  const now = new Date().toISOString();

  const existing = getRegisteredGroup(jid);
  if (existing) {
    if (existing.agentDefId !== agentId || existing.name !== name) {
      const updated: RegisteredGroup = {
        ...existing,
        name,
        agentDefId: agentId,
      };
      setRegisteredGroup(jid, updated);
      updateChatName(jid, name);
      const deps = getWebDeps();
      if (deps) deps.getRegisteredGroups()[jid] = updated;
    }
    return c.json({ jid, folder: existing.folder, name });
  }

  const isAdmin = user.role === 'admin';
  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: isAdmin ? 'host' : 'container',
    created_by: user.id,
    agentDefId: agentId,
  };
  setRegisteredGroup(jid, group);
  ensureChatExists(jid);
  updateChatName(jid, name);
  addGroupMember(folder, user.id, 'owner', user.id);

  try {
    fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
  } catch (err) {
    logger.error({ folder, err }, 'Failed to create test-chat workspace dir');
  }

  const deps = getWebDeps();
  if (deps) deps.getRegisteredGroups()[jid] = group;

  logger.info({ agentId, jid, folder, userId: user.id }, 'Agent test-chat group created');

  return c.json({ jid, folder, name });
});

export default paasAgentsRoute;
