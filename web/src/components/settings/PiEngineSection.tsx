import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug, Check, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { getErrorMessage } from './types';

interface PiProvider {
  provider: string;
  /** GET /api/config/pi 公开响应中不返回 apiKey，仅为本地编辑态存在 */
  apiKey?: string;
  baseURL: string;
  model: string;
  hasApiKey?: boolean;
}

interface PiConfig {
  enabled: boolean;
  binaryPath: string;
  cliScriptPath: string;
  workingDir: string;
  defaultProvider: string;
  defaultModel: string;
  thinkingLevel: string;
  providers: PiProvider[];
  updatedAt: string | null;
}

interface PiTestResult {
  ok: boolean;
  version?: string;
  error?: string;
}

const DEFAULT_CONFIG: PiConfig = {
  enabled: false,
  binaryPath: 'node',
  cliScriptPath: '',
  workingDir: '/workspace/group',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  thinkingLevel: 'off',
  providers: [],
  updatedAt: null,
};

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function PiEngineSection() {
  const [cfg, setCfg] = useState<PiConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<PiTestResult | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.get<PiConfig>('/api/config/pi');
      setCfg({ ...DEFAULT_CONFIG, ...data, providers: data.providers ?? [] });
    } catch (err) {
      toast.error(getErrorMessage(err, '加载 pi 配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      const data = await api.put<PiConfig>('/api/config/pi', cfg);
      setCfg({ ...DEFAULT_CONFIG, ...data, providers: data.providers ?? [] });
      toast.success('pi 配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<PiTestResult>('/api/config/pi/test', {});
      setTestResult(result);
      if (result.ok) {
        toast.success(`pi 可用${result.version ? `：${result.version}` : ''}`);
      } else {
        toast.error(`pi 不可用：${result.error ?? '未知错误'}`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '测试失败'));
    } finally {
      setTesting(false);
    }
  };

  const updateProvider = (idx: number, patch: Partial<PiProvider>): void => {
    setCfg((c) => ({
      ...c,
      providers: c.providers.map((p, i) => i === idx ? { ...p, ...patch } : p),
    }));
  };
  const addProvider = (): void => {
    setCfg((c) => ({
      ...c,
      providers: [...c.providers, { provider: '', apiKey: '', baseURL: '', model: '' }],
    }));
  };
  const removeProvider = (idx: number): void => {
    setCfg((c) => ({ ...c, providers: c.providers.filter((_, i) => i !== idx) }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> 加载中...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold mb-1">pi 引擎</h2>
        <p className="text-sm text-muted-foreground">
          配置 pi 作为 DeepThink 的 Agent 执行引擎。pi 通过
          <code className="mx-1 px-1 py-0.5 bg-muted rounded text-xs">pi --mode rpc</code>
          stdio JSONL 协议接入（长驻进程，专为进程集成设计），需预构建 pi dist 或安装 pi bin。
        </p>
      </div>

      <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
        <div>
          <Label className="text-base">启用 pi 引擎</Label>
          <p className="text-xs text-muted-foreground mt-1">
            开启后可在主对话顶部切换为 pi 引擎
          </p>
        </div>
        <Switch
          checked={cfg.enabled}
          onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="pi-binary">启动命令 (binaryPath)</Label>
        <Input
          id="pi-binary"
          value={cfg.binaryPath}
          onChange={(e) => setCfg({ ...cfg, binaryPath: e.target.value })}
          placeholder="node（默认）；若已安装 pi bin 可填 /usr/local/bin/pi"
        />
        <p className="text-xs text-muted-foreground">
          pi 是 Node 包（非独立二进制）。默认用 <code>node</code> 启动；若已 <code>npm i -g</code> 或构建独立二进制，可填 pi bin 绝对路径。
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="pi-cliscript">CLI 脚本路径 (cliScriptPath)</Label>
        <Input
          id="pi-cliscript"
          value={cfg.cliScriptPath}
          onChange={(e) => setCfg({ ...cfg, cliScriptPath: e.target.value })}
          placeholder="/home/me/pi/packages/coding-agent/dist/cli.js（构建产物）"
        />
        <p className="text-xs text-muted-foreground">
          pi <code>packages/coding-agent/dist/cli.js</code> 的绝对路径。需先 <code>cd ~/pi &&amp; npm run build</code>。留空表示 binaryPath 本身是 pi bin。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="pi-provider">默认 Provider</Label>
          <Input
            id="pi-provider"
            value={cfg.defaultProvider}
            onChange={(e) => setCfg({ ...cfg, defaultProvider: e.target.value })}
            placeholder="anthropic"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pi-model">默认 Model</Label>
          <Input
            id="pi-model"
            value={cfg.defaultModel}
            onChange={(e) => setCfg({ ...cfg, defaultModel: e.target.value })}
            placeholder="claude-sonnet-4-6"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="pi-thinking">Thinking 等级</Label>
        <select
          id="pi-thinking"
          value={cfg.thinkingLevel}
          onChange={(e) => setCfg({ ...cfg, thinkingLevel: e.target.value })}
          className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
        >
          {THINKING_LEVELS.map((lvl) => (
            <option key={lvl} value={lvl}>{lvl}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          pi 的 reasoning/thinking 等级（off 表示关闭）。
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="pi-working-dir">工作目录</Label>
        <Input
          id="pi-working-dir"
          value={cfg.workingDir}
          onChange={(e) => setCfg({ ...cfg, workingDir: e.target.value })}
          placeholder="/workspace/group"
        />
        <p className="text-xs text-muted-foreground">
          pi 子进程的 cwd（即 Agent 工作目录）。
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">LLM Provider 配置</Label>
            <p className="text-xs text-muted-foreground mt-1">
              引擎启动时按 provider 名注入对应环境变量（如 <code>ANTHROPIC_API_KEY</code>）；未覆盖的 provider 回退 <code>--api-key</code> CLI flag。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addProvider}>
            <Plus className="w-3.5 h-3.5 mr-1" /> 添加 Provider
          </Button>
        </div>
        {cfg.providers.length === 0 ? (
          <div className="text-xs text-muted-foreground p-3 rounded border border-dashed">
            尚未配置 Provider。点击「添加 Provider」开始。
          </div>
        ) : (
          <div className="space-y-3">
            {cfg.providers.map((p, i) => (
              <div key={i} className="border rounded p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Provider #{i + 1}{i === 0 ? ' (主)' : ''}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => removeProvider(i)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Provider</Label>
                    <Input
                      value={p.provider}
                      onChange={(e) => updateProvider(i, { provider: e.target.value })}
                      placeholder="anthropic"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Model</Label>
                    <Input
                      value={p.model}
                      onChange={(e) => updateProvider(i, { model: e.target.value })}
                      placeholder="claude-sonnet-4-6"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Base URL（可选，留空用内置端点）</Label>
                  <Input
                    value={p.baseURL}
                    onChange={(e) => updateProvider(i, { baseURL: e.target.value })}
                    placeholder="https://api.anthropic.com"
                  />
                </div>
                <div>
                  <Label className="text-xs">API Key</Label>
                  <Input
                    type="password"
                    value={p.apiKey ?? ''}
                    onChange={(e) => updateProvider(i, { apiKey: e.target.value })}
                    placeholder={p.hasApiKey ? '已保存（留空保留原值）' : 'sk-...'}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          保存配置
        </Button>
        <Button variant="outline" onClick={handleTest} disabled={testing}>
          {testing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plug className="w-4 h-4 mr-2" />}
          测试 pi
        </Button>
        {testResult ? (
          <span className={`text-sm flex items-center gap-1 ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
            {testResult.ok ? <Check className="w-3.5 h-3.5" /> : null}
            {testResult.ok ? `pi 可用${testResult.version ? ` · ${testResult.version}` : ''}` : `不可用 - ${testResult.error}`}
          </span>
        ) : null}
      </div>

      {cfg.updatedAt ? (
        <p className="text-xs text-muted-foreground">最后更新：{new Date(cfg.updatedAt).toLocaleString()}</p>
      ) : null}

      <div className="p-3 rounded-md bg-muted/40 text-xs text-muted-foreground">
        <p className="font-medium mb-1">说明</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>pi 以 RPC 模式（<code>pi --mode rpc</code>）接入，长驻 stdio JSONL，多 turn 通过 <code>prompt</code> 命令续聊</li>
          <li>切换到 pi 引擎后会开新会话（不重放历史）；pi session ID 持久化到 <code>sessions.pi_session_id</code></li>
          <li>每个 agent-runner 进程启动独立的 pi 子进程，独立 <code>PI_CODING_AGENT_DIR</code>（session 隔离）</li>
          <li>pi 引擎首版不桥接 DeepThink 内置 MCP 工具（send_message / schedule_task / memory_*）</li>
          <li>需先构建 pi：<code>cd ~/pi &amp;&amp; npm run build</code>，cliScriptPath 指向 <code>packages/coding-agent/dist/cli.js</code></li>
          <li>Node 版本需 ≥ 22.19.0</li>
        </ul>
      </div>
    </div>
  );
}
