import { useState } from 'react';
import { useSandboxStore } from '../../stores/sandbox';
import { sandboxApi } from '../../api/sandbox';
import { SandboxExecutionList } from './SandboxExecutionList';

interface SandboxToolbarProps {
  sessionId: string | null;
}

export function SandboxToolbar({ sessionId }: SandboxToolbarProps) {
  const [language, setLanguage] = useState<'python' | 'node' | 'sh'>('python');
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [code, setCode] = useState("print('hello from sandbox')");
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [browserUrl, setBrowserUrl] = useState('https://example.com');
  const [showExecHistory, setShowExecHistory] = useState(false);
  const create = useSandboxStore((s) => s.create);
  const destroy = useSandboxStore((s) => s.destroy);
  const startBrowser = useSandboxStore((s) => s.startBrowser);

  const handleCreate = async () => {
    await create({ language, browserEnabled });
  };

  const handleDestroy = async () => {
    if (!sessionId) return;
    await destroy(sessionId);
  };

  const handleRun = async () => {
    if (!sessionId || !code.trim()) return;
    setBusy(true);
    setResult('');
    try {
      const r = await sandboxApi.execute(sessionId, { language, code });
      const lines: string[] = [];
      lines.push(`✓ status=${r.status}  exit=${r.exitCode}  duration=${r.durationMs}ms`);
      if (r.truncated) lines.push('⚠ stdout/stderr 已截断');
      if (r.stdout) lines.push('--- stdout ---\n' + r.stdout);
      if (r.stderr) lines.push('--- stderr ---\n' + r.stderr);
      setResult(lines.join('\n'));
    } catch (e: any) {
      setResult(`✗ 执行失败: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleNavigate = async () => {
    if (!sessionId || !browserUrl) return;
    try {
      const session = useSandboxStore.getState().sessions.find((s) => s.id === sessionId);
      if (!session?.browserEnabled) {
        alert('该沙箱未启用浏览器，请销毁后重新创建并勾选"启动浏览器"');
        return;
      }
      await startBrowser(sessionId, browserUrl);
    } catch (e: any) {
      setResult(`✗ 导航失败: ${e?.message ?? e}`);
    }
  };

  const handleScreenshot = async () => {
    if (!sessionId) return;
    try {
      const r = await sandboxApi.browserScreenshot(sessionId);
      if (r.screenshot) {
        window.open(r.screenshot, '_blank');
      } else {
        setResult('✗ 浏览器未启动');
      }
    } catch (e: any) {
      setResult(`✗ 截图失败: ${e?.message ?? e}`);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3 bg-white/5 border-b border-white/10 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-neutral-400">语言:</span>
        {(['python', 'node', 'sh'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLanguage(l)}
            className={`px-2 py-1 rounded text-xs ${
              language === l ? 'bg-brand-500 text-white' : 'bg-white/10 text-neutral-300'
            }`}
          >
            {l}
          </button>
        ))}
        <label className="flex items-center gap-1 text-neutral-400 text-xs ml-2">
          <input
            type="checkbox"
            checked={browserEnabled}
            onChange={(e) => setBrowserEnabled(e.target.checked)}
          />
          启动浏览器
        </label>
        <button
          onClick={handleCreate}
          className="px-3 py-1 rounded bg-brand-500 text-white text-xs hover:bg-brand-400"
        >
          新建沙箱
        </button>
        <button
          onClick={handleDestroy}
          disabled={!sessionId}
          className="px-3 py-1 rounded bg-red-500/80 text-white text-xs hover:bg-red-500 disabled:opacity-40"
        >
          销毁沙箱
        </button>
        <button
          onClick={() => setShowExecHistory(!showExecHistory)}
          disabled={!sessionId}
          className={`px-3 py-1 rounded text-xs disabled:opacity-40 ${
            showExecHistory ? 'bg-white/20 text-white' : 'bg-white/10 text-neutral-300 hover:bg-white/15'
          }`}
        >
          执行历史
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={4}
          className="bg-[#1a1b26] text-neutral-100 p-2 rounded font-mono text-xs border border-white/10"
          placeholder="输入要执行的代码"
        />
        <div className="flex flex-col gap-2">
          <button
            onClick={handleRun}
            disabled={!sessionId || busy}
            className="px-3 py-1 rounded bg-green-600 text-white text-xs hover:bg-green-500 disabled:opacity-40"
          >
            {busy ? '执行中...' : '执行代码'}
          </button>
          <div className="flex items-center gap-1">
            <input
              value={browserUrl}
              onChange={(e) => setBrowserUrl(e.target.value)}
              className="flex-1 bg-[#1a1b26] text-neutral-100 px-2 py-1 rounded text-xs border border-white/10"
              placeholder="https://"
            />
            <button
              onClick={handleNavigate}
              disabled={!sessionId}
              className="px-2 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-500 disabled:opacity-40"
            >
              导航
            </button>
          </div>
          <button
            onClick={handleScreenshot}
            disabled={!sessionId}
            className="px-3 py-1 rounded bg-purple-600 text-white text-xs hover:bg-purple-500 disabled:opacity-40"
          >
            截图
          </button>
        </div>
      </div>

      {result && (
        <pre className="bg-[#0f0f14] text-neutral-100 p-2 rounded text-xs overflow-auto max-h-48 border border-white/10">
          {result}
        </pre>
      )}

      {showExecHistory && sessionId && (
        <div className="h-64 border border-white/10 rounded overflow-hidden">
          <SandboxExecutionList sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}
