import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Play, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/api/client';
import type { McpServer } from '../../stores/mcp-servers';

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

interface McpCallResult {
  content?: McpCallContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
}

interface McpServerToolsProps {
  server: McpServer;
}

/** 根据 inputSchema 生成 JSON 参数模板（default 优先，否则按类型给占位）。 */
function buildArgsTemplate(inputSchema?: Record<string, unknown>): string {
  const props = inputSchema?.properties as Record<string, unknown> | undefined;
  if (!props || typeof props !== 'object') return '{}';
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(props)) {
    const schema = (raw ?? {}) as { type?: string; default?: unknown };
    if (schema.default !== undefined) {
      out[key] = schema.default;
      continue;
    }
    switch (schema.type) {
      case 'integer':
      case 'number':
        out[key] = 0;
        break;
      case 'boolean':
        out[key] = false;
        break;
      case 'array':
        out[key] = [];
        break;
      case 'object':
        out[key] = {};
        break;
      default:
        out[key] = '';
    }
  }
  return JSON.stringify(out, null, 2);
}

/** 将 tools/call 的 content 数组格式化为可读文本。 */
function formatContent(content: McpCallContentItem[]): string {
  if (!Array.isArray(content) || content.length === 0) return '(无输出)';
  return content
    .map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') {
        try {
          return JSON.stringify(JSON.parse(item.text), null, 2);
        } catch {
          return item.text;
        }
      }
      if (item.type === 'image' && typeof item.data === 'string') {
        return `[图片 ${item.mimeType ?? 'image'}] ${item.data.slice(0, 40)}…`;
      }
      return JSON.stringify(item, null, 2);
    })
    .join('\n');
}

export function McpServerTools({ server }: McpServerToolsProps) {
  const [tools, setTools] = useState<McpTool[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<Record<string, { text: string; isError: boolean }>>({});

  const loadTools = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ tools: McpTool[] }>(
        `/api/mcp-servers/${encodeURIComponent(server.id)}/tools`,
        { timeoutMs: 35_000 },
      );
      setTools(data.tools ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTools([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTools([]);
    setExpanded({});
    setArgs({});
    setRunning({});
    setResult({});
    setError(null);
    loadTools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const toggle = (name: string, template: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
    if (!args[name]) setArgs((prev) => ({ ...prev, [name]: template }));
  };

  const run = async (name: string) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(args[name] || '{}');
    } catch {
      setResult((prev) => ({ ...prev, [name]: { text: '参数不是合法 JSON', isError: true } }));
      return;
    }
    setRunning((prev) => ({ ...prev, [name]: true }));
    try {
      const res = await apiFetch<McpCallResult>(
        `/api/mcp-servers/${encodeURIComponent(server.id)}/tools/call`,
        { method: 'POST', body: JSON.stringify({ toolName: name, args: parsed }), timeoutMs: 130_000 },
      );
      setResult((prev) => ({
        ...prev,
        [name]: {
          text: formatContent(res.content ?? []),
          isError: res.isError === true,
        },
      }));
    } catch (err) {
      setResult((prev) => ({
        ...prev,
        [name]: { text: `调用失败：${err instanceof Error ? err.message : String(err)}`, isError: true },
      }));
    } finally {
      setRunning((prev) => ({ ...prev, [name]: false }));
    }
  };

  return (
    <div className="p-6 border-b border-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">工具</h3>
          {!loading && !error && (
            <span className="text-xs text-muted-foreground">{tools.length} 个</span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={loadTools} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          刷新
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground py-2">加载工具列表中…</p>
      ) : error ? (
        <div className="rounded-md bg-error-bg border border-error/20 p-3 text-sm text-error whitespace-pre-wrap">
          {error}
        </div>
      ) : tools.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">未发现工具</p>
      ) : (
        <div className="space-y-2">
          {tools.map((tool) => {
            const isOpen = !!expanded[tool.name];
            const template = buildArgsTemplate(tool.inputSchema);
            const res = result[tool.name];
            return (
              <div key={tool.name} className="rounded-md bg-muted/40">
                <button
                  type="button"
                  onClick={() => toggle(tool.name, template)}
                  className="w-full flex items-center justify-between gap-2 p-3 text-left"
                >
                  <div className="min-w-0 flex items-center gap-2">
                    {isOpen ? (
                      <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
                    )}
                    <span className="font-mono text-sm text-primary truncate">{tool.name}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(tool.name, template);
                    }}
                  >
                    <Play size={14} />
                    测试
                  </Button>
                </button>

                {tool.description && (
                  <p className="px-3 pb-2 text-xs text-muted-foreground">{tool.description}</p>
                )}

                {isOpen && (
                  <div className="px-3 pb-3 space-y-2 border-t border-border pt-3">
                    {tool.inputSchema && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                          入参 schema
                        </summary>
                        <pre className="mt-1 p-2 bg-background border border-border rounded-md text-xs whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
                          {JSON.stringify(tool.inputSchema, null, 2)}
                        </pre>
                      </details>
                    )}
                    <div>
                      <Label className="text-xs mb-1">参数（JSON）</Label>
                      <Textarea
                        value={args[tool.name] ?? template}
                        onChange={(e) => setArgs((prev) => ({ ...prev, [tool.name]: e.target.value }))}
                        placeholder='{"query": "headache"}'
                        className="font-mono text-xs min-h-[60px]"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => run(tool.name)} disabled={running[tool.name]}>
                        {running[tool.name] ? '运行中…' : '运行测试'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [tool.name]: false }))
                        }
                      >
                        <X size={14} /> 关闭
                      </Button>
                    </div>
                    {res !== undefined && (
                      <pre
                        className={`mt-2 p-2 border rounded-md text-xs whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${
                          res.isError
                            ? 'bg-error-bg border-error/20 text-error'
                            : 'bg-background border-border text-foreground'
                        }`}
                      >
                        {res.text}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
