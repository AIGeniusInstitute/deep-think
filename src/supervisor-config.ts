import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

const CONFIG_DIR = join(process.env.DATA_DIR || './data', 'config');
const CONFIG_FILE = join(CONFIG_DIR, 'supervisor-enabled.json');

interface GroupMode {
  /** Whether the pre-dispatch Supervisor intent parser is enabled for this chat. Default false. */
  supervisor?: boolean;
  /** Whether this chat runs in 全托管 (autonomous) mode. Default false.
   *  When true, Supervisor clarify is bypassed and agent-runner auto-continues
   *  on end-of-turn questions. */
  autonomous?: boolean;
}

interface SupervisorConfig {
  /** Map of chatJid → mode flags. Backward compatible: legacy entries
   * (plain booleans) are auto-migrated to { supervisor: boolean } on read. */
  groups: Record<string, boolean | GroupMode>;
}

let cache: SupervisorConfig | null = null;

function normalizeGroupMode(raw: boolean | GroupMode | undefined): GroupMode {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'boolean') return { supervisor: raw };
  return {
    supervisor: raw.supervisor,
    autonomous: raw.autonomous,
  };
}

async function loadConfig(): Promise<SupervisorConfig> {
  if (cache) return cache;
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as SupervisorConfig;
    // Normalize legacy plain-boolean entries to { supervisor, autonomous } shape.
    const normalized: Record<string, GroupMode> = {};
    for (const [jid, val] of Object.entries(parsed.groups ?? {})) {
      normalized[jid] = normalizeGroupMode(val);
    }
    cache = { groups: normalized };
  } catch {
    cache = { groups: {} };
  }
  return cache!;
}

async function saveConfig(cfg: SupervisorConfig): Promise<void> {
  try {
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    cache = cfg;
  } catch (err) {
    logger.error({ err }, 'Failed to save supervisor config');
  }
}

export async function isSupervisorEnabled(chatJid: string): Promise<boolean> {
  const cfg = await loadConfig();
  return normalizeGroupMode(cfg.groups[chatJid]).supervisor ?? false;
}

export async function setSupervisorEnabled(chatJid: string, enabled: boolean): Promise<void> {
  const cfg = await loadConfig();
  const cur = normalizeGroupMode(cfg.groups[chatJid]);
  cfg.groups[chatJid] = { ...cur, supervisor: enabled };
  await saveConfig(cfg);
}

export async function getAllSupervisorEnabled(): Promise<Record<string, boolean>> {
  const cfg = await loadConfig();
  const out: Record<string, boolean> = {};
  for (const [jid, mode] of Object.entries(cfg.groups)) {
    out[jid] = normalizeGroupMode(mode).supervisor ?? false;
  }
  return out;
}

export async function isAutonomousEnabled(chatJid: string): Promise<boolean> {
  const cfg = await loadConfig();
  return normalizeGroupMode(cfg.groups[chatJid]).autonomous ?? false;
}

export async function setAutonomousEnabled(chatJid: string, enabled: boolean): Promise<void> {
  const cfg = await loadConfig();
  const cur = normalizeGroupMode(cfg.groups[chatJid]);
  cfg.groups[chatJid] = { ...cur, autonomous: enabled };
  await saveConfig(cfg);
}

export async function getAllAutonomousEnabled(): Promise<Record<string, boolean>> {
  const cfg = await loadConfig();
  const out: Record<string, boolean> = {};
  for (const [jid, mode] of Object.entries(cfg.groups)) {
    out[jid] = normalizeGroupMode(mode).autonomous ?? false;
  }
  return out;
}
