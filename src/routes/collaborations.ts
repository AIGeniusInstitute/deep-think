// Multi-User Collaboration routes.
//
// POST /api/collaborations: async — immediately create a `collaborations` row
// (status='running') and return collabId; buildCollaboration (applyScenario +
// buildTeam mode-aware decompose + members + graph + register + start +
// detached execute + artifact persistence) runs detached in the background;
// results/errors written back to the row. The frontend polls
// GET /api/collaborations/:id for the terminal state.
//
// Access: owner OR a group member of the collaboration's group_folder OR admin.
// Group-member access is the multi-user collaboration primitive: any human
// added to the shared workspace (POST /api/groups/:jid/members) can read the
// collaboration's shared artifacts/memory even if they didn't create it.
//
// buildCollaboration delegates 100% to buildTeam (mode-aware). This route is a
// thin async + persistence + ACL layer mirroring routes/team.ts.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getWebDeps } from '../web-context.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  createCollaboration,
  getCollaboration,
  completeCollaboration,
  failCollaboration,
  listCollaborations,
  getGroupMemberRole,
} from '../db.js';
import { getFileRoot } from '../file-manager.js';
import { logger } from '../logger.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CollaborationRow } from '../db.js';
import type { AuthUser } from '../types.js';

export const collaborationRoutes = new Hono<{ Variables: Variables }>();

collaborationRoutes.use('*', authMiddleware);

const CollaborationBodySchema = z.object({
  goalText: z.string().min(1),
  background: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  mode: z.enum(['orchestrator-worker', 'peer', 'critic-adversarial']),
  scenario: z.string().optional(),
  groupFolder: z.string().min(1),
  chatJid: z.string().min(1),
  userLanguage: z.string().optional(),
  maxTeamSize: z.number().int().min(1).max(12).optional(),
  toolset: z.array(z.string()).optional(),
  executionMode: z.enum(['auto', 'semi-auto']).optional(),
});

/** Can the given user access this collaboration? owner / group member / admin. */
function canAccessCollaboration(user: AuthUser, row: CollaborationRow): boolean {
  if (user.role === 'admin') return true;
  if (row.owner_user_id === user.id) return true;
  // Shared workspace: a member of the collaboration's group_folder can access.
  return getGroupMemberRole(row.group_folder, user.id) !== null;
}

/**
 * GET /api/collaborations — list the current user's collaborations (history,
 * newest first). Powers the collaboration page's history list.
 */
collaborationRoutes.get('/runs', (c) => {
  const authUser = c.get('user') as AuthUser;
  const rows = listCollaborations(authUser.id, 20);
  return c.json({
    runs: rows.map((r) => {
      let teamName: string | null = null;
      if (r.plan_json) {
        try {
          teamName = (JSON.parse(r.plan_json) as { teamName?: string }).teamName ?? null;
        } catch {
          teamName = null;
        }
      }
      return {
        id: r.id,
        teamName,
        goalText: r.goal_text,
        mode: r.mode,
        scenario: r.scenario,
        status: r.status,
        runId: r.run_id,
        createdAt: r.created_at,
      };
    }),
  });
});

/** POST /api/collaborations — immediately return collabId, background build. */
collaborationRoutes.post('/runs', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => null);
  const parsed = CollaborationBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body', detail: parsed.error.issues.map((i) => i.message).join('; ') },
      400,
    );
  }
  const webDeps = getWebDeps();
  if (!webDeps?.buildCollaboration) {
    return c.json({ error: 'Collaboration builder not initialized' }, 503);
  }

  const collabId = `collab-${randomUUID()}`;
  createCollaboration({
    id: collabId,
    owner_user_id: authUser.id,
    group_folder: parsed.data.groupFolder,
    chat_jid: parsed.data.chatJid,
    goal_text: parsed.data.goalText,
    mode: parsed.data.mode,
    scenario: parsed.data.scenario ?? null,
    background: parsed.data.background ?? null,
    acceptance_criteria: parsed.data.acceptanceCriteria ?? null,
  });

  const input = {
    goalText: parsed.data.goalText,
    background: parsed.data.background,
    acceptanceCriteria: parsed.data.acceptanceCriteria,
    mode: parsed.data.mode,
    scenario: parsed.data.scenario,
    ownerUserId: authUser.id,
    groupFolder: parsed.data.groupFolder,
    chatJid: parsed.data.chatJid,
    collaborationId: collabId,
    userLanguage: parsed.data.userLanguage ?? 'zh-CN',
    maxTeamSize: parsed.data.maxTeamSize,
    toolset: parsed.data.toolset,
    executionMode: parsed.data.executionMode,
  };

  // Fire-and-forget: setImmediate detaches so the HTTP response returns <1s.
  // buildCollaboration delegates to buildTeam (mode-aware decompose ~21s sync
  // prefix) which is absorbed by the frontend's polling retry, same as team.
  const buildCollaboration = webDeps.buildCollaboration;
  setImmediate(() => {
    buildCollaboration(input)
      .then((result) => {
        if ('error' in result) {
          failCollaboration(
            collabId,
            `${result.error}${result.detail ? `：${result.detail}` : ''}`,
          );
          logger.warn({ collabId, err: result.error, detail: result.detail }, 'collaboration build failed');
          return;
        }
        completeCollaboration(collabId, {
          plan_json: JSON.stringify(result.plan),
          run_id: result.runId,
          definition_id: result.definitionId,
          participants_json: JSON.stringify(
            result.plan.members.map((m) => ({ name: m.name, role: m.role })),
          ),
        });
        logger.info({ collabId, runId: result.runId, mode: result.mode }, 'collaboration build completed');
      })
      .catch((err: unknown) => {
        failCollaboration(collabId, (err as Error).message?.slice(0, 500) ?? 'unknown error');
        logger.error({ collabId, err }, 'collaboration build threw');
      });
  });

  return c.json({ ok: true, collabId, status: 'running' });
});

/** GET /api/collaborations/:id — poll build status. */
collaborationRoutes.get('/runs/:id', (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const row = getCollaboration(id);
  if (!row || !canAccessCollaboration(authUser, row)) {
    return c.json({ error: 'Collaboration not found' }, 404);
  }
  if (row.status === 'completed') {
    return c.json({
      status: 'completed',
      runId: row.run_id,
      mode: row.mode,
      scenario: row.scenario,
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
      participants: row.participants_json ? JSON.parse(row.participants_json) : null,
    });
  }
  if (row.status === 'failed') {
    return c.json({ status: 'failed', error: row.error ?? 'build failed' });
  }
  return c.json({ status: 'running' });
});

/**
 * GET /api/collaborations/:id/deliverables — list the manifest of shared
 * artifacts. Returns the manifest.json entries (nodeId/member/role/title/file).
 */
collaborationRoutes.get('/runs/:id/deliverables', (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const row = getCollaboration(id);
  if (!row || !canAccessCollaboration(authUser, row)) {
    return c.json({ error: 'Collaboration not found' }, 404);
  }
  const dir = join(getFileRoot(row.group_folder), 'collaborations', id);
  const manifestPath = join(dir, 'manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return c.json({ collabId: id, runId: row.run_id, deliverables: manifest });
  } catch {
    return c.json({ collabId: id, runId: row.run_id, deliverables: [], persisted: false });
  }
});

/** GET /api/collaborations/:id/deliverables/:nodeId — read one deliverable. */
collaborationRoutes.get('/runs/:id/deliverables/:nodeId', (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const nodeId = c.req.param('nodeId');
  const row = getCollaboration(id);
  if (!row || !canAccessCollaboration(authUser, row)) {
    return c.json({ error: 'Collaboration not found' }, 404);
  }
  const file = join(
    getFileRoot(row.group_folder),
    'collaborations',
    id,
    'deliverables',
    `${nodeId}.md`,
  );
  try {
    const content = readFileSync(file, 'utf8');
    return c.text(content, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  } catch {
    return c.json({ error: 'Deliverable not found', nodeId }, 404);
  }
});

/**
 * GET /api/collaborations/:id/memory — read the shared collaboration memory
 * file. Any group member can read (canAccessCollaboration).
 */
collaborationRoutes.get('/runs/:id/memory', (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const row = getCollaboration(id);
  if (!row || !canAccessCollaboration(authUser, row)) {
    return c.json({ error: 'Collaboration not found' }, 404);
  }
  const file = join(getFileRoot(row.group_folder), 'collaborations', id, 'shared-memory.md');
  try {
    const content = readFileSync(file, 'utf8');
    return c.json({ collabId: id, memory: content });
  } catch {
    return c.json({ collabId: id, memory: '' });
  }
});

/**
 * POST /api/collaborations/:id/memory — append to the shared collaboration
 * memory. Any group member can write (the multi-user shared-memory primitive:
 * bypasses the per-folder isUserOwnedFolder single-owner lock by living under
 * the collaboration dir + authorizing via canAccessCollaboration).
 */
collaborationRoutes.post('/runs/:id/memory', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');
  const row = getCollaboration(id);
  if (!row || !canAccessCollaboration(authUser, row)) {
    return c.json({ error: 'Collaboration not found' }, 404);
  }
  const body = await c.req.json().catch(() => null) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) return c.json({ error: 'text is required' }, 400);
  const dir = join(getFileRoot(row.group_folder), 'collaborations', id);
  const file = join(dir, 'shared-memory.md');
  try {
    const { mkdirSync, appendFileSync, existsSync } = await import('node:fs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString();
    const author = authUser.id;
    appendFileSync(file, `\n## [${stamp}] ${author}\n\n${text}\n`);
    return c.json({ ok: true, collabId: id });
  } catch (err) {
    logger.error({ err, id }, 'failed to append collaboration memory');
    return c.json({ error: 'write failed' }, 500);
  }
});

// Suppress unused-import lint for readdirSync (reserved for a future list-all
// artifacts endpoint); keeps the import stable if added later.
void readdirSync;
