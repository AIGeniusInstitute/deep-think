// Autonomy Layer — types.
//
// Seven capabilities covering the full autonomous agent loop:
// perception → cognition → decision → execution → learning → adaptation → monitoring.
// Each capability emits events on the autonomy bus; metrics are derived from events.
// See docs/prd/autonomy-system/PRD.md §3 and docs/tech_solution/autonomy-system/SOLUTION.md §3.

export type Capability =
  | 'perception'
  | 'cognition'
  | 'decision'
  | 'execution'
  | 'learning'
  | 'adaptation'
  | 'monitoring';

export const ALL_CAPABILITIES: Capability[] = [
  'perception',
  'cognition',
  'decision',
  'execution',
  'learning',
  'adaptation',
  'monitoring',
];

export const CAPABILITY_DOMAINS: Record<Capability, string> = {
  perception: 'environment-sensing',
  cognition: 'understanding-modeling',
  decision: 'planning-orchestration',
  execution: 'action-delivery',
  learning: 'self-improvement',
  adaptation: 'dynamic-adjustment',
  monitoring: 'self-maintenance',
};

export interface AutonomyEvent {
  /** Which capability this event belongs to. */
  capability: Capability;
  /** Coarse scope: a run_id, task_id, or 'system' for host-level. */
  domain: string;
  /** Event type, e.g. 'perception.active_trigger', 'execution.recovered'. */
  type: string;
  /** Free-form payload — must be JSON-serializable. */
  payload: Record<string, unknown>;
  /** Epoch ms. Caller passes Date.now() — never computed here (testability). */
  ts: number;
  /** Optional graph_run id for correlation. */
  runId?: string;
  /** Optional graph_run_id for trace correlation. */
  graphRunId?: string;
}

/**
 * Metric numerator/denominator increment descriptor. Metrics are stored as
 * raw (numerator, denominator) pairs so aggregation is a simple sum + ratio,
 * not a precomputed percentage that can't be re-windowed.
 */
export interface MetricIncrement {
  capability: Capability;
  metricName: string;
  numerator: number;
  denominator: number;
  runId?: string;
  graphRunId?: string;
  details?: Record<string, unknown>;
}

export interface CapabilityStatusRow {
  capability: Capability;
  domain: string;
  status: 'active' | 'degraded' | 'failed';
  last_event_at: number | null;
  metrics_summary_json: string | null;
  updated_at: number;
}

export interface MetricRatio {
  capability: Capability;
  metric_name: string;
  numerator: number;
  denominator: number;
  /** numerator/denominator, or null when denominator == 0 (avoid NaN). */
  ratio: number | null;
}

export type AutonomyListener = (event: AutonomyEvent) => void;
