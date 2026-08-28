/**
 * Lightweight MCP client used by the "MCP 服务器" module to list a server's
 * tools (tools/list) and test-call them (tools/call) directly from the UI.
 *
 * Each list/call opens a one-shot connection and closes it in `finally`, so a
 * stdio server's child process is always torn down afterwards.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from './logger.js';

// --- Types ---

export interface McpServerConfig {
  // http/sse type
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  // stdio type
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content: McpToolCallContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
}

// --- Timeouts ---

const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

// --- Helpers ---

export function buildTransport(cfg: McpServerConfig): Transport {
  const isHttp = cfg.type === 'http';
  const isSse = cfg.type === 'sse';

  if (isHttp || isSse) {
    const url = cfg.url;
    if (!url) {
      throw new Error('HTTP/Sse MCP server missing url');
    }
    const parsed = new URL(url);
    const headers = cfg.headers && Object.keys(cfg.headers).length > 0 ? cfg.headers : undefined;
    if (isHttp) {
      return new StreamableHTTPClientTransport(parsed, {
        requestInit: headers ? { headers } : undefined,
      });
    }
    // SSE (deprecated in MCP spec, kept for backward compatibility)
    return new SSEClientTransport(parsed, {
      requestInit: headers ? { headers } : undefined,
    });
  }

  const command = cfg.command;
  if (!command) {
    throw new Error('stdio MCP server missing command');
  }
  // Merge the server's custom env on top of a safe default environment
  // (PATH/HOME/etc). Passing env alone would drop PATH and the child fails.
  return new StdioClientTransport({
    command,
    args: cfg.args ?? [],
    env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
    stderr: 'ignore',
  });
}

/** Convert an unknown thrown value into a clean, user-readable message. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    // ENOENT (stdio spawn failure) surfaces via onerror / connect rejection.
    if (code === 'ENOENT') {
      return `命令不存在或无法执行：${err.message}`;
    }
    return err.message;
  }
  return String(err);
}

// --- Public API ---

export async function listMcpTools(cfg: McpServerConfig): Promise<McpToolInfo[]> {
  const transport = buildTransport(cfg);
  const client = new Client({ name: 'deepthink', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const result = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  } catch (err) {
    logger.warn({ err: toErrorMessage(err) }, 'mcp listTools failed');
    throw new Error(toErrorMessage(err));
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close errors on a failed connection
    }
  }
}

export async function callMcpTool(
  cfg: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const transport = buildTransport(cfg);
  const client = new Client({ name: 'deepthink', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const raw = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    const result = raw as {
      content?: McpToolCallContentItem[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    return {
      content: Array.isArray(result.content) ? result.content : [],
      isError: result.isError === true,
      structuredContent: result.structuredContent,
    };
  } catch (err) {
    logger.warn({ err: toErrorMessage(err), tool: toolName }, 'mcp callTool failed');
    throw new Error(toErrorMessage(err));
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }
}
