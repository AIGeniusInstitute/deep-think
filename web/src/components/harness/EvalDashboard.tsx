/**
 * EvalDashboard — evaluation dashboard tab for the Self-Evolving Harness.
 *
 * Aggregates harness eval runs across versions to surface Agent progress /
 * regression:
 *   - Per-version pass-rate trend (recharts LineChart)
 *   - Latest vs previous-version delta (improved / regressed / neutral)
 *   - Per-case pass/fail table (the failing cases are the regression signal)
 *
 * Data source: GET /api/harness/eval-runs (no version filter → all runs).
 * The store's getEvalRuns() maps that. We pull once on mount + on refresh.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import { useHarnessStore, type HarnessEvalRun } from '../../stores/harness';

const VERDICT_COLORS: Record<string, string> = {
  improved: '#16a34a',
  regressed: '#ef4444',
  neutral: '#a3a3a3',
  inconclusive: '#eab308',
};

interface VersionPoint {
  versionId: string;
  label: string;
  total: number;
  passed: number;
  passRate: number; // 0..1
  verdict: 'improved' | 'regressed' | 'neutral' | 'inconclusive';
}

export function EvalDashboard() {
  const getEvalRuns = useHarnessStore((s: { getEvalRuns: (versionId?: string) => Promise<HarnessEvalRun[]> }) => s.getEvalRuns);
  const [runs, setRuns] = useState<HarnessEvalRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getEvalRuns();
      setRuns(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Group completed runs by version, compute pass-rate, then order versions by
  // started_at ascending so the trend reads left→right chronologically.
  const points: VersionPoint[] = useMemo(() => {
    const byVersion = new Map<string, HarnessEvalRun[]>();
    for (const r of runs) {
      if (r.status !== 'completed') continue;
      const arr = byVersion.get(r.version_id) ?? [];
      arr.push(r);
      byVersion.set(r.version_id, arr);
    }
    const raw = [...byVersion.entries()].map(([versionId, arr]) => {
      const passed = arr.filter((r) => r.pass === 1).length;
      const total = arr.length;
      return {
        versionId,
        label: versionId.slice(0, 8),
        total,
        passed,
        passRate: total === 0 ? 0 : passed / total,
        firstStarted: arr.reduce((min, r) => (r.started_at < min ? r.started_at : min), arr[0].started_at),
      };
    });
    raw.sort((a, b) => (a.firstStarted < b.firstStarted ? -1 : 1));
    // Verdict: compare each version's passRate to the previous.
    return raw.map((p, i) => {
      let verdict: VersionPoint['verdict'] = 'inconclusive';
      if (i > 0) {
        const prev = raw[i - 1].passRate;
        const delta = p.passRate - prev;
        if (delta > 0.001) verdict = 'improved';
        else if (delta < -0.001) verdict = 'regressed';
        else verdict = 'neutral';
      }
      return { ...p, verdict };
    });
  }, [runs]);

  const latest = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;

  // Per-case pass/fail across the latest version (regression drill-down).
  const latestCaseRows = useMemo(() => {
    if (!latest) return [];
    return runs
      .filter((r) => r.version_id === latest.versionId && r.status === 'completed')
      .sort((a, b) => a.case_id.localeCompare(b.case_id));
  }, [runs, latest]);

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">评测看板</h1>
          <p className="text-xs text-gray-500 mt-1">
            跨版本 pass-rate 趋势 · 回归检测 · 用例级证据
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="px-3 py-1.5 bg-teal-600 text-white rounded text-sm hover:bg-teal-700 disabled:opacity-50"
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 p-2 rounded">加载失败: {error}</div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard
          title="版本数"
          value={String(points.length)}
          hint="已评估 harness 版本"
        />
        <SummaryCard
          title="最新 pass-rate"
          value={latest ? `${(latest.passRate * 100).toFixed(1)}%` : '—'}
          hint={latest ? `${latest.passed}/${latest.total} 用例通过` : '无数据'}
        />
        <SummaryCard
          title="最新结论"
          value={latest ? verdictLabel(latest.verdict) : '—'}
          hint={prev ? `上一版本 ${(prev.passRate * 100).toFixed(1)}%` : '基线版本'}
          color={latest ? VERDICT_COLORS[latest.verdict] : undefined}
        />
      </div>

      {/* Trend chart */}
      <div className="border rounded p-3 bg-white">
        <div className="text-sm font-medium mb-2">Pass-Rate 趋势（按版本）</div>
        {points.length === 0 ? (
          <div className="text-gray-400 text-xs h-40 flex items-center justify-center">
            暂无完成的评测运行。在左侧版本面板点击「运行评测」生成数据。
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(v) => `${Math.round(v * 100)}%`}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                formatter={(v) => `${(Number(v) * 100).toFixed(1)}%`}
                labelFormatter={(_, p) => {
                  const pt = p?.[0]?.payload as VersionPoint | undefined;
                  return pt ? `版本 ${pt.label} · ${pt.passed}/${pt.total}` : '';
                }}
              />
              <Line
                type="monotone"
                dataKey="passRate"
                stroke="#0d9488"
                strokeWidth={2}
                dot={({ cx, cy, payload }) => (
                  <circle
                    key={payload.versionId}
                    cx={cx}
                    cy={cy}
                    r={4}
                    fill={VERDICT_COLORS[payload.verdict]}
                  />
                )}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Per-case table for latest version */}
      {latestCaseRows.length > 0 && (
        <div className="border rounded p-3 bg-white">
          <div className="text-sm font-medium mb-2">
            最新版本用例明细（{latest!.label}）
          </div>
          <div className="space-y-1">
            {latestCaseRows.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 text-xs py-1 border-b border-gray-100 last:border-0"
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor:
                      r.pass === 1 ? '#16a34a' : r.pass === 0 ? '#ef4444' : '#eab308',
                  }}
                />
                <code className="text-gray-600 flex-1 truncate">{r.case_id}</code>
                <span className="text-gray-400">
                  {r.score != null ? `${(r.score * 100).toFixed(0)}%` : '—'}
                </span>
                {r.error && (
                  <span className="text-red-500 truncate max-w-[200px]" title={r.error}>
                    {r.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pass/fail bar chart across versions */}
      {points.length > 0 && (
        <div className="border rounded p-3 bg-white">
          <div className="text-sm font-medium mb-2">通过 / 失败 用例数（按版本）</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={points}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="passed" name="通过" stackId="a" fill="#16a34a" />
              <Bar dataKey="failed" name="失败" stackId="a">
                {points.map((p) => (
                  <Cell key={p.versionId} fill={p.total - p.passed > 0 ? '#ef4444' : '#fca5a5'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  title,
  value,
  hint,
  color,
}: {
  title: string;
  value: string;
  hint: string;
  color?: string;
}) {
  return (
    <div className="border rounded p-3 bg-white">
      <div className="text-[10px] text-gray-500 uppercase">{title}</div>
      <div className="text-lg font-bold mt-1" style={{ color: color ?? undefined }}>
        {value}
      </div>
      <div className="text-[10px] text-gray-400 mt-0.5">{hint}</div>
    </div>
  );
}

function verdictLabel(v: VersionPoint['verdict']): string {
  return { improved: '↑ 改进', regressed: '↓ 回归', neutral: '→ 持平', inconclusive: '? 待定' }[v];
}
