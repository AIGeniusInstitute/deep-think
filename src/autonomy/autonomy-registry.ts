// Autonomy capability registry — boot-time registration of the 7 capabilities
// and live last_event_at updates.
//
// On boot, ensure each capability has a row in autonomy_capabilities. The
// registry does NOT emit events (that would loop) — it only records. The bus
// calls touchCapability via setAutonomyRegistryTouch to avoid a circular import.
//
// See docs/tech_solution/autonomy-system/SOLUTION.md §2.1.

import { getDb } from '../db.js';
import {
  ALL_CAPABILITIES,
  CAPABILITY_DOMAINS,
  type Capability,
  type CapabilityStatusRow,
} from './autonomy-types.js';
import { setAutonomyRegistryTouch } from './autonomy-bus.js';
import { logger } from '../logger.js';

let booted = false;

function nowMs(): number {
  return Date.now();
}

function rowToStatus(row: any): CapabilityStatusRow {
  return {
    capability: row.capability,
    domain: row.domain,
    status: row.status,
    last_event_at: row.last_event_at ?? null,
    metrics_summary_json: row.metrics_summary_json ?? null,
    updated_at: row.updated_at,
  };
}

/**
 * Idempotent boot: register all 7 capabilities, wire the bus→registry touch.
 * Safe to call multiple times (only wires once; rows are upserted).
 */
export function bootAutonomyRegistry(): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO autonomy_capabilities (capability, domain, status, last_event_at, metrics_summary_json, updated_at)
    VALUES (?, ?, 'active', NULL, NULL, ?)
    ON CONFLICT(capability) DO UPDATE SET
      domain = excluded.domain
  `);
  const tx = db.transaction(() => {
    for (const cap of ALL_CAPABILITIES) {
      insert.run(cap, CAPABILITY_DOMAINS[cap], nowMs());
    }
  });
  tx();

  if (!booted) {
    setAutonomyRegistryTouch(touchCapability);
    booted = true;
  }
  logger.info({ count: ALL_CAPABILITIES.length }, '[autonomy-registry] booted');
}

/** Touch a capability's last_event_at + status=active. Never throws. */
export function touchCapability(cap: Capability, ts: number): void {
  try {
    const db = getDb();
    db.prepare(
      `UPDATE autonomy_capabilities
       SET last_event_at = ?, status = 'active', updated_at = ?
       WHERE capability = ?`,
    ).run(ts, nowMs(), cap);
  } catch (err) {
    // Swallow — instrumentation must never break host flow.
    logger.warn({ err, cap }, '[autonomy-registry] touch failed — swallowed');
  }
}

/** Mark a capability degraded (e.g. supervisor heartbeat timeout). */
export function setCapabilityStatus(cap: Capability, status: 'active' | 'degraded' | 'failed'): void {
  const db = getDb();
  db.prepare(
    `UPDATE autonomy_capabilities SET status = ?, updated_at = ? WHERE capability = ?`,
  ).run(status, nowMs(), cap);
}

/** List all 7 capability statuses, always in canonical order. */
export function listCapabilities(): CapabilityStatusRow[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM autonomy_capabilities')
    .all() as any[];
  const byCap = new Map(rows.map((r) => [r.capability as Capability, r]));
  // Preserve canonical order; missing rows → synthesized degraded placeholder.
  return ALL_CAPABILITIES.map((cap) => {
    const r = byCap.get(cap);
    if (r) return rowToStatus(r);
    return {
      capability: cap,
      domain: CAPABILITY_DOMAINS[cap],
      status: 'degraded' as const,
      last_event_at: null,
      metrics_summary_json: null,
      updated_at: 0,
    };
  });
}

/** Test-only: reset boot guard. */
export function __resetAutonomyRegistryForTest(): void {
  booted = false;
}
