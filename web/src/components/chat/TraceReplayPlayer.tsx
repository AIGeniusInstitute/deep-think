/**
 * TraceReplayPlayer — offline replay of a chat's full execution trace.
 *
 * Consumes GET /api/groups/:jid/trace/timeline (coarse DAG nodes + atomic
 * steps merged by time). Renders a vertical timeline with play/pause + a
 * scrubber that auto-advances through steps, highlighting the current item
 * and scrolling it into view. Items expand to show detail; large offloaded
 * I/O (outputRef) can be fetched via /trace/steps/:spanId/io.
 *
 * Deliberately self-contained (no new deps): plain CSS + a range input +
 * the shared NODE_TYPE_COLORS/LABELS from DagView so colors/labels match
 * the live DAG view.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useChatStore, type TimelineItem } from '../../stores/chat';
import { api } from '../../api/client';
import { NODE_TYPE_COLORS, NODE_TYPE_LABELS } from './DagView';

interface Props {
  chatJid: string;
}

const ADVANCE_MS = 800;

export function TraceReplayPlayer({ chatJid }: Props) {
  const timeline = useChatStore((s) => s.traceTimeline[chatJid] ?? []);
  const loadTimeline = useChatStore((s) => s.loadTraceTimeline);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ioContent, setIoContent] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    void loadTimeline(chatJid).finally(() => setLoading(false));
  }, [chatJid, loadTimeline]);

  // Reset cursor when timeline changes (e.g. reload).
  useEffect(() => {
    setCursor(0);
    setPlaying(false);
  }, [chatJid]);

  // Auto-advance while playing.
  useEffect(() => {
    if (!playing || timeline.length === 0) return;
    if (cursor >= timeline.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setCursor((c) => Math.min(c + 1, timeline.length - 1)), ADVANCE_MS);
    return () => clearTimeout(t);
  }, [playing, cursor, timeline.length]);

  // Scroll current item into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [cursor]);

  const toggleExpand = useCallback((spanId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }, []);

  const fetchIo = useCallback(async (item: TimelineItem) => {
    if (!item.outputRef || !item.traceId) return;
    if (ioContent[item.spanId] !== undefined) return;
    try {
      const data = await api.get<{ content: string }>(
        `/api/groups/${encodeURIComponent(chatJid)}/trace/steps/${encodeURIComponent(item.spanId)}/io?traceId=${encodeURIComponent(item.traceId)}`,
      );
      setIoContent((prev) => ({ ...prev, [item.spanId]: data.content }));
    } catch {
      setIoContent((prev) => ({ ...prev, [item.spanId]: '(读取失败)' }));
    }
  }, [chatJid, ioContent]);

  if (loading) return <div className="p-3 text-sm text-gray-400">加载 trace 时间轴…</div>;

  if (timeline.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-400">
        该会话暂无 trace 数据。
        <br />
        <span className="text-xs">完成一轮对话后，原子执行步骤（thinking / tool / memory / llm_call …）会出现在这里。</span>
      </div>
    );
  }

  const cur = timeline[Math.min(cursor, timeline.length - 1)];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-gray-50">
        <button
          onClick={() => {
            if (cursor >= timeline.length - 1) setCursor(0);
            setPlaying((p) => !p);
          }}
          className="px-2.5 py-1 rounded bg-blue-600 text-white text-xs hover:bg-blue-700"
        >
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <input
          type="range"
          min={0}
          max={timeline.length - 1}
          value={cursor}
          onChange={(e) => setCursor(Number(e.target.value))}
          className="flex-1"
        />
        <span className="text-[11px] text-gray-500 tabular-nums w-20 text-right">
          {cursor + 1} / {timeline.length}
        </span>
      </div>

      {/* Current item summary */}
      <div className="px-3 py-1.5 border-b bg-white text-xs">
        <span
          className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
          style={{ backgroundColor: NODE_TYPE_COLORS[cur.nodeType] }}
        />
        <span className="font-medium text-gray-700">{NODE_TYPE_LABELS[cur.nodeType]}</span>
        <span className="text-gray-400 ml-2">{cur.title ?? ''}</span>
        <span className="text-gray-400 ml-2">{cur.status ?? ''}</span>
      </div>

      {/* Timeline list */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {timeline.map((item, idx) => {
          const isCur = idx === cursor;
          const isOpen = expanded.has(item.spanId);
          const color = NODE_TYPE_COLORS[item.nodeType];
          return (
            <div
              key={`${item.spanId}-${idx}`}
              data-idx={idx}
              onClick={() => {
                setCursor(idx);
                toggleExpand(item.spanId);
              }}
              className={`rounded border px-2 py-1.5 cursor-pointer transition-colors ${
                isCur ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-2 text-xs">
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="font-medium text-gray-700 shrink-0">
                  {NODE_TYPE_LABELS[item.nodeType]}
                </span>
                <span className="text-gray-500 truncate flex-1">{item.title ?? '—'}</span>
                <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                  {fmtTime(item.startedAt)}
                </span>
                <span className={`text-[10px] shrink-0 ${item.status === 'failed' ? 'text-red-500' : 'text-gray-400'}`}>
                  {item.kind === 'step' ? '原子' : '节点'}
                </span>
              </div>

              {isOpen && (
                <div className="mt-1.5 pl-4 text-[11px] text-gray-600 space-y-0.5">
                  <div><span className="text-gray-400">span:</span> {item.spanId}</div>
                  <div><span className="text-gray-400">trace:</span> {item.traceId ?? '—'}</div>
                  {item.parentSpanId && (
                    <div><span className="text-gray-400">parent:</span> {item.parentSpanId}</div>
                  )}
                  <div><span className="text-gray-400">status:</span> {item.status ?? '—'}</div>
                  {item.startedAt && (
                    <div><span className="text-gray-400">started:</span> {item.startedAt}</div>
                  )}
                  {item.endedAt && (
                    <div><span className="text-gray-400">ended:</span> {item.endedAt}</div>
                  )}
                  {item.outputRef && (
                    <div>
                      <span className="text-gray-400">大 I/O:</span>{' '}
                      <button
                        onClick={(e) => { e.stopPropagation(); void fetchIo(item); }}
                        className="text-blue-600 underline"
                      >
                        查看内容
                      </button>
                      {ioContent[item.spanId] !== undefined && (
                        <pre className="mt-1 max-h-40 overflow-auto bg-gray-50 p-1.5 rounded text-[10px] whitespace-pre-wrap break-all">
                          {ioContent[item.spanId]}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtTime(iso: string): string {
  if (!iso) return '';
  // Show HH:mm:ss — the timeline is ordered, time helps disambiguate.
  const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : iso.slice(-8);
}
