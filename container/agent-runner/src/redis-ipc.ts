/**
 * Redis IPC for Agent Runner — Distributed Mode
 *
 * When REDIS_URL is set and AGENT_RUNNER_MODE=distributed:
 *   - Task input received via Redis pub/sub (replaces stdin)
 *   - IPC input messages via Redis (replaces file-system sentinel/watch)
 *   - IPC output messages via Redis (replaces file-system writeIpcFile)
 *
 * When REDIS_URL is not set: all functions are no-ops, agent-runner
 * falls back to the file-system IPC path (single-pod child-process mode).
 */

const REDIS_URL = process.env.REDIS_URL || '';
const AGENT_RUNNER_MODE = process.env.AGENT_RUNNER_MODE || '';

export const distributedMode = !!REDIS_URL && AGENT_RUNNER_MODE === 'distributed';

let _pub: any = null;
let _sub: any = null;
let _connected = false;

const TASK_QUEUE_CHANNEL = 'deepthink:agent-tasks';
const IPC_INPUT_PREFIX = 'deepthink:ipc:';
const IPC_OUTPUT_PREFIX = 'deepthink:ipc-out:';
const IPC_TASK_PREFIX = 'deepthink:ipc-task:';

/** Initialize Redis connections. Call once at startup if distributedMode. */
export async function initRedisIpc(): Promise<void> {
  if (!distributedMode) return;
  try {
    const { createClient } = await import('redis');
    _pub = createClient({ url: REDIS_URL });
    _sub = createClient({ url: REDIS_URL });
    _pub.on('error', () => {});
    _sub.on('error', () => {});
    await _pub.connect();
    await _sub.connect();
    _connected = true;
    // Worker registration: signal that this agent-runner is ready for tasks
    await _pub.sAdd('deepthink:agent-runners:pool', process.pid.toString()).catch(() => {});
    console.log('[redis-ipc] Connected — distributed agent-runner mode active');
  } catch (err) {
    console.error('[redis-ipc] Failed to connect, falling back to file-system mode:', err);
    _connected = false;
  }
}

/** Is Redis IPC connected? */
export function isRedisIpcConnected(): boolean {
  return _connected;
}

/** Wait for a task from the Redis queue (replaces readStdin in distributed mode). */
export function waitForTask(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!_connected) {
      reject(new Error('Redis not connected'));
      return;
    }
    // Use blocking pop from a list (BRPOP) for reliable task distribution
    // This ensures each task is consumed by exactly one agent-runner
    _sub.subscribe(TASK_QUEUE_CHANNEL, (raw: string) => {
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Failed to parse task: ${err}`));
      }
    }).catch(() => reject(new Error('Failed to subscribe to task queue')));
  });
}

/**
 * Subscribe to IPC input channel for a group folder.
 * Returns an unsubscribe function.
 * Messages arrive as { type: 'message' | '_close' | '_drain' | '_interrupt', text, images, ... }
 */
export async function subscribeIpcInput(
  groupFolder: string,
  handler: (payload: any) => void,
): Promise<() => void> {
  if (!_connected) return () => {};
  const channel = IPC_INPUT_PREFIX + groupFolder;
  await _sub.subscribe(channel, (raw: string) => {
    try {
      handler(JSON.parse(raw));
    } catch (err) {
      console.error('[redis-ipc] Failed to parse input message:', err);
    }
  });
  return () => {
    try { _sub.unsubscribe(channel); } catch { /* ignore */ }
  };
}

/** Publish an output message (send_message result, task request) via Redis. */
export async function publishIpcOutput(
  groupFolder: string,
  subdir: 'messages' | 'tasks',
  payload: any,
): Promise<void> {
  if (!_connected) return;
  const channel = `${IPC_OUTPUT_PREFIX}${groupFolder}:${subdir}`;
  try {
    await _pub.publish(channel, JSON.stringify(payload));
  } catch (err) {
    console.error('[redis-ipc] Failed to publish output:', err);
  }
}

/** Publish a task request and wait for result (replaces pollIpcResult). */
export async function requestTaskResult(
  groupFolder: string,
  requestPayload: any,
  requestId: string,
  timeoutMs = 30000,
): Promise<any> {
  if (!_connected) {
    throw new Error('Redis not connected');
  }
  const resultChannel = `${IPC_TASK_PREFIX}${groupFolder}:${requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { _sub.unsubscribe(resultChannel); } catch { /* ignore */ }
      reject(new Error(`Task result timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    _sub.subscribe(resultChannel, (raw: string) => {
      clearTimeout(timer);
      try { _sub.unsubscribe(resultChannel); } catch { /* ignore */ }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Failed to parse task result: ${err}`));
      }
    }).catch(() => {
      clearTimeout(timer);
      reject(new Error('Failed to subscribe to result channel'));
    });

    // Publish the request
    publishIpcOutput(groupFolder, 'tasks', { ...requestPayload, requestId }).catch(() => {});
  });
}

/** Unregister this agent-runner from the pool and close connections. */
export async function closeRedisIpc(): Promise<void> {
  try {
    if (_pub) {
      await _pub.sRem('deepthink:agent-runners:pool', process.pid.toString()).catch(() => {});
    }
  } catch { /* ignore */ }
  const tasks: Promise<void>[] = [];
  if (_pub) tasks.push(_pub.quit().then(() => {}).catch(() => {}));
  if (_sub) tasks.push(_sub.quit().then(() => {}).catch(() => {}));
  await Promise.allSettled(tasks);
  _pub = null;
  _sub = null;
  _connected = false;
  console.log('[redis-ipc] Connections closed');
}
