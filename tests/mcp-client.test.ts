import { describe, it, expect } from 'vitest';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildTransport, toErrorMessage } from '../src/mcp-client.js';

describe('buildTransport', () => {
  it('http 类型映射为 StreamableHTTPClientTransport', () => {
    const t = buildTransport({ type: 'http', url: 'http://127.0.0.1:9999/mcp' });
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('sse 类型映射为 SSEClientTransport', () => {
    const t = buildTransport({ type: 'sse', url: 'http://127.0.0.1:9999/sse' });
    expect(t).toBeInstanceOf(SSEClientTransport);
  });

  it('缺省（stdio）映射为 StdioClientTransport', () => {
    const t = buildTransport({ command: 'node', args: ['server.js'] });
    expect(t).toBeInstanceOf(StdioClientTransport);
  });

  it('http/sse 缺少 url 抛错', () => {
    expect(() => buildTransport({ type: 'http' })).toThrow(/missing url/i);
    expect(() => buildTransport({ type: 'sse' })).toThrow(/missing url/i);
  });

  it('stdio 缺少 command 抛错', () => {
    expect(() => buildTransport({})).toThrow(/missing command/i);
  });
});

describe('toErrorMessage', () => {
  it('ENOENT 归一化为友好提示', () => {
    const err = Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' });
    expect(toErrorMessage(err)).toMatch(/命令不存在或无法执行/);
    expect(toErrorMessage(err)).toContain('spawn npx ENOENT');
  });

  it('普通 Error 返回其 message', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('非 Error 值转字符串', () => {
    expect(toErrorMessage('x')).toBe('x');
    expect(toErrorMessage(42)).toBe('42');
  });
});
