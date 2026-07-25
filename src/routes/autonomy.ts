// Autonomy Layer HTTP routes — capability status, metric aggregation, health,
// and signal injection. All admin-only (autonomy observability is host-scoped).
//
// See docs/tech_solution/autonomy-system/SOLUTION.md §5.

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, adminRoleMiddleware } from '../middleware/auth.js';
import {
  listCapabilities,
  setCapabilityStatus,
} from '../autonomy/autonomy-registry.js';
import {
  aggregateMetric,
  aggregateAllMetricsForCapability,
} from '../autonomy/autonomy-metrics.js';
import { getDb } from '../db.js';
import type { Capability } from '../autonomy/autonomy-types.js';

const autonomyRoutes = new Hono<{ Variables: Variables }>();

autonomyRoutes.use('*', authMiddleware);
autonomyRoutes.use('*', adminRoleMiddleware);

function parseCapability(v: unknown): Capability | null {
  const s = typeof v === 'string' ? v : null;
  if (!s) return null;
  const allowed = [
    'perception',
    'cognition',
    'decision',
    'execution',
    'learning',
    'adaptation',
    'monitoring',
  ];
  return (allowed as string[]).includes(s) ? (s as Capability) : null;
}

function parseTs(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** GET /api/autonomy/capabilities — 7 capability statuses (canonical order). */
autonomyRoutes.get('/capabilities', (c) => {
  return c.json({ capabilities: listCapabilities() });
});

/**
 * GET /api/autonomy/metrics?capability=&metric=&from=&to=
 * - Without metric: returns all metrics for the capability over the window.
 * - With metric: returns a single aggregated ratio.
 * - from/to default to [now-24h, now].
 */
autonomyRoutes.get('/metrics', (c) => {
  const cap = parseCapability(c.req.query('capability'));
  if (!cap) return c.json({ error: 'Invalid capability' }, 400);
  const now = Date.now();
  const from = parseTs(c.req.query('from'), now - 24 * 3600 * 1000);
  const to = parseTs(c.req.query('to'), now);
  const metric = c.req.query('metric');
  if (metric) {
    return c.json({ metrics: [aggregateMetric(cap, metric, from, to)] });
  }
  return c.json({ metrics: aggregateAllMetricsForCapability(cap, from, to) });
});

/** GET /api/autonomy/health — 7 capability statuses + key metric snapshots (24h). */
autonomyRoutes.get('/health', (c) => {
  const now = Date.now();
  const from = now - 24 * 3600 * 1000;
  const caps = listCapabilities();
  const summary = caps.map((cap) => ({
    capability: cap.capability,
    status: cap.status,
    last_event_at: cap.last_event_at,
    metrics: aggregateAllMetricsForCapability(cap.capability, from, now),
  }));
  return c.json({ ts: now, capabilities: summary });
});

/** POST /api/autonomy/signals — inject an adaptation signal (admin). */
autonomyRoutes.post('/signals', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid body' }, 400);
  }
  const signalType = typeof body.signal_type === 'string' ? body.signal_type : null;
  if (!signalType) return c.json({ error: 'signal_type required' }, 400);
  const payload = body.payload ?? null;
  const targetRunId = typeof body.target_run_id === 'string' ? body.target_run_id : null;
  const db = getDb();
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO autonomy_signals
        (signal_type, payload_json, target_run_id, status, created_at, applied_at)
       VALUES (?, ?, ?, 'pending', ?, NULL)`,
    )
    .run(
      signalType,
      payload ? JSON.stringify(payload).slice(0, 65536) : null,
      targetRunId,
      now,
    );
  return c.json({ id: info.lastInsertRowid, created_at: now });
});

/** PATCH /api/autonomy/capabilities/:capability — force a status (admin, ops). */
autonomyRoutes.patch('/capabilities/:capability', async (c) => {
  const cap = parseCapability(c.req.param('capability'));
  if (!cap) return c.json({ error: 'Invalid capability' }, 400);
  const body = await c.req.json().catch(() => null);
  const status =
    body?.status === 'active' || body?.status === 'degraded' || body?.status === 'failed'
      ? body.status
      : null;
  if (!status) return c.json({ error: 'Invalid status' }, 400);
  setCapabilityStatus(cap, status);
  return c.json({ capability: cap, status });
});

export default autonomyRoutes;
