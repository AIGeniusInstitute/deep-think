import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { __dirname } from './meta.js';

const PRODUCT_NAME = 'DeepThink';

function userDataRoot(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', PRODUCT_NAME);
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), PRODUCT_NAME);
    case 'linux':
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), PRODUCT_NAME);
    default:
      return path.join(home, '.' + PRODUCT_NAME.toLowerCase());
  }
}

export const appDataDir = userDataRoot();
export const dataDir = path.join(appDataDir, 'data');
export const logDir = path.join(appDataDir, 'logs');
export const backupsDir = path.join(appDataDir, 'backups');

export const isPackaged = app.isPackaged;

// In dev mode, the project root (loop-engineering) is the parent of desktop/.
const PROJECT_ROOT = isPackaged
  ? null
  : path.resolve(__dirname, '..', '..');

export function resourcesDir(): string {
  if (isPackaged) {
    return process.resourcesPath as string;
  }
  // Dev mode: simulate packaged layout under desktop/dev-resources/
  return path.resolve(__dirname, '..', 'dev-resources');
}

function resolveDevOrPackaged(devRelative: string, packagedRelative: string, envVar: string): string {
  const envValue = process.env[envVar];
  if (envValue) return path.resolve(envValue);
  if (isPackaged) return path.join(resourcesDir(), packagedRelative);
  return path.join(PROJECT_ROOT!, devRelative);
}

export const backendEntry = resolveDevOrPackaged(
  'dist',
  'backend',
  'DEEPTHINK_BACKEND_DIR',
) + '/index.js';

export const webDistDir = resolveDevOrPackaged(
  'web/dist',
  'web-dist',
  'DEEPTHINK_WEB_DIST_DIR',
);

export const agentRunnerDir = resolveDevOrPackaged(
  'container/agent-runner',
  'agent-runner',
  'DEEPTHINK_AGENT_RUNNER_DIR',
);

export const nodeBinary = (() => {
  const envValue = process.env.DEEPTHINK_NODE_BINARY;
  if (envValue) return path.resolve(envValue);
  if (isPackaged) {
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    return path.join(resourcesDir(), 'node', name);
  }
  // Dev: prefer a real Node binary from PATH. Electron's binary has a different
  // ABI, which breaks native modules like better-sqlite3 / node-pty. Fall back
  // to process.execPath only as a last resort.
  return resolveSystemNode() || process.execPath;
})();

function resolveSystemNode(): string | null {
  const candidates: string[] = [];
  // Common install locations
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  } else if (process.platform === 'linux') {
    candidates.push('/usr/bin/node', '/usr/local/bin/node', '/snap/bin/node');
  } else if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\nodejs\\node.exe');
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.accessSync(c, fs.constants.X_OK) === undefined) {
        return c;
      }
    } catch { /* try next */ }
  }
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch { /* no node on PATH */ }
  return null;
}

export function ensureDirs(): void {
  for (const dir of [appDataDir, dataDir, logDir, backupsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const backendLogPath = path.join(logDir, 'backend.log');

