/**
 * Lightweight DAG layered layout (Sugiyama-lite) — no external deps.
 *
 * Assigns each node a layer = longest path from any source, then positions
 * nodes column-by-column. Good enough for React Flow auto-layout of DSL v2
 * graphs (start → ... → end reads left-to-right). Cycles are ignored in
 * layering (graphs are DAGs by validation) so layout never hangs.
 *
 * See PRD §2.3.1 (topology auto-layout).
 */

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutNode {
  id: string;
}
export interface LayoutEdge {
  from: string;
  to: string;
}

const NODE_W = 168;
const NODE_H = 96;
const GAP_X = 64;
const GAP_Y = 48;

/**
 * Compute x/y for each node id. Nodes with no incoming edges are sources
 * (layer 0). Isolated nodes (no edges at all) also get layer 0.
 */
export function layoutDag(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Map<string, LayoutPoint> {
  const ids = new Set(nodes.map((n) => n.id));
  const succ = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  ids.forEach((id) => {
    succ.set(id, []);
    inDeg.set(id, 0);
  });
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    succ.get(e.from)!.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  // Kahn topological order (also detects cycles — remaining nodes get
  // layered by iterative relaxation below).
  const queue: string[] = [];
  inDeg.forEach((d, id) => {
    if (d === 0) queue.push(id);
  });
  const topo: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    topo.push(id);
    for (const t of succ.get(id) ?? []) {
      inDeg.set(t, (inDeg.get(t) ?? 1) - 1);
      if ((inDeg.get(t) ?? 0) <= 0) queue.push(t);
    }
  }
  // Append any cycle-locked nodes so layout still places them.
  for (const id of ids) if (!seen.has(id)) topo.push(id);

  // Layer = longest path from a source (BFS relaxation over topo order).
  const layer = new Map<string, number>();
  ids.forEach((id) => layer.set(id, 0));
  for (const id of topo) {
    const cur = layer.get(id) ?? 0;
    for (const t of succ.get(id) ?? []) {
      if ((layer.get(t) ?? 0) < cur + 1) layer.set(t, cur + 1);
    }
  }

  // Group by layer, preserve topo order within a layer for stability.
  const byLayer = new Map<number, string[]>();
  layer.forEach((l, id) => {
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(id);
  });
  // Order each layer by global topo index to reduce crossings heuristically.
  const topoIdx = new Map<string, number>();
  topo.forEach((id, i) => topoIdx.set(id, i));
  byLayer.forEach((arr) => arr.sort((a, b) => (topoIdx.get(a) ?? 0) - (topoIdx.get(b) ?? 0)));

  const pos = new Map<string, LayoutPoint>();
  byLayer.forEach((nodes, layer) => {
    nodes.forEach((id, i) => {
      pos.set(id, {
        x: layer * (NODE_W + GAP_X),
        y: i * (NODE_H + GAP_Y),
      });
    });
  });
  return pos;
}
