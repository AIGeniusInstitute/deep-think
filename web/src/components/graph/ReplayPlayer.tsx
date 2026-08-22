/**
 * ReplayPlayer — history replay scrubber (PRD AC9).
 *
 * Loads the run timeline + definition, then lets the user scrub through
 * execution time. At each timestamp T, each node's status is derived from
 * its timeline events (pending → running → completed/failed). Renders a
 * compact SVG canvas (nodes positioned by layoutDag, definition edges as
 * lines) — intentionally lightweight, no React Flow dependency here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGraphStore } from '../../stores/graph';
import { layoutDag } from './dagreLayout';

const STATUS_FILL: Record<string, string> = {
  pending: '#e2e8f0',
  running: '#f59e0b',
  completed: '#10b981',
  failed: '#ef4444',
  paused: '#eab308',
  skipped: '#cbd5e1',
};

const NODE_W = 140;
const NODE_H = 40;

export function ReplayPlayer({ runId }: { runId: string }) {
  const timeline = useGraphStore((s) => s.timeline);
  const definition = useGraphStore((s) => s.definition);
  const loadTimeline = useGraphStore((s) => s.loadTimeline);
  const loadDefinition = useGraphStore((s) => s.loadDefinition);
  const currentRun = useGraphStore((s) => s.currentRun);

  const [tMs, setTMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);

  // Load timeline + definition.
  useEffect(() => {
    void loadTimeline(runId);
    if (currentRun && !definition) void loadDefinition(currentRun.definition_id);
  }, [runId, loadTimeline, loadDefinition, currentRun, definition]);

  const { minT, maxT, span } = useMemo(() => {
    const valid = timeline.filter((t) => t.startedAt);
    if (valid.length === 0) return { minT: 0, maxT: 0, span: 1 };
    const starts = valid.map((t) => new Date(t.startedAt!).getTime());
    const ends = valid.map((t) =>
      t.endedAt ? new Date(t.endedAt).getTime() : new Date(t.startedAt!).getTime(),
    );
    const lo = Math.min(...starts);
    const hi = Math.max(...ends);
    return { minT: lo, maxT: hi, span: Math.max(1, hi - lo) };
  }, [timeline]);

  // Clamp scrub position when new data arrives.
  useEffect(() => {
    setTMs((cur) => (cur === 0 || cur > maxT ? minT : cur));
  }, [minT, maxT]);

  // Play/pause auto-advance.
  useEffect(() => {
    if (!playing) return;
    const step = Math.max(50, span / 120); // ~120 frames across the span
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setTMs((cur) => {
        const next = cur + step * (dt / 16);
        if (next >= maxT) {
          setPlaying(false);
          return maxT;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, span, maxT]);

  const positions = useMemo(() => {
    const nodes = (definition?.nodes ?? timeline.map((t) => ({ id: t.nodeId }))).map(
      (n) => ({ id: n.id }),
    );
    const edges = (definition?.edges ?? []).map((e) => ({ from: e.from, to: e.to }));
    return layoutDag(nodes, edges);
  }, [definition, timeline]);

  // Status of a node at time T (ms absolute).
  const statusAt = (nodeId: string): string => {
    const items = timeline.filter((t) => t.nodeId === nodeId && t.startedAt);
    if (items.length === 0) return 'pending';
    const start = new Date(items[0].startedAt!).getTime();
    if (tMs < start) return 'pending';
    const ended = items.find((t) => t.endedAt);
    if (ended && tMs >= new Date(ended.endedAt!).getTime()) return ended.status;
    return 'running';
  };

  if (timeline.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        暂无回放数据
      </div>
    );
  }

  // SVG viewBox bounds from layout.
  const xs = [...positions.values()].map((p) => p.x);
  const ys = [...positions.values()].map((p) => p.y);
  const vw = (Math.max(0, ...xs) ?? 0) + NODE_W + 24;
  const vh = (Math.max(0, ...ys) ?? 0) + NODE_H + 24;

  return (
    <div className="flex flex-col h-full min-h-0 p-3">
      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={() => {
            if (tMs >= maxT) setTMs(minT);
            setPlaying((p) => !p);
          }}
          className="px-3 py-1 text-xs rounded border border-border hover:bg-muted"
        >
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <input
          type="range"
          min={minT}
          max={maxT}
          value={tMs}
          onChange={(e) => {
            setPlaying(false);
            setTMs(Number(e.target.value));
          }}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground font-mono w-28 text-right">
          {((tMs - minT) / 1000).toFixed(1)}s / {(span / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <svg viewBox={`0 0 ${vw} ${vh}`} className="w-full" style={{ minWidth: 500 }}>
          {(definition?.edges ?? []).map((e) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return null;
            return (
              <line
                key={e.id}
                x1={a.x + NODE_W}
                y1={a.y + NODE_H / 2}
                x2={b.x}
                y2={b.y + NODE_H / 2}
                stroke="#cbd5e1"
                strokeWidth={1.5}
              />
            );
          })}
          {[...positions.entries()].map(([id, p]) => {
            const st = statusAt(id);
            const def = definition?.nodes.find((n) => n.id === id);
            return (
              <g key={id}>
                <rect
                  x={p.x}
                  y={p.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill={STATUS_FILL[st] ?? '#e2e8f0'}
                  stroke="#475569"
                  strokeWidth={1}
                />
                <text
                  x={p.x + 8}
                  y={p.y + 16}
                  style={{ fontSize: 10, fill: '#334155' }}
                >
                  {def?.type ?? 'node'}
                </text>
                <text
                  x={p.x + 8}
                  y={p.y + 30}
                  style={{ fontSize: 11, fill: '#0f172a', fontWeight: 600 }}
                >
                  {(def?.title ?? id).slice(0, 14)}
                </text>
                <text
                  x={p.x + 8}
                  y={p.y + NODE_H - 6}
                  style={{ fontSize: 9, fill: '#475569' }}
                >
                  {st}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
