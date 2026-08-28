import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, Copy, Trash2, Loader2, Activity, Coins, FileText, Hash, Send, FlaskConical, Sparkles, Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { withBasePath } from '../utils/url';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';

interface ApiKeyItem {
  id: string;
  name: string;
  key_prefix: string;
  masked_key: string;
  scopes: string[];
  enabled: boolean;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

interface UsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface UsageDaily extends UsageSummary {
  date: string;
}

const SCOPE_LABELS: Record<string, string> = {
  maas: 'MaaS（大模型 API）',
  agent: 'Agent（智能体）',
  '*': '全部',
};

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN');
}

/** 内联 SVG 折线图，展示每日请求/成本趋势（不引第三方图表库）。 */
function TrendChart({ daily, metric }: { daily: UsageDaily[]; metric: 'requests' | 'costUsd' }) {
  const w = 560;
  const h = 160;
  const pad = 24;
  const values = daily.map((d) => d[metric]);
  const max = Math.max(1, ...values);
  const n = daily.length;
  const stepX = n > 1 ? (w - pad * 2) / (n - 1) : 0;
  const points = daily.map((d, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (d[metric] / max) * (h - pad * 2);
    return { x, y, label: d.date.slice(5), value: d[metric] };
  });
  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-40" role="img" aria-label="用量趋势图">
      {[0.25, 0.5, 0.75, 1].map((t) => (
        <line
          key={t}
          x1={pad}
          x2={w - pad}
          y1={h - pad - (h - pad * 2) * t}
          y2={h - pad - (h - pad * 2) * t}
          stroke="currentColor"
          strokeOpacity={0.1}
          strokeWidth={1}
        />
      ))}
      {points.length > 1 && (
        <polyline points={polyline} fill="none" stroke="#0d9488" strokeWidth={2} strokeLinejoin="round" />
      )}
      {points.map((p) => (
        <g key={p.label + p.x}>
          <circle cx={p.x} cy={p.y} r={3} fill="#0d9488" />
          <text x={p.x} y={h - 6} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.6}>
            {p.label}
          </text>
          <title>{`${p.label}: ${metric === 'costUsd' ? `$${p.value.toFixed(4)}` : fmtNum(p.value)}`}</title>
        </g>
      ))}
    </svg>
  );
}

interface AgentOption {
  id: string;
  name: string;
  enabled?: boolean;
  description?: string;
}

const API_HOST = typeof window !== 'undefined' ? window.location.origin : '<host>';

type Protocol = 'maas' | 'agent';
type Lang = 'curl' | 'python' | 'node';

/** 六段接入示例：协议 × 语言，含非流式 + 流式 SSE 写法。 */
const SAMPLES: Record<Protocol, Record<Lang, string>> = {
  maas: {
    curl: `# 非流式
curl ${API_HOST}/v1/chat/completions \\
  -H "Authorization: Bearer sk-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<model>","messages":[{"role":"user","content":"你好"}]}'

# 流式（SSE）
curl -N ${API_HOST}/v1/chat/completions \\
  -H "Authorization: Bearer sk-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<model>","messages":[{"role":"user","content":"你好"}],"stream":true}'`,
    python: `import requests, json

API = "${API_HOST}/v1/chat/completions"
HEADERS = {"Authorization": "Bearer sk-YOUR_KEY", "Content-Type": "application/json"}
BODY = {"model": "<model>", "messages": [{"role": "user", "content": "你好"}]}

# 非流式
resp = requests.post(API, headers=HEADERS, json=BODY)
print(resp.json()["choices"][0]["message"]["content"])

# 流式（SSE）
with requests.post(API, headers=HEADERS, json={**BODY, "stream": True}, stream=True) as r:
    for line in r.iter_lines():
        if not line or not line.startswith(b"data: "):
            continue
        data = line[6:].decode()
        if data == "[DONE]":
            break
        delta = json.loads(data)["choices"][0]["delta"].get("content")
        if delta:
            print(delta, end="", flush=True)`,
    node: `// 非流式
const res = await fetch("${API_HOST}/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: "Bearer sk-YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "<model>", messages: [{ role: "user", content: "你好" }] }),
});
const data = await res.json();
console.log(data.choices[0].message.content);

// 流式（SSE）
const stream = await fetch("${API_HOST}/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: "Bearer sk-YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "<model>", messages: [{ role: "user", content: "你好" }], stream: true }),
});
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const delta = JSON.parse(payload).choices[0].delta.content;
    if (delta) process.stdout.write(delta);
  }
}`,
  },
  agent: {
    curl: `# 非流式
curl ${API_HOST}/v1/agents/<agentId>/chat/completions \\
  -H "Authorization: Bearer sk-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"..."}]}'

# 流式（SSE）
curl -N ${API_HOST}/v1/agents/<agentId>/chat/completions \\
  -H "Authorization: Bearer sk-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"..."}],"stream":true}'`,
    python: `import requests, json

API = "${API_HOST}/v1/agents/<agentId>/chat/completions"
HEADERS = {"Authorization": "Bearer sk-YOUR_KEY", "Content-Type": "application/json"}
BODY = {"messages": [{"role": "user", "content": "..."}]}

# 非流式
resp = requests.post(API, headers=HEADERS, json=BODY)
print(resp.json()["choices"][0]["message"]["content"])

# 流式（SSE）
with requests.post(API, headers=HEADERS, json={**BODY, "stream": True}, stream=True) as r:
    for line in r.iter_lines():
        if not line or not line.startswith(b"data: "):
            continue
        data = line[6:].decode()
        if data == "[DONE]":
            break
        delta = json.loads(data)["choices"][0]["delta"].get("content")
        if delta:
            print(delta, end="", flush=True)`,
    node: `// 非流式
const res = await fetch("${API_HOST}/v1/agents/<agentId>/chat/completions", {
  method: "POST",
  headers: { Authorization: "Bearer sk-YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "..." }] }),
});
const data = await res.json();
console.log(data.choices[0].message.content);

// 流式（SSE）
const stream = await fetch("${API_HOST}/v1/agents/<agentId>/chat/completions", {
  method: "POST",
  headers: { Authorization: "Bearer sk-YOUR_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "..." }], stream: true }),
});
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const delta = JSON.parse(payload).choices[0].delta.content;
    if (delta) process.stdout.write(delta);
  }
}`,
  },
};

const PROTOCOL_TABS: { key: Protocol; label: string }[] = [
  { key: 'maas', label: 'LLM MaaS' },
  { key: 'agent', label: 'Agent AaaS' },
];
const LANG_TABS: { key: Lang; label: string }[] = [
  { key: 'curl', label: 'cURL' },
  { key: 'python', label: 'Python' },
  { key: 'node', label: 'Node.js' },
];

function pill(on: boolean): string {
  return `rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
    on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
  }`;
}

/** 接入示例：协议 Tab × 语言 Tab，六段可复制代码。 */
function CodeSamples() {
  const [protocol, setProtocol] = useState<Protocol>('maas');
  const [lang, setLang] = useState<Lang>('curl');
  const code = SAMPLES[protocol][lang];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5">
          <FileText className="w-4 h-4" /> 接入示例
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px]">
            {PROTOCOL_TABS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setProtocol(p.key)}
                className={pill(protocol === p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px]">
            {LANG_TABS.map((l) => (
              <button
                key={l.key}
                type="button"
                onClick={() => setLang(l.key)}
                className={pill(lang === l.key)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <Button variant="outline" size="sm" onClick={copy} className="absolute right-2 top-2">
            <Copy className="size-4" /> 复制
          </Button>
          <pre className="text-xs font-mono bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 pt-12 overflow-x-auto whitespace-pre">
            {code}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

/** 用原生 fetch 消费后端 SSE（OpenAI chunk 格式），逐块回调 delta 文本。 */
async function streamSse(path: string, body: unknown, onDelta: (text: string) => void): Promise<void> {
  const res = await fetch(withBasePath(path), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let dataStr = '';
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) dataStr = line.slice(5).trim();
      }
      if (!dataStr || dataStr === '[DONE]') continue;
      let evt: { error?: { message?: string }; choices?: { delta?: { content?: string } }[] };
      try {
        evt = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (evt.error) throw new Error(evt.error.message || 'stream error');
      const delta = evt.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) onDelta(delta);
    }
  }
}

/** 在线调试 Playground：LLM / Agent 两个 Tab，支持流式/非流式。 */
function DebugPlayground() {
  const [tab, setTab] = useState<'llm' | 'agent'>('llm');

  const [model, setModel] = useState('');
  const [system, setSystem] = useState('');
  const [llmMsg, setLlmMsg] = useState('');
  const [llmStream, setLlmStream] = useState(true);
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('');

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState('');
  const [agentMsg, setAgentMsg] = useState('');
  const [agentStream, setAgentStream] = useState(true);

  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState('');
  const [usage, setUsage] = useState<{ prompt_tokens?: number; completion_tokens?: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ defaultModel: string }>('/api/open-platform/debug/meta')
      .then((r) => setModel(r.defaultModel || ''))
      .catch(() => {});
    api.get<{ agents: AgentOption[] }>('/api/paas/agents')
      .then((r) => setAgents((r.agents || []).filter((a) => a.enabled)))
      .catch(() => {});
  }, []);

  const resetOutput = () => {
    setOutput('');
    setUsage(null);
    setError('');
  };

  const runLlm = async () => {
    if (!llmMsg.trim()) {
      setError('请输入消息');
      return;
    }
    resetOutput();
    setRunning(true);
    const messages: { role: string; content: string }[] = [];
    if (system.trim()) messages.push({ role: 'system', content: system.trim() });
    messages.push({ role: 'user', content: llmMsg.trim() });
    const body: Record<string, unknown> = { messages, stream: llmStream };
    if (model.trim()) body.model = model.trim();
    if (temperature.trim() && !isNaN(Number(temperature))) body.temperature = Number(temperature);
    if (maxTokens.trim() && !isNaN(Number(maxTokens))) body.max_tokens = Number(maxTokens);
    try {
      if (llmStream) {
        let acc = '';
        await streamSse('/api/open-platform/debug/chat', body, (t) => {
          acc += t;
          setOutput(acc);
        });
      } else {
        const r = await api.post<{ choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>(
          '/api/open-platform/debug/chat',
          body,
          120_000,
        );
        setOutput(r.choices?.[0]?.message?.content ?? '');
        setUsage(r.usage ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
    } finally {
      setRunning(false);
    }
  };

  const runAgent = async () => {
    if (!agentId) {
      setError('请选择 Agent');
      return;
    }
    if (!agentMsg.trim()) {
      setError('请输入消息');
      return;
    }
    resetOutput();
    setRunning(true);
    const body = { agentId, messages: [{ role: 'user', content: agentMsg.trim() }], stream: agentStream };
    try {
      if (agentStream) {
        let acc = '';
        await streamSse('/api/open-platform/debug/agent', body, (t) => {
          acc += t;
          setOutput(acc);
        });
      } else {
        const r = await api.post<{ choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>(
          '/api/open-platform/debug/agent',
          body,
          120_000,
        );
        setOutput(r.choices?.[0]?.message?.content ?? '');
        setUsage(r.usage ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5">
          <FlaskConical className="w-4 h-4" /> 在线调试
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'llm' | 'agent')}>
          <TabsList>
            <TabsTrigger value="llm">
              <Sparkles className="size-3.5" /> LLM
            </TabsTrigger>
            <TabsTrigger value="agent">
              <Bot className="size-3.5" /> Agent
            </TabsTrigger>
          </TabsList>

          <TabsContent value="llm" className="space-y-3 mt-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label className="mb-1">模型 model</Label>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="如 deepseek-v4-pro"
                  disabled={running}
                />
              </div>
              <div>
                <Label className="mb-1">temperature（可选）</Label>
                <Input
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  placeholder="如 0.7"
                  disabled={running}
                />
              </div>
              <div>
                <Label className="mb-1">max_tokens（可选）</Label>
                <Input
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder="如 1024"
                  disabled={running}
                />
              </div>
            </div>
            <div>
              <Label className="mb-1">System prompt（可选）</Label>
              <Textarea
                value={system}
                onChange={(e) => setSystem(e.target.value)}
                placeholder="设定助手角色…"
                rows={2}
                disabled={running}
              />
            </div>
            <div>
              <Label className="mb-1">
                User message <span className="text-error">*</span>
              </Label>
              <Textarea
                value={llmMsg}
                onChange={(e) => setLlmMsg(e.target.value)}
                placeholder="输入要发送给模型的消息…"
                rows={3}
                disabled={running}
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Switch checked={llmStream} onCheckedChange={setLlmStream} disabled={running} />
                流式输出
              </label>
              <Button onClick={runLlm} disabled={running} className="ml-auto">
                {running ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} 发送
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="agent" className="space-y-3 mt-3">
            <div>
              <Label className="mb-1">
                Agent <span className="text-error">*</span>
              </Label>
              <Select value={agentId} onValueChange={setAgentId} disabled={running}>
                <SelectTrigger>
                  <SelectValue placeholder="选择要调试的 Agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">暂无可用 Agent</div>
                  ) : (
                    agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1">
                User message <span className="text-error">*</span>
              </Label>
              <Textarea
                value={agentMsg}
                onChange={(e) => setAgentMsg(e.target.value)}
                placeholder="输入要发送给 Agent 的消息…"
                rows={4}
                disabled={running}
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Switch checked={agentStream} onCheckedChange={setAgentStream} disabled={running} />
                流式输出
              </label>
              <Button onClick={runAgent} disabled={running} className="ml-auto">
                {running ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} 发送
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        {error && (
          <div className="mt-3 rounded-lg border border-border bg-zinc-50 dark:bg-zinc-900 p-3 text-sm text-error">
            {error}
          </div>
        )}
        {running && !output && (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 执行中，请稍候…
          </div>
        )}
        {output && (
          <div className="mt-3 rounded-lg border border-border bg-zinc-50 dark:bg-zinc-900 p-3">
            <div className="text-xs text-muted-foreground mb-1 flex items-center justify-between">
              <span>响应</span>
              {usage && (
                <span>
                  tokens：入 {usage.prompt_tokens ?? 0} / 出 {usage.completion_tokens ?? 0}
                </span>
              )}
            </div>
            <div className="text-sm whitespace-pre-wrap break-words">{output}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function OpenPlatformPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [usage, setUsage] = useState<{ summary: UsageSummary; daily: UsageDaily[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState<string[]>(['maas', 'agent']);
  const [newExpires, setNewExpires] = useState('');
  const [creating, setCreating] = useState(false);

  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyItem | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [k, u] = await Promise.all([
        api.get<{ keys: ApiKeyItem[] }>('/api/open-platform/keys'),
        api.get<{ summary: UsageSummary; daily: UsageDaily[] }>('/api/open-platform/usage?days=7'),
      ]);
      setKeys(k.keys);
      setUsage(u);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggleScope = (s: string) => {
    setNewScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || name.length < 2) return toast.error('名称至少 2 个字符');
    if (newScopes.length === 0) return toast.error('至少选择一个 scope');
    setCreating(true);
    try {
      const res = await api.post<ApiKeyItem & { key: string }>('/api/open-platform/keys', {
        name,
        scopes: newScopes,
        expires_at: newExpires.trim() || null,
      });
      setCreatedKey({ name: res.name, key: res.key });
      setCreateOpen(false);
      setNewName('');
      setNewScopes(['maas', 'agent']);
      setNewExpires('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api.delete(`/api/open-platform/keys/${revokeTarget.id}`);
      toast.success('已吊销');
      setRevokeTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '吊销失败');
    } finally {
      setRevoking(false);
    }
  };

  const copyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  const chart = useMemo(() => usage?.daily ?? [], [usage]);

  return (
    <div className="flex flex-col h-full">
      <div className="sticky top-0 z-10 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-primary" />
              开放平台
            </h2>
            <span className="text-sm text-muted-foreground">Agent Service · API Key 与用量</span>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> 新建 Key
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
        {loading ? (
          <div className="h-full flex items-center justify-center text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin mr-2" /> 加载中...
          </div>
        ) : (
          <>
            {/* 用量概览 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <Activity className="w-4 h-4" /> 调用次数
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">{fmtNum(usage?.summary.requests ?? 0)}</div>
                  <div className="text-xs text-muted-foreground">近 7 天</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <Hash className="w-4 h-4" /> Token
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">
                    {fmtNum((usage?.summary.inputTokens ?? 0) + (usage?.summary.outputTokens ?? 0))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    入 {fmtNum(usage?.summary.inputTokens ?? 0)} / 出 {fmtNum(usage?.summary.outputTokens ?? 0)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <Coins className="w-4 h-4" /> 成本
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">${(usage?.summary.costUsd ?? 0).toFixed(4)}</div>
                  <div className="text-xs text-muted-foreground">近 7 天</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <KeyRound className="w-4 h-4" /> API Key
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold">{keys.length}</div>
                  <div className="text-xs text-muted-foreground">{isAdmin ? '全部' : '我的'}</div>
                </CardContent>
              </Card>
            </div>

            {/* 在线调试 */}
            <DebugPlayground />

            {/* 趋势 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">用量趋势</CardTitle>
              </CardHeader>
              <CardContent>
                {chart.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">暂无开放平台调用记录</p>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">每日调用次数</p>
                      <TrendChart daily={chart} metric="requests" />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">每日成本（USD）</p>
                      <TrendChart daily={chart} metric="costUsd" />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* API Key 列表 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-1.5">
                  <KeyRound className="w-4 h-4" /> API Key 管理
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {keys.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-6 text-center">
                    还没有 API Key，点击右上角「新建 Key」开始接入。
                  </p>
                ) : (
                  <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {keys.map((k) => (
                      <div key={k.id} className="px-6 py-3 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{k.name}</span>
                            {k.scopes.map((s) => (
                              <Badge key={s} variant="secondary" className="text-xs">
                                {SCOPE_LABELS[s] ?? s}
                              </Badge>
                            ))}
                          </div>
                          <div className="text-sm font-mono text-muted-foreground mt-0.5">
                            {k.masked_key}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            创建 {fmtTime(k.created_at)} · 最近使用 {fmtTime(k.last_used_at)}
                            {k.expires_at ? ` · 过期 ${fmtTime(k.expires_at)}` : ''}
                          </div>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(k)} className="text-error shrink-0">
                          <Trash2 className="size-4" /> 吊销
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 接入示例 */}
            <CodeSamples />
          </>
        )}
      </div>

      {/* 创建 Key 对话框 */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && !creating && setCreateOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建 API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="mb-1">
                名称 <span className="text-error">*</span>
              </Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如 my-app" disabled={creating} />
            </div>
            <div>
              <Label className="mb-1">权限范围（scope）</Label>
              <div className="flex gap-3">
                {['maas', 'agent'].map((s) => (
                  <label key={s} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newScopes.includes(s)}
                      onChange={() => toggleScope(s)}
                      disabled={creating}
                      className="accent-teal-600"
                    />
                    {SCOPE_LABELS[s]}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label className="mb-1">过期时间（可选，留空永不过期）</Label>
              <Input
                type="datetime-local"
                value={newExpires}
                onChange={(e) => setNewExpires(e.target.value)}
                disabled={creating}
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="size-4 animate-spin" />} 创建
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 创建成功：展示完整 key（仅一次） */}
      <Dialog open={!!createdKey} onOpenChange={(v) => !v && setCreatedKey(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Key 创建成功</DialogTitle>
          </DialogHeader>
          {createdKey && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                请立即保存 <span className="font-medium text-foreground">{createdKey.name}</span> 的 API Key，
                完整密钥仅展示这一次。
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-zinc-50 dark:bg-zinc-900 p-3">
                <code className="flex-1 text-sm font-mono break-all">{createdKey.key}</code>
                <Button variant="outline" size="sm" onClick={() => copyKey(createdKey.key)}>
                  <Copy className="size-4" /> 复制
                </Button>
              </div>
            </div>
          )}
          <div className="flex justify-end pt-2">
            <Button onClick={() => setCreatedKey(null)}>我已保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 吊销确认 */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(v) => !v && !revoking && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>吊销 API Key？</AlertDialogTitle>
            <AlertDialogDescription>
              吊销后使用该 Key 调用 <code className="font-mono">/v1/*</code> 将立即返回 401，且不可恢复。
              {revokeTarget && <span className="block mt-1 font-medium text-foreground">{revokeTarget.name}（{revokeTarget.masked_key}）</span>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevoke} disabled={revoking} className="bg-error text-white hover:bg-error/90">
              {revoking && <Loader2 className="size-4 animate-spin" />} 确认吊销
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
