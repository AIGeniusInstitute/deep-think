/**
 * GanttView — per-node execution timeline (PRD AC8).
 *
 * Fetches GET /api/graph/runs/:id/timeline and renders horizontal bars
 * scaled to the run's [start, end] window. Color encodes node status.
 * Pure SVG bars (no recharts) — a Gantt is simplest as positioned rects.
 */
import { useEffect, useMemo } from 'react';
import { useGraphStore, type GraphTimelineItem } from '../../stores/graph';

const STATUS_FILL: Record<string, string> = {
  running: '#f59e0b',
  completed: '#10b981',
  failed: '#ef4444',
  paused: '#eab308',
  pending: '#94a3b8',
  skipped: '#cbd5e1',
  cancelled: '#94a3b8',
};

const ROW_H = 26;

export function GanttView({ runId }: { runId: string }) {
  const timeline = useGraphStore((s) => s.timeline);
  const loadTimeline = useGraphStore((s) => s.loadTimeline);

  useEffect(() => {
    void loadTimeline(runId);
    // Refresh once a second while the run is live (timeline grows).
    const t = setInterval(() => void loadTimeline(runId), 5000);
    return () => clearInterval(t);
  }, [runId, loadTimeline]);

  const { rows, minT, maxT, span } = useMemo(() => {
    const valid = timeline.filter(
      (t): t is GraphTimelineItem & { startedAt: string } => !!t.startedAt,
    );
    if (valid.length === 0) {
      return { rows: [], minT: 0, maxT: 0, span: 1 };
    }
    const starts = valid.map((t) => new Date(t.startedAt).getTime());
    const ends = valid.map((t) =>
      t.endedAt ? new Date(t.endedAt).getTime() : Date.now(),
    );
    const minT = Math.min(...starts);
    const maxT = Math.max(...ends);
    const span = Math.max(1, maxT - minT);
    // Sort by start time for a clean top-down timeline.
    const rows = [...valid].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    );
    return { rows, minT, maxT, span };
  }, [timeline]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        暂无时间线数据
      </div>
    );
  }

  const W = 1000; // virtual width; scaled via viewBox
  const labelW = 180;
  const barW = W - labelW - 24;

  return (
    <div className="flex flex-col h-full min-h-0 p-3 overflow-auto">
      <div className="text-xs text-muted-foreground mb-2">
        时间窗口：{new Date(minT).toLocaleTimeString()} →{' '}
        {new Date(maxT).toLocaleTimeString()} · {rows.length} 节点
      </div>
      <svg
        viewBox={`0 0 ${W} ${rows.length * ROW_H + 24}`}
        className="w-full"
        style={{ minWidth: 600 }}
      >
        {rows.map((item, i) => {
          const s = new Date(item.startedAt).getTime();
          const e = item.endedAt ? new Date(item.endedAt).getTime() : Date.now();
          const x = labelW + ((s - minT) / span) * barW;
          const w = Math.max(2, ((e - s) / span) * barW);
          const y = i * ROW_H + 4;
          const fill = STATUS_FILL[item.status] ?? '#94a3b8';
          const durMs = e - s;
          return (
            <g key={item.nodeId}>
              <text
                x={8}
                y={y + 14}
                className="fill-slate-700"
                style={{ fontSize: 11 }}
              >
                {item.title?.slice(0, 16) ?? item.nodeId}
              </text>
              <rect
                x={x}
                y={y}
                width={w}
                height={18}
                rx={3}
                fill={fill}
                opacity={0.85}
              />
              <text
                x={x + 4}
                y={y + 13}
                style={{ fontSize: 10, fill: '#fff' }}
              >
                {(durMs / 1000).toFixed(1)}s · {(item.tokens / 1000).toFixed(1)}k
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
