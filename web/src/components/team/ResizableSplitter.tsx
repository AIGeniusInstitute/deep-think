/**
 * Horizontal resizable split layout for the TeamPage execution view
 * (left = Agent conversation, right = DAG). Custom drag handle — no new
 * dependency (Simplicity First). Keyboard accessible (Tab + Arrow keys).
 *
 * AC8.1: draggable splitter, min widths, stable on release.
 * AC8.3: keyboard a11y — handle focusable, Enter/Arrows adjust ratio.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface ResizableSplitterProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Initial left ratio (0–1). */
  initialLeftRatio?: number;
  minLeftPx?: number;
  minRightPx?: number;
}

export function ResizableSplitter({
  left,
  right,
  initialLeftRatio = 0.42,
  minLeftPx = 300,
  minRightPx = 360,
}: ResizableSplitterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(initialLeftRatio);
  const draggingRef = useRef(false);

  const clamp = useCallback(
    (r: number) => {
      if (!containerRef.current) return r;
      const w = containerRef.current.clientWidth;
      if (w === 0) return r;
      const minR = Math.min(minLeftPx / w, 0.8);
      const maxR = Math.max(1 - minRightPx / w, 0.2);
      return Math.min(Math.max(r, minR), maxR);
    },
    [minLeftPx, minRightPx],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const r = (e.clientX - rect.left) / rect.width;
      setRatio(clamp(r));
    },
    [clamp],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 0.03;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setRatio((r) => clamp(r - step));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setRatio((r) => clamp(r + step));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setRatio((r) => clamp(r + (e.key === 'Enter' ? 0.04 : 0)));
      }
    },
    [clamp],
  );

  const leftPct = `${(ratio * 100).toFixed(2)}%`;
  const rightFlex = '1 1 0%';

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full">
      <div style={{ width: leftPct, flexShrink: 0 }} className="min-h-0 min-w-0 border-r border-border">
        {left}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="拖拽调整左右面板宽度（左右箭头微调）"
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        className="w-1.5 flex-shrink-0 bg-border hover:bg-primary/40 focus:bg-primary/60 focus:outline-none focus:ring-2 focus:ring-ring cursor-col-resize transition-colors"
      />
      <div style={{ flex: rightFlex }} className="min-h-0 min-w-0">
        {right}
      </div>
    </div>
  );
}
