/**
 * Node palette — draggable node-type tiles. Drag a tile onto the canvas to
 * create a node of that type (WorkflowEditorCanvas.onDrop reads the type from
 * dataTransfer). Colors mirror the canvas via NODE_TYPE_COLORS.
 */
import { PALETTE_TYPES, NODE_TYPE_COLORS, NODE_TYPE_LABEL_ZH } from './workflow-constants';

export function NodePalette() {
  const onDragStart = (e: React.DragEvent, type: string) => {
    e.dataTransfer.setData('application/workflow-node', type);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="w-[140px] flex-shrink-0 border-r border-border p-2 overflow-y-auto">
      <div className="text-[10px] uppercase text-muted-foreground px-1 mb-2">节点类型</div>
      <div className="space-y-1.5">
        {PALETTE_TYPES.map((type) => {
          const color = NODE_TYPE_COLORS[type] ?? '#64748b';
          const label = NODE_TYPE_LABEL_ZH[type] ?? type;
          return (
            <div
              key={type}
              draggable
              onDragStart={(e) => onDragStart(e, type)}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-border bg-background hover:bg-muted cursor-grab active:cursor-grabbing text-xs select-none"
              title={`拖拽到画布添加 ${label} 节点`}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="truncate">{label}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 text-[10px] text-muted-foreground/70 px-1 leading-relaxed">
        提示：拖拽到画布；从节点边缘拉线连接；Delete 删除选中。
      </div>
    </div>
  );
}
