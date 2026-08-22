/**
 * Graph Engineering page — list of graph runs + detail view (GraphDagView).
 * Mirrors LoopsPage structure. P0: list + open detail + pause/cancel/resume.
 */
import { useEffect, useState } from 'react';
import { GraphDagView } from '../components/graph/GraphDagView';
import { GanttView } from '../components/graph/GanttView';
import { ReplayPlayer } from '../components/graph/ReplayPlayer';
import { useGraphStore } from '../stores/graph';

type DetailTab = 'dag' | 'gantt' | 'replay';

export function GraphPage() {
  const runs = useGraphStore((s) => s.runs);
  const fetchRuns = useGraphStore((s) => s.fetchRuns);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  const pauseRun = useGraphStore((s) => s.pauseRun);
  const resumeRun = useGraphStore((s) => s.resumeRun);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('dag');

  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  if (selectedId) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <button
            onClick={() => {
              setSelectedId(null);
              void fetchRuns();
            }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 返回列表
          </button>
          <div className="flex gap-1">
            {(['dag', 'gantt', 'replay'] as DetailTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-xs px-3 py-1 rounded ${
                  tab === t
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {t === 'dag' ? '执行图' : t === 'gantt' ? '甘特图' : '历史回放'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {tab === 'dag' && <GraphDagView runId={selectedId} />}
          {tab === 'gantt' && <GanttView runId={selectedId} />}
          {tab === 'replay' && <ReplayPlayer runId={selectedId} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="font-semibold text-foreground">Graph 执行</h2>
        <button
          onClick={() => void fetchRuns()}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          刷新
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {runs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            暂无图运行
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left px-4 py-2">定义</th>
                <th className="text-left px-4 py-2">状态</th>
                <th className="text-left px-4 py-2">当前节点</th>
                <th className="text-left px-4 py-2">Tokens</th>
                <th className="text-left px-4 py-2">成本</th>
                <th className="text-left px-4 py-2">开始</th>
                <th className="text-left px-4 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border hover:bg-muted/40 cursor-pointer"
                  onClick={() => setSelectedId(r.id)}
                >
                  <td className="px-4 py-2 font-mono text-xs">
                    {r.definition_id}@v{r.definition_version}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {r.current_node_id ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {r.total_input_tokens + r.total_output_tokens}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    ${r.total_cost_usd.toFixed(4)}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {new Date(r.started_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-1">
                      {(r.status === 'paused' || r.status === 'failed') && (
                        <button
                          onClick={() => void resumeRun(r.id)}
                          className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-emerald-50 text-emerald-600"
                        >
                          续跑
                        </button>
                      )}
                      {r.status === 'running' && (
                        <button
                          onClick={() => void pauseRun(r.id)}
                          className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-amber-50"
                        >
                          暂停
                        </button>
                      )}
                      {(r.status === 'running' || r.status === 'paused') && (
                        <button
                          onClick={() => void cancelRun(r.id)}
                          className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-red-50 text-red-600"
                        >
                          取消
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'completed'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'running'
        ? 'bg-amber-100 text-amber-700'
        : status === 'failed'
          ? 'bg-red-100 text-red-700'
          : status === 'paused'
            ? 'bg-yellow-100 text-yellow-700'
            : 'bg-slate-100 text-slate-600';
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded uppercase ${color}`}>
      {status}
    </span>
  );
}
