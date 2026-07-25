// Autonomy event bus — in-process pub/sub for the 7 capabilities.
//
// Design:
// - Single EventEmitter instance (singleton). Subscribers register via
//   onAutonomyEvent; emitters call emitAutonomyEvent.
// - emit is wrapped in try/catch: a throwing subscriber MUST NOT break the
//   host control flow (Surgical Changes — instrumentation is side-effect only).
// - On emit, the bus also updates autonomy_capabilities.last_event_at via the
//   registry, so the capability panel reflects live activity even if no metric
//   subscriber is wired.
// - Validation: events missing required fields are rejected with a warn and
//   dropped (never throw).
//
// See docs/tech_solution/autonomy-system/SOLUTION.md §3.

import { EventEmitter } from 'events';
import type { AutonomyEvent, AutonomyListener, Capability } from './autonomy-types.js';
import { logger } from '../logger.js';

const bus = new EventEmitter();
bus.setMaxListeners(50); // multiple subscribers per capability (metrics, learning, heal)

let registryTouch: ((cap: Capability, ts: number) => void) | null = null;

/**
 * Inject the registry touch callback. Kept as a setter (not a direct import)
 * to avoid a circular module dependency: registry imports bus for boot
 * recovery setup, bus imports registry for last_event_at updates.
 */
export function setAutonomyRegistryTouch(fn: (cap: Capability, ts: number) => void): void {
  registryTouch = fn;
}

function isValidEvent(ev: Partial<AutonomyEvent>): ev is AutonomyEvent {
  return (
    typeof ev?.capability === 'string' &&
    typeof ev?.domain === 'string' &&
    typeof ev?.type === 'string' &&
    ev!.type.startsWith(ev!.capability + '.') &&
    typeof ev?.payload === 'object' &&
    ev!.payload !== null &&
    typeof ev?.ts === 'number'
  );
}

/**
 * Emit an autonomy event. Subscribers are notified; the registry's
 * last_event_at is touched. Never throws — failures are logged and swallowed.
 */
export function emitAutonomyEvent(ev: AutonomyEvent): void {
  if (!isValidEvent(ev)) {
    logger.warn(
      { event: ev },
      '[autonomy-bus] rejected invalid event (capability/type prefix/payload/ts missing)',
    );
    return;
  }
  try {
    bus.emit('event', ev);
  } catch (err) {
    logger.warn({ err, ev }, '[autonomy-bus] subscriber threw on emit — swallowed');
  }
  try {
    registryTouch?.(ev.capability, ev.ts);
  } catch (err) {
    logger.warn({ err, cap: ev.capability }, '[autonomy-bus] registry touch failed — swallowed');
  }
}

/** Subscribe to all autonomy events. Returns an unsubscribe function. */
export function onAutonomyEvent(listener: AutonomyListener): () => void {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

/** Test-only: clear all subscribers. Not for production paths. */
export function __resetAutonomyBusForTest(): void {
  bus.removeAllListeners('event');
  registryTouch = null;
}
