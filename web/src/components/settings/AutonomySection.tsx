// Autonomy Layer dashboard — 7-capability status + metric SVG trend.
// Polls GET /api/autonomy/health every 5s. Pure SVG (no Chart.js/D3).
// See docs/prd/autonomy-system/PRD.md §F5.3.

import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

interface CapHealth {
  capability: string;
  status: 'active' | 'degraded' | 'failed';
  last_event_at: number | null;
  metrics: { capability: string; metric_name: string; numerator: number; denominator: number; ratio: number | null }[];
}

interface HealthResponse {
  ts: number;
  capabilities: CapHealth[];
}

const CAP_LABELS: Record<string, string> = {
  perception: '自主感知',
  cognition: '自主认知',
  decision: '自主决策',
  execution: '自主执行',
  learning: '自主学习',
  adaptation: '自主适应',
  monitoring: '自主监控',
};

const STATUS_META = {
  active: { icon: CheckCircle2, color: '#16a34a', label: '活跃' },
  degraded: { icon: AlertTriangle, color: '#d97706', label: '降级' },
  failed: { icon: XCircle, color: '#dc2626', label: '故障' },
};

/** Mini SVG sparkline for a metric ratio (0..1). */
function Sparkline({ ratio }: { ratio: number | null }) {
  const pct = ratio === null ? 0 : Math.max(0, Math.min(1, ratio));
  const r = 18;
  const circ = 2 * Math.PI * r;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-label="metric">
      <circle cx="22" cy="22" r={r} fill="none" stroke="#e5e7eb" strokeWidth="4" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        stroke={ratio === null ? '#9ca3af' : pct >= 0.8 ? '#16a34a' : pct >= 0.5 ? '#d97706' : '#dc2626'}
        strokeWidth="4"
        strokeDasharray={`${circ * pct} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 22 22)"
      />
      <text x="22" y="26" textAnchor="middle" fontSize="10" fill="currentColor">
        {ratio === null ? '—' : `${Math.round(pct * 100)}%`}
      </text>
    </svg>
  );
}

export function AutonomySection() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/autonomy/health', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as HealthResponse;
        if (!cancelled) {
          setHealth(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
        无法加载自主性状态：{error}（需 admin 权限）
      </div>
    );
  }

  if (!health) {
    return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Activity className="w-4 h-4" />
        <span>7 大自主能力状态 + 关键指标（24h 窗口，5s 轮询）</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {health.capabilities.map((cap) => {
          const meta = STATUS_META[cap.status] ?? STATUS_META.active;
          const Icon = meta.icon;
          return (
            <div key={cap.capability} className="rounded-lg border p-3 bg-card">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4" style={{ color: meta.color }} />
                  <span className="font-medium text-sm">
                    {CAP_LABELS[cap.capability] ?? cap.capability}
                  </span>
                </div>
                <span className="text-xs px-2 py-0.5 rounded" style={{ color: meta.color, background: `${meta.color}1a` }}>
                  {meta.label}
                </span>
              </div>
              <div className="text-xs text-muted-foreground mb-2">
                {cap.last_event_at
                  ? `最近事件 ${new Date(cap.last_event_at).toLocaleTimeString()}`
                  : '无事件记录'}
              </div>
              <div className="flex flex-wrap gap-2">
                {cap.metrics.length === 0 && (
                  <span className="text-xs text-muted-foreground">暂无指标</span>
                )}
                {cap.metrics.map((m) => (
                  <div key={m.metric_name} className="flex items-center gap-1.5">
                    <Sparkline ratio={m.ratio} />
                    <div className="text-xs">
                      <div className="font-mono">{m.metric_name}</div>
                      <div className="text-muted-foreground">
                        {m.numerator}/{m.denominator}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
