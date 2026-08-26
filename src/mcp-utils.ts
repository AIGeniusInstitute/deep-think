/**
 * Shared MCP server loading utilities.
 * Used by container-runner (Docker + Host modes) and routes/mcp-servers.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, WEB_PORT } from './config.js';
import { listEnabledRegistryTools, getOrCreateRegistryToken } from './db.js';

/**
 * Registry MCP endpoint base URL — the URL the agent's MCP http client will
 * use to reach back to this DeepThink main server.
 *
 * - Host execution mode (agent-runner is a subprocess): 127.0.0.1 works.
 * - Docker mode: container shares the host network's `host.docker.internal`
 *   alias (added via --add-host=host.docker.internal:host-gateway in
 *   container-runner's buildContainerArgs). Caller passes that override.
 */
function defaultRegistryBaseUrl(): string {
  return `http://127.0.0.1:${WEB_PORT}`;
}

/**
 * Load enabled MCP server configs from a servers.json file.
 * Returns only enabled servers with fields needed for settings.json.
 * Supports both stdio (command/args/env) and http/sse (type/url/headers) server types.
 */
function loadMcpServersFromFile(
  serversFile: string,
): Record<string, Record<string, unknown>> {
  try {
    if (!fs.existsSync(serversFile)) return {};
    const file = JSON.parse(fs.readFileSync(serversFile, 'utf8')) as {
      servers?: Record<string, Record<string, unknown>>;
    };
    const raw = file.servers || {};
    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(raw)) {
      if (!server.enabled) continue;

      const isHttpType = server.type === 'http' || server.type === 'sse';

      if (isHttpType) {
        if (!server.url) continue;
        const entry: Record<string, unknown> = {
          type: server.type,
          url: server.url,
        };
        if (
          server.headers &&
          typeof server.headers === 'object' &&
          Object.keys(server.headers as object).length > 0
        ) {
          entry.headers = server.headers;
        }
        result[name] = entry;
      } else {
        if (!server.command) continue;
        const entry: Record<string, unknown> = { command: server.command };
        if (server.args) entry.args = server.args;
        if (
          server.env &&
          typeof server.env === 'object' &&
          Object.keys(server.env as object).length > 0
        ) {
          entry.env = server.env;
        }
        result[name] = entry;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load enabled MCP server configs for a user.
 * Reads data/mcp-servers/{userId}/servers.json.
 * All workspaces owned by this user share the same MCP server set.
 *
 * Additionally auto-injects a `__registry` http-type MCP server pointing at
 * DeepThink's MCP Registry endpoint, but only when the user has at least one
 * enabled registry tool. Agents then see all registered HTTP-API tools through
 * this single aggregated MCP server. Zero agent-runner changes: the SDK
 * already supports http MCP servers natively.
 *
 * opts.baseUrl overrides the registry endpoint base (Docker mode passes
 * `http://host.docker.internal:<port>`).
 */
export function loadUserMcpServers(
  userId: string,
  opts?: { baseUrl?: string },
): Record<string, Record<string, unknown>> {
  const serversFile = path.join(DATA_DIR, 'mcp-servers', userId, 'servers.json');
  const result = loadMcpServersFromFile(serversFile);

  // Auto-inject the MCP Registry aggregated server when the user has tools.
  try {
    const enabled = listEnabledRegistryTools(userId);
    if (enabled.length > 0) {
      const token = getOrCreateRegistryToken(userId);
      const base = (opts?.baseUrl || defaultRegistryBaseUrl()).replace(/\/+$/, '');
      result['__registry'] = {
        type: 'http',
        url: `${base}/api/mcp-registry/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      };
    }
  } catch (err) {
    // DB not ready / unavailable — skip registry injection silently.
    // The user's manually-configured servers must still load.
  }

  return result;
}
