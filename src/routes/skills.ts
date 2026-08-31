// Skills management routes

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { DATA_DIR } from '../config.js';
import { getEffectiveExternalDir } from '../runtime-config.js';
import {
  assertResolvesToPublicAddress,
  validateSafeHttpsUrl,
} from '../url-safety.js';
import {
  parseFrontmatter,
  validateSkillId,
  validateSkillPath,
  listFiles,
  scanSkillDirectory,
} from '../skill-utils.js';
import {
  getUserSkillsDir as getUserSkillsDirFromUtils,
  slugifySkillName,
  resolveSkillIdConflict,
  validateSkillContent,
  validateZipEntries,
  writeSkillContent,
  backupSkillContent,
  getSkillContentPath,
} from '../skill-content-utils.js';
import {
  generateSkillContent,
  optimizeSkillContent,
  debugSkill,
} from '../skill-ai.js';
import {
  createSkillVersion,
  listSkillVersions,
  getSkillVersion,
} from '../db.js';
import { logger } from '../logger.js';

// Re-export for backwards compatibility with existing IPC handler imports.
// (getUserSkillsDir previously lived in this file; now sourced from skill-content-utils.)
function getUserSkillsDir(userId: string): string {
  return getUserSkillsDirFromUtils(userId);
}

const execFileAsync = promisify(execFile);
let skillInstallLock: Promise<void> = Promise.resolve();

const skillsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'project' | 'external';
  enabled: boolean;
  packageName?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface SkillDetail extends Skill {
  content: string;
}

interface SkillsManifest {
  skills: Record<
    string,
    {
      packageName: string;
      installedAt: string;
      source: string;
    }
  >;
}

interface SearchResult {
  package: string;
  url: string;
  description?: string;
  installs?: number;
  skillId?: string;
  source?: string;
}

// --- Utility Functions ---

// getUserSkillsDir is now imported from skill-content-utils (see top of file).

function getProjectSkillsDir(): string {
  return path.resolve(process.cwd(), 'container', 'skills');
}

function getSkillsManifestPath(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId, '.skills-manifest.json');
}

function readSkillsManifest(userId: string): SkillsManifest {
  try {
    const data = fs.readFileSync(getSkillsManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { skills: {} };
  }
}

function writeSkillsManifest(userId: string, manifest: SkillsManifest): void {
  const manifestPath = getSkillsManifestPath(userId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Update the skills manifest after installing skills.
 * Records packageName, installedAt, and source for each installed skill.
 */
function updateSkillsManifest(
  userId: string,
  packageName: string,
  installedSkillIds: string[],
): void {
  const manifest = readSkillsManifest(userId);
  const now = new Date().toISOString();
  for (const id of installedSkillIds) {
    manifest.skills[id] = {
      packageName,
      installedAt: now,
      source: 'skills.sh',
    };
  }
  writeSkillsManifest(userId, manifest);
}

/**
 * Remove a skill from the manifest when it is deleted.
 */
function removeFromSkillsManifest(userId: string, skillId: string): void {
  const manifest = readSkillsManifest(userId);
  if (skillId in manifest.skills) {
    delete manifest.skills[skillId];
    writeSkillsManifest(userId, manifest);
  }
}

// validateSkillId, validateSkillPath, parseFrontmatter, listFiles, scanSkillDirectory
// are imported from '../skill-utils.js'

function scanDirectory(rootDir: string, source: 'user' | 'project'): Skill[] {
  return scanSkillDirectory(rootDir, source) as Skill[];
}

export function discoverSkills(userId: string, userRole?: string): Skill[] {
  const userSkills = scanDirectory(getUserSkillsDir(userId), 'user');
  const projectSkills = scanDirectory(getProjectSkillsDir(), 'project');

  // 宿主机 ~/.claude/skills（仅 admin 可见）
  const externalSkills: Skill[] = [];
  if (userRole === 'admin') {
    const extSkillsDir = path.join(getEffectiveExternalDir(), 'skills');
    if (fs.existsSync(extSkillsDir)) {
      const scanned = scanDirectory(extSkillsDir, 'project');
      for (const s of scanned) {
        (s as any).source = 'external';
      }
      externalSkills.push(...scanned);
    }
  }

  // 读取 skills manifest 补充安装元数据
  const skillsManifest = readSkillsManifest(userId);

  for (const skill of userSkills) {
    const meta = skillsManifest.skills[skill.id];
    if (meta) {
      skill.packageName = meta.packageName;
      skill.installedAt = meta.installedAt;
    }
  }

  // 按优先级去重（user > project > external），同 ID 高优先级覆盖低优先级
  const seen = new Set<string>();
  const result: Skill[] = [];
  for (const skill of [...userSkills, ...projectSkills, ...externalSkills]) {
    if (!seen.has(skill.id)) {
      seen.add(skill.id);
      result.push(skill);
    }
  }
  return result;
}

function getSkillDetail(skillId: string, userId: string, userRole?: string): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  const searchDirs: Array<{ rootDir: string; source: 'user' | 'project' | 'external' }> = [
    { rootDir: getUserSkillsDir(userId), source: 'user' },
    { rootDir: getProjectSkillsDir(), source: 'project' },
  ];
  if (userRole === 'admin') {
    const extSkillsDir = path.join(getEffectiveExternalDir(), 'skills');
    if (fs.existsSync(extSkillsDir)) {
      searchDirs.push({ rootDir: extSkillsDir, source: 'external' });
    }
  }

  const skillsManifest = readSkillsManifest(userId);

  for (const { rootDir, source } of searchDirs) {
    const skillDir = path.join(rootDir, skillId);
    if (!fs.existsSync(skillDir)) continue;

    if (!validateSkillPath(rootDir, skillDir)) continue;

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const skillMdDisabledPath = path.join(skillDir, 'SKILL.md.disabled');

    let enabled = false;
    let skillFilePath: string | null = null;

    if (fs.existsSync(skillMdPath)) {
      enabled = true;
      skillFilePath = skillMdPath;
    } else if (fs.existsSync(skillMdDisabledPath)) {
      enabled = false;
      skillFilePath = skillMdDisabledPath;
    } else {
      continue;
    }

    try {
      const content = fs.readFileSync(skillFilePath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const stats = fs.statSync(skillDir);

      const detail: SkillDetail = {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || '',
        source,
        enabled,
        userInvocable:
          frontmatter['user-invocable'] === undefined
            ? true
            : frontmatter['user-invocable'] !== 'false',
        allowedTools: frontmatter['allowed-tools']
          ? frontmatter['allowed-tools'].split(',').map((t) => t.trim())
          : [],
        argumentHint: frontmatter['argument-hint'] || null,
        updatedAt: stats.mtime.toISOString(),
        files: listFiles(skillDir),
        content,
      };

      if (source === 'user') {
        const meta = skillsManifest.skills[skillId];
        if (meta) {
          detail.packageName = meta.packageName;
          detail.installedAt = meta.installedAt;
        }
      }

      return detail;
    } catch {
      // Skip malformed skill
    }
  }

  return null;
}

/**
 * Parse the output of `npx skills find <query>` to extract search results.
 * The output contains ANSI codes and formatted text like:
 *   owner/repo@skill-name
 *   https://skills.sh/owner/repo/skill
 */
function parseSearchOutput(output: string): SearchResult[] {
  // Strip ANSI escape codes
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const results: SearchResult[] = [];

  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match package pattern: owner/repo or owner/repo@skill
    const pkgMatch = line.match(/^([\w\-]+\/[\w\-.]+(?:@[\w\-.]+)?)$/);
    if (pkgMatch) {
      const pkg = pkgMatch[1];
      // Next line might be the URL (possibly prefixed with └ or similar chars)
      let url = '';
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].replace(/^[└├│─\s]+/, '');
        if (nextLine.startsWith('http')) {
          url = nextLine;
          i++;
        }
      }
      results.push({ package: pkg, url });
    }
  }

  return results;
}

/**
 * Find skill entries under a path that were modified after the given timestamp.
 * Handles both real directories and symlinks (skills CLI creates symlinks in
 * ~/.claude/skills/ pointing to ~/.agents/skills/).
 * Returns entry names.
 */
function findModifiedEntries(dir: string, afterMs: number): string[] {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        // Use lstat for symlinks, stat (follows symlink) for mtime of real target
        const lstat = fs.lstatSync(fullPath);

        if (lstat.isSymbolicLink()) {
          // Symlink: check both the symlink creation time and target mtime
          if (lstat.mtimeMs >= afterMs) {
            result.push(entry.name);
            continue;
          }
          // Also check the resolved target's mtime
          const realStat = fs.statSync(fullPath);
          if (realStat.mtimeMs >= afterMs) {
            result.push(entry.name);
          }
        } else if (lstat.isDirectory()) {
          if (lstat.mtimeMs >= afterMs) {
            result.push(entry.name);
          }
        }
      } catch {
        // skip broken symlinks etc.
      }
    }
  } catch {
    // ignore
  }
  return result;
}

/**
 * Copy a skill entry (directory or symlink target) to dest.
 * Resolves symlinks and copies the real content so the copy is self-contained.
 */
function copySkillToUser(src: string, dest: string): void {
  // Resolve symlink to get the real directory
  let realSrc = src;
  try {
    const lstat = fs.lstatSync(src);
    if (lstat.isSymbolicLink()) {
      realSrc = fs.realpathSync(src);
    }
  } catch {
    // use src as-is
  }

  fs.cpSync(realSrc, dest, { recursive: true });
}

// --- Search cache (LRU, 5min TTL, max 100 entries) ---

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map<string, CacheEntry<SearchResult[]>>();

function getCachedSearch(key: string): SearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedSearch(key: string, value: SearchResult[]): void {
  // Evict oldest if at capacity
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL });
}

/**
 * Search skills via skills.sh API.
 * Returns structured results with install counts.
 */
async function searchSkillsApi(query: string): Promise<SearchResult[]> {
  const cached = getCachedSearch(query);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) throw new Error(`skills.sh returned ${resp.status}`);

    const data = (await resp.json()) as {
      skills?: Array<{
        id: string;
        skillId: string;
        name: string;
        installs: number;
        source: string;
      }>;
    };

    const results: SearchResult[] = (data.skills || []).map((s) => ({
      package:
        s.source === s.skillId || !s.skillId
          ? s.source
          : `${s.source}@${s.skillId}`,
      url: `https://skills.sh/s/${s.id}`,
      description: '',
      installs: s.installs,
      skillId: s.skillId,
      source: s.source,
    }));

    setCachedSearch(query, results);
    return results;
  } catch {
    // Fallback to npx skills find
    return searchSkillsFallback(query);
  }
}

/**
 * Fallback search using npx skills find CLI.
 */
async function searchSkillsFallback(query: string): Promise<SearchResult[]> {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['-y', 'skills', 'find', query],
      { timeout: 30_000 },
    );
    return parseSearchOutput(stdout);
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      const results = parseSearchOutput((error as any).stdout || '');
      if (results.length > 0) return results;
    }
    return [];
  }
}

/**
 * Fetch SKILL.md content from GitHub for a given source repo and skill ID.
 * Tries multiple common directory layouts.
 */
async function fetchSkillMdFromGitHub(
  source: string,
  skillId: string,
): Promise<{ content: string; description: string; skillName: string } | null> {
  // Try common paths where SKILL.md might live
  const pathCandidates = [
    `skills/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
    `.claude/skills/${skillId}/SKILL.md`,
    `SKILL.md`,
  ];

  for (const branch of ['main', 'master']) {
    for (const filePath of pathCandidates) {
      try {
        const url = `https://raw.githubusercontent.com/${source}/${branch}/${filePath}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!resp.ok) continue;

        const content = await resp.text();
        // Verify it looks like a SKILL.md (has frontmatter)
        if (!content.startsWith('---')) continue;

        const frontmatter = parseFrontmatter(content);
        return {
          content,
          description: frontmatter.description || '',
          skillName: frontmatter.name || skillId,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function withSkillInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = skillInstallLock.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  skillInstallLock = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// --- Routes ---

skillsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const skills = discoverSkills(authUser.id, authUser.role);
  return c.json({ skills });
});

skillsRoutes.get('/search', authMiddleware, async (c) => {
  const query = c.req.query('q')?.trim();
  if (!query) {
    return c.json({ results: [] });
  }

  const results = await searchSkillsApi(query);
  return c.json({ results });
});

skillsRoutes.get('/search/detail', authMiddleware, async (c) => {
  const source = c.req.query('source')?.trim();
  const skillId = c.req.query('skillId')?.trim();

  // Support legacy url-based lookup for backwards compat
  const url = c.req.query('url')?.trim();

  if (source && skillId) {
    // New path: fetch SKILL.md from GitHub using source/skillId
    const result = await fetchSkillMdFromGitHub(source, skillId);
    if (!result) {
      return c.json({ detail: null });
    }

    return c.json({
      detail: {
        description: result.description,
        skillName: result.skillName,
        readme: result.content,
        installs: '',
        age: '',
        features: [],
      },
    });
  }

  // Legacy: extract source/skillId from skills.sh URL
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'skills.sh') {
        // URL pattern: https://skills.sh/s/{owner}/{repo}/{skillId}
        const segments = parsed.pathname
          .replace(/^\/s\//, '')
          .split('/')
          .filter(Boolean);
        if (segments.length >= 3) {
          const srcFromUrl = `${segments[0]}/${segments[1]}`;
          const skillIdFromUrl = segments[2];
          const result = await fetchSkillMdFromGitHub(
            srcFromUrl,
            skillIdFromUrl,
          );
          if (result) {
            return c.json({
              detail: {
                description: result.description,
                skillName: result.skillName,
                readme: result.content,
                installs: '',
                age: '',
                features: [],
              },
            });
          }
        }
      }
    } catch {
      // fall through
    }
  }

  return c.json({ detail: null });
});


skillsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const skill = getSkillDetail(id, authUser.id, authUser.role);

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

// Toggle enable/disable for user-level skills via SKILL.md ↔ SKILL.md.disabled rename.
// Project-level skills are read-only.
skillsRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  // 防 invalid JSON 把 hono 默认错误处理器返回 500 + 暴露栈。Catch 后单独
  // 校验 enabled 是 boolean。
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean' }, 400);
  }
  const enabled = body.enabled;

  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);

  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);

  if (!fs.existsSync(skillDir)) {
    return c.json(
      { error: 'Skill not found or is not a user-level skill' },
      404,
    );
  }
  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  const srcPath = path.join(
    skillDir,
    enabled ? 'SKILL.md.disabled' : 'SKILL.md',
  );
  const dstPath = path.join(
    skillDir,
    enabled ? 'SKILL.md' : 'SKILL.md.disabled',
  );

  if (!fs.existsSync(srcPath)) {
    return c.json(
      { error: 'Skill not found or already in desired state' },
      404,
    );
  }

  fs.renameSync(srcPath, dstPath);
  return c.json({ success: true });
});

/**
 * Delete a user-level skill by ID.
 * Reusable by both the HTTP route and IPC handler.
 */
function deleteSkillForUser(
  userId: string,
  skillId: string,
): { success: boolean; error?: string } {
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  const userDir = getUserSkillsDir(userId);
  const skillDir = path.join(userDir, skillId);

  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'Skill not found or is a project-level skill',
    };
  }

  if (!validateSkillPath(userDir, skillDir)) {
    return { success: false, error: 'Invalid skill path' };
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removeFromSkillsManifest(userId, skillId);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// 批量删除所有用户级技能（清理旧的同步副本）
skillsRoutes.delete('/user-all', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const userDir = getUserSkillsDir(authUser.id);
  let deleted = 0;
  try {
    if (fs.existsSync(userDir)) {
      for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const p = path.join(userDir, entry.name);
        try {
          fs.rmSync(p, { recursive: true, force: true });
          deleted++;
        } catch { /* ignore */ }
      }
    }
  } catch {
    return c.json({ error: 'Failed to delete user skills' }, 500);
  }
  return c.json({ success: true, deleted });
});

skillsRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const result = deleteSkillForUser(authUser.id, id);

  if (!result.success) {
    const status =
      result.error === 'Invalid skill ID' ||
      result.error === 'Invalid skill path'
        ? 400
        : result.error?.includes('not found')
          ? 404
          : 500;
    return c.json({ error: result.error }, status);
  }

  return c.json({ success: true });
});

/**
 * Install a skill package for a specific user.
 * Uses a temporary HOME directory to isolate `npx skills add --global` from
 * the real ~/.claude/skills, eliminating race conditions across concurrent installs.
 * Reusable by both the HTTP route and IPC handler.
 */
async function installSkillForUser(
  userId: string,
  pkg: string,
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  const isNpmName = /^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg);
  const isUrl = /^https?:\/\//.test(pkg);
  if (!isNpmName && !isUrl) {
    return { success: false, error: 'Invalid package name format' };
  }
  // SSRF 防护：URL 形式的 skill package 必须是 HTTPS + 非内网 hostname，
  // 且 hostname 的 DNS 解析结果也不能落在内网 / 云元数据网段。
  // 仅以 npm `<scope>/<name>` 形式不需要这层校验（npm 注册中心走 npx 自带管线）。
  if (isUrl) {
    const reason = validateSafeHttpsUrl(pkg);
    if (reason) {
      return { success: false, error: `Refused skill URL: ${reason}` };
    }
    try {
      await assertResolvesToPublicAddress(
        new URL(pkg).hostname,
        'Skill URL hostname',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Refused skill URL: ${msg}` };
    }
  }

  // Create an isolated temp directory to act as HOME so `--global` installs
  // into tempHome/.claude/skills/ instead of the real ~/.claude/skills/.
  // This avoids any race condition when multiple installs run concurrently.
  // CLAUDE_CONFIG_DIR must also be overridden: skills CLI resolves the
  // claude-code config dir from CLAUDE_CONFIG_DIR first and falls back to
  // HOME/.claude only when unset. happyclaw's main process sets
  // CLAUDE_CONFIG_DIR=data/sessions/main/.claude, so without this override
  // skills land in the real ~/.claude/skills/ and tempHome stays empty.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
  const tempClaudeDir = path.join(tempHome, '.claude');
  const tempSkillsDir = path.join(tempClaudeDir, 'skills');
  fs.mkdirSync(tempSkillsDir, { recursive: true });

  try {
    await execFileAsync(
      'npx',
      ['-y', 'skills', 'add', pkg, '--global', '--yes', '-a', 'claude-code'],
      {
        timeout: 60_000,
        env: {
          ...process.env,
          HOME: tempHome,
          CLAUDE_CONFIG_DIR: tempClaudeDir,
        },
      },
    );

    // Discover all skill directories installed into the temp location
    const installedEntries: string[] = [];
    if (fs.existsSync(tempSkillsDir)) {
      for (const entry of fs.readdirSync(tempSkillsDir, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          installedEntries.push(entry.name);
        }
      }
    }

    if (installedEntries.length === 0) {
      return {
        success: false,
        error: 'No skills were installed — package may be invalid',
      };
    }

    // Copy resolved skill content to per-user directory
    const userDir = getUserSkillsDir(userId);
    fs.mkdirSync(userDir, { recursive: true });

    for (const name of installedEntries) {
      const src = path.join(tempSkillsDir, name);
      const dest = path.join(userDir, name);
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      copySkillToUser(src, dest);
    }

    // Write manifest metadata
    updateSkillsManifest(userId, pkg, installedEntries);

    return { success: true, installed: installedEntries };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    // Always clean up the temp directory
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

/**
 * Sync host-level skills (~/.claude/skills/) to a user's directory.
 * Standalone function usable from both the API route and the auto-sync timer.
 */
skillsRoutes.post('/install', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  if (typeof body.package !== 'string') {
    return c.json({ error: 'package field must be string' }, 400);
  }

  const pkg = body.package.trim();
  const result = await installSkillForUser(authUser.id, pkg);

  if (!result.success) {
    return c.json(
      { error: 'Failed to install skill', details: result.error },
      result.error === 'Invalid package name format' ? 400 : 500,
    );
  }

  return c.json({ success: true, installed: result.installed });
});

// Reinstall a skill by its ID — requires the skill to have a packageName in the manifest.
skillsRoutes.post('/:id/reinstall', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const manifest = readSkillsManifest(authUser.id);
  const meta = manifest.skills[id];
  if (!meta?.packageName) {
    return c.json(
      { error: 'Skill has no package info — cannot reinstall' },
      400,
    );
  }

  // A package can install MULTIPLE sibling skills, and installSkillForUser
  // rewrites EVERY skill dir the package ships (it rm's each destination before
  // copying). Backing up only `id` would let a failed reinstall permanently
  // destroy the live siblings it deleted. So back up every skill that shares
  // this packageName (including `id`) and restore them all on failure.
  const userDir = getUserSkillsDir(authUser.id);
  const siblingIds = Object.keys(manifest.skills).filter(
    (sid) => manifest.skills[sid]?.packageName === meta.packageName,
  );
  if (!siblingIds.includes(id)) siblingIds.push(id);

  for (const sid of siblingIds) {
    if (!validateSkillPath(userDir, path.join(userDir, sid))) {
      return c.json({ error: 'Invalid skill path' }, 400);
    }
  }

  type SkillBackup = {
    sid: string;
    dir: string;
    // null when the sibling had a manifest entry but no on-disk dir (desync):
    // there is nothing to rename back, only the manifest entry to restore.
    backupDir: string | null;
    meta: SkillsManifest['skills'][string];
  };
  const backups: SkillBackup[] = [];
  // Restore every backed-up sibling (dir + manifest entry). Best-effort: a
  // failure here leaves the *.reinstall-bak dir on disk for manual recovery.
  const restoreBackups = (): void => {
    for (const b of backups) {
      try {
        if (b.backupDir) {
          fs.rmSync(b.dir, { recursive: true, force: true }); // clear partial install
          fs.renameSync(b.backupDir, b.dir);
        }
        const m = readSkillsManifest(authUser.id);
        m.skills[b.sid] = b.meta;
        writeSkillsManifest(authUser.id, m);
      } catch {
        /* best-effort rollback */
      }
    }
  };

  // Back up each sibling dir (rename, don't delete) so a failed reinstall can
  // roll back instead of permanently destroying the user's skills. The manifest
  // entry is recorded for backup whenever it exists — even if its dir is already
  // missing (manifest/dir desync) — so removeFromSkillsManifest below is always
  // recoverable on a failed reinstall.
  try {
    for (const sid of siblingIds) {
      const entry = manifest.skills[sid];
      const dir = path.join(userDir, sid);
      const backupDir = `${dir}.reinstall-bak`;
      let savedBackupDir: string | null = null;
      if (fs.existsSync(dir)) {
        fs.rmSync(backupDir, { recursive: true, force: true }); // clear stale backup
        fs.renameSync(dir, backupDir);
        savedBackupDir = backupDir;
      }
      if (entry) backups.push({ sid, dir, backupDir: savedBackupDir, meta: entry });
      removeFromSkillsManifest(authUser.id, sid);
    }
  } catch (err) {
    restoreBackups();
    return c.json(
      {
        error: 'Failed to back up old skill',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      500,
    );
  }

  const installResult = await installSkillForUser(
    authUser.id,
    meta.packageName,
  );
  if (!installResult.success) {
    // Roll back: restoreBackups removes any partial install dirs and restores
    // every sibling so nothing is lost.
    restoreBackups();
    return c.json(
      { error: 'Failed to reinstall skill', details: installResult.error },
      500,
    );
  }

  // Success — drop all backups (skip entries that had no on-disk dir to back up).
  for (const b of backups) {
    if (!b.backupDir) continue;
    try {
      fs.rmSync(b.backupDir, { recursive: true, force: true });
    } catch {
      /* leftover backup is harmless */
    }
  }

  return c.json({ success: true, installed: installResult.installed });
});

// ===========================================================================
// Upgraded routes: AI generation, online edit, optimize, upload, debug.
// ===========================================================================

interface SkillsManifestWithSourceType {
  skills: Record<
    string,
    {
      packageName: string;
      installedAt: string;
      source: string;
      sourceType?: 'generated' | 'uploaded' | 'edited' | 'optimized' | 'registry';
    }
  >;
}

function setManifestSourceType(
  userId: string,
  skillId: string,
  sourceType: 'generated' | 'uploaded' | 'edited' | 'optimized' | 'registry',
): void {
  const manifest = readSkillsManifest(userId) as SkillsManifestWithSourceType;
  const existing = manifest.skills[skillId];
  if (existing) {
    existing.sourceType = sourceType;
    manifest.skills[skillId] = existing;
  } else {
    manifest.skills[skillId] = {
      packageName: 'local',
      installedAt: new Date().toISOString(),
      source: 'local',
      sourceType,
    };
  }
  writeSkillsManifest(userId, manifest);
}

/**
 * POST /api/skills/create
 * AI-generate a new skill from natural-language description.
 */
skillsRoutes.post('/create', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({})) as {
    description_prompt?: unknown;
    name?: unknown;
  };

  const descriptionPrompt = typeof body.description_prompt === 'string' ? body.description_prompt.trim() : '';
  if (descriptionPrompt.length < 10) {
    return c.json({ error: 'description_prompt must be at least 10 characters' }, 400);
  }
  const suggestedName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;

  const userDir = getUserSkillsDir(authUser.id);
  fs.mkdirSync(userDir, { recursive: true });

  // Pre-resolve a skill ID conflict against the suggested name so we can pass
  // it to the AI as a hint. If the AI overrides the name, we re-resolve after.
  const baseId = suggestedName
    ? slugifySkillName(suggestedName)
    : slugifySkillName(descriptionPrompt);
  const preResolvedId = resolveSkillIdConflict(userDir, baseId);

  const result = await generateSkillContent(descriptionPrompt, preResolvedId);
  if ('error' in result) {
    return c.json({ error: result.error }, 502);
  }

  // Re-validate generated content
  const validation = validateSkillContent(result.content);
  if (!validation.valid) {
    logger.warn({ err: validation.error }, 'AI-generated skill content failed validation');
    return c.json(
      { error: `AI generated invalid content: ${validation.error}` },
      502,
    );
  }

  // If the AI chose a different name, resolve conflict against that
  const finalId = resolveSkillIdConflict(userDir, slugifySkillName(validation.frontmatter!.name));
  const skillDir = path.join(userDir, finalId);
  fs.mkdirSync(skillDir, { recursive: true });
  writeSkillContent(authUser.id, finalId, result.content);
  setManifestSourceType(authUser.id, finalId, 'generated');

  const skill = getSkillDetail(finalId, authUser.id, authUser.role);
  return c.json({ success: true, skill_id: finalId, skill });
});

/**
 * PUT /api/skills/:id/content
 * Online edit/save SKILL.md content. User-level skills only.
 */
skillsRoutes.put('/:id/content', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({})) as { content?: unknown };

  if (typeof body.content !== 'string') {
    return c.json({ error: 'content must be a string' }, 400);
  }
  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);
  if (!fs.existsSync(skillDir)) {
    return c.json({ error: 'Skill not found or is not a user-level skill' }, 404);
  }
  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  const validation = validateSkillContent(body.content);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  writeSkillContent(authUser.id, id, body.content);
  setManifestSourceType(authUser.id, id, 'edited');

  const skill = getSkillDetail(id, authUser.id, authUser.role);
  return c.json({ success: true, skill });
});

/**
 * POST /api/skills/:id/optimize
 * AI-optimize the current SKILL.md. Returns preview; does NOT write.
 */
skillsRoutes.post('/:id/optimize', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({})) as { feedback?: unknown };

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const contentPath = getSkillContentPath(authUser.id, id);
  if (!contentPath) {
    return c.json({ error: 'Skill not found or is not a user-level skill' }, 404);
  }
  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);
  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  const currentContent = fs.readFileSync(contentPath, 'utf-8');
  const feedback = typeof body.feedback === 'string' ? body.feedback : undefined;

  const result = await optimizeSkillContent(currentContent, feedback);
  if ('error' in result) {
    return c.json({ error: result.error }, 502);
  }

  // Validate the optimized content before returning — don't preview broken output
  const validation = validateSkillContent(result.content);
  if (!validation.valid) {
    return c.json(
      { error: `AI optimized content is invalid: ${validation.error}` },
      502,
    );
  }

  return c.json({ optimized_content: result.content, original_content: currentContent });
});

/**
 * POST /api/skills/:id/optimize/apply
 * Apply a previously-previewed optimized content. Backs up current content first.
 */
skillsRoutes.post('/:id/optimize/apply', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({})) as { content?: unknown };

  if (typeof body.content !== 'string') {
    return c.json({ error: 'content must be a string' }, 400);
  }
  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const userDir = getUserSkillsDir(authUser.id);
  const skillDir = path.join(userDir, id);
  if (!fs.existsSync(skillDir)) {
    return c.json({ error: 'Skill not found or is not a user-level skill' }, 404);
  }
  if (!validateSkillPath(userDir, skillDir)) {
    return c.json({ error: 'Invalid skill path' }, 400);
  }

  const validation = validateSkillContent(body.content);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const backupPath = backupSkillContent(authUser.id, id);
  writeSkillContent(authUser.id, id, body.content);
  setManifestSourceType(authUser.id, id, 'optimized');

  return c.json({ success: true, backup_path: backupPath });
});

/**
 * POST /api/skills/upload
 * Upload a zip-compressed skill package.
 */
skillsRoutes.post('/upload', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;

  const body = await c.req.parseBody({ all: false });
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing "file" field in form data' }, 400);
  }

  // Must be a .zip
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith('.zip')) {
    return c.json({ error: 'File must be a .zip archive' }, 400);
  }
  if (file.size === 0) {
    return c.json({ error: 'Empty file' }, 400);
  }
  if (file.size > 10 * 1024 * 1024) {
    return c.json({ error: 'File exceeds 10MB limit' }, 400);
  }

  const userDir = getUserSkillsDir(authUser.id);
  fs.mkdirSync(userDir, { recursive: true });

  // Save to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-upload-'));
  const tmpZip = path.join(tmpDir, 'upload.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(tmpZip, buffer);

    // List entries first to validate before extracting
    const { stdout: listOutput } = await execFileAsync('unzip', ['-l', tmpZip], {
      maxBuffer: 1024 * 1024,
    });
    const listedEntries: string[] = [];
    for (const line of listOutput.split('\n')) {
      // unzip -l output format (varies by version/locale):
      //   "  Length  Date    Time    CRC-32   Name"  (some versions)
      //   "  Length  Date    Time    Name"          (others — no CRC column)
      // Date can be MM-DD-YYYY or YYYY-MM-DD. The entry path is the last column.
      // Skip header/footer lines (no leading digit).
      // Match: leading spaces + digits (length) + date + time + optional CRC + path
      const m = line.match(
        /^\s*\d+\s+\d{2,4}-\d{2}-\d{2,4}\s+\d{2}:\d{2}(?:\s+[\da-fA-F]+)?\s+(.+)$/,
      );
      if (m) {
        const entryPath = m[1].trim();
        // Filter out footer line like "---------                     -------"
        // and summary lines like "103                     2 files"
        if (!/^-+$/.test(entryPath) && !/^\d+\s+\d+\s+files?$/.test(entryPath)) {
          listedEntries.push(entryPath);
        }
      }
    }
    const entryCheck = validateZipEntries(listedEntries);
    if (!entryCheck.safe) {
      return c.json({ error: `Invalid zip: ${entryCheck.reason}` }, 400);
    }
    if (listedEntries.length === 0) {
      return c.json({ error: 'Zip archive is empty' }, 400);
    }
    if (listedEntries.length > 100) {
      return c.json({ error: 'Zip archive exceeds 100 entries' }, 400);
    }

    // Extract
    await execFileAsync('unzip', ['-o', '-q', tmpZip, '-d', extractDir], {
      maxBuffer: 10 * 1024 * 1024,
    });

    // Find SKILL.md: either at the top level, or inside a single nested directory
    let skillRootDir: string | null = null;
    if (fs.existsSync(path.join(extractDir, 'SKILL.md')) ||
        fs.existsSync(path.join(extractDir, 'SKILL.md.disabled'))) {
      skillRootDir = extractDir;
    } else {
      // Look for a single subdirectory containing SKILL.md
      const subdirs = fs.readdirSync(extractDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      if (subdirs.length === 1) {
        const sub = path.join(extractDir, subdirs[0].name);
        if (fs.existsSync(path.join(sub, 'SKILL.md')) ||
            fs.existsSync(path.join(sub, 'SKILL.md.disabled'))) {
          skillRootDir = sub;
        }
      }
    }

    if (!skillRootDir) {
      return c.json(
        { error: 'Zip must contain SKILL.md at top level or in a single subdirectory' },
        400,
      );
    }

    // Read SKILL.md to determine skill ID
    const skillMdPath = fs.existsSync(path.join(skillRootDir, 'SKILL.md'))
      ? path.join(skillRootDir, 'SKILL.md')
      : path.join(skillRootDir, 'SKILL.md.disabled');
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const validation = validateSkillContent(content);
    if (!validation.valid) {
      return c.json({ error: `Uploaded SKILL.md is invalid: ${validation.error}` }, 400);
    }

    const skillId = slugifySkillName(validation.frontmatter!.name);
    const targetDir = path.join(userDir, skillId);
    if (fs.existsSync(targetDir)) {
      return c.json(
        { error: `Skill "${skillId}" already exists — rename or delete the existing one first` },
        409,
      );
    }

    // Move extracted skill root into user skills dir
    fs.renameSync(skillRootDir, targetDir);

    setManifestSourceType(authUser.id, skillId, 'uploaded');
    const skill = getSkillDetail(skillId, authUser.id, authUser.role);
    return c.json({ success: true, skill_id: skillId, skill });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Failed to upload skill zip');
    return c.json(
      { error: 'Failed to process zip upload', details: (err as Error).message },
      500,
    );
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

/**
 * POST /api/skills/:id/debug
 * Run a single-turn debug query with the skill content as context.
 */
skillsRoutes.post('/:id/debug', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({})) as { test_input?: unknown; mode?: unknown };

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }
  const testInput = typeof body.test_input === 'string' ? body.test_input.trim() : '';
  if (testInput.length === 0) {
    return c.json({ error: 'test_input must be a non-empty string' }, 400);
  }
  const mode = body.mode === 'real' ? 'real' : 'ai';

  // Search user / project / external for the skill content (read-only)
  const skill = getSkillDetail(id, authUser.id, authUser.role);
  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  const result = await debugSkill(skill.content, testInput, mode);
  if ('error' in result) {
    return c.json({ error: result.error }, 502);
  }

  return c.json({ output: result.output, duration_ms: result.durationMs, mode: result.mode });
});

// ─── v58: skill_versions — version history / rollback ──────────

// GET /api/skills/:id/versions — list version snapshots (newest first)
skillsRoutes.get('/:id/versions', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);
  const versions = listSkillVersions(id, authUser.id);
  return c.json({ versions });
});

// POST /api/skills/:id/versions — snapshot the current SKILL.md content as a
// new version. Body: { notes?: string }. Returns the new version row.
skillsRoutes.post('/:id/versions', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);
  const body = await c.req.json().catch(() => ({})) as { notes?: unknown };
  const skill = getSkillDetail(id, authUser.id, authUser.role);
  if (!skill) return c.json({ error: 'Skill not found' }, 404);
  const notes = typeof body.notes === 'string' ? body.notes : null;
  const row = createSkillVersion({
    skillId: id,
    userId: authUser.id,
    content: skill.content,
    notes,
  });
  return c.json({ version: row }, 201);
});

// POST /api/skills/:id/versions/:version/restore — restore a prior version's
// content to the live SKILL.md (writes via writeSkillContent; the restore
// itself is a content mutation, so it lands in the user's skills dir).
skillsRoutes.post('/:id/versions/:version/restore', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const versionNum = Number(c.req.param('version'));
  const authUser = c.get('user') as AuthUser;
  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);
  if (!Number.isInteger(versionNum) || versionNum < 1) {
    return c.json({ error: 'Invalid version' }, 400);
  }
  const row = getSkillVersion(id, authUser.id, versionNum);
  if (!row) return c.json({ error: 'Version not found' }, 404);
  // Backup current content before overwriting (safety net).
  backupSkillContent(authUser.id, id);
  writeSkillContent(authUser.id, id, row.content);
  return c.json({ ok: true, restored_version: versionNum });
});

export { getUserSkillsDir, installSkillForUser, deleteSkillForUser };
export default skillsRoutes;
