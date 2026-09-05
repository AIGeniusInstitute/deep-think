/**
 * MCP Registry 工具治理：副作用分级 + 调用审计 + 幂等。
 *
 * 设计原则（来自《企业级 Agent 平台技术架构与开发路线图》6.1/6.3）：
 *   - 工具是风险边界；默认只读，写操作需授权与幂等键。
 *   - 每次工具调用关联 request_id，与审计链路可串联。
 *
 * 本模块只依赖 db.js 与 crypto，不引入新依赖；写入失败仅 warn log，
 * 不影响工具调用的主返回（保持 engine.ts "引擎层不抛错"原则）。
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import { logger } from '../logger.js';

export type SideEffect = 'read' | 'write' | 'admin';

/** 由 HTTP method 推断副作用等级。 */
export function inferSideEffect(method: string): SideEffect {
  if (method === 'DELETE') return 'admin';
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') return 'write';
  return 'read';
}

/** 合成副作用：显式声明优先，否则按 method 推断，缺省 read（最保守）。 */
export function resolveSideEffect(
  explicit?: SideEffect | null | undefined,
  method?: string,
): SideEffect {
  if (explicit === 'read' || explicit === 'write' || explicit === 'admin') return explicit;
  if (method) return inferSideEffect(method);
  return 'read';
}

/** 参数指纹：sha16 前 16 字符（不存原始参数，避免泄露 PII）。 */
export function hashArgs(args: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16);
  } catch {
    return '0000000000000000';
  }
}

export interface AuditRow {
  userId: string;
  toolId: string;
  toolName: string;
  sideEffect: SideEffect;
  argsHash: string;
  requestId?: string | null;
  idempotencyKey?: string | null;
  resultStatus: 'success' | 'error';
  httpStatus?: number | null;
  durationMs: number;
}

/** 写一条工具调用审计。失败仅 warn，不抛。 */
export function logToolCallAudit(row: AuditRow): void {
  try {
    const id = createHash('sha256')
      .update(`${row.userId}:${row.toolId}:${Date.now()}:${Math.random()}`)
      .digest('hex');
    getDb()
      .prepare(
        `INSERT INTO tool_call_audit_log
         (id, user_id, tool_id, tool_name, side_effect, args_hash, request_id, idempotency_key, result_status, http_status, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.userId,
        row.toolId,
        row.toolName,
        row.sideEffect,
        row.argsHash,
        row.requestId ?? null,
        row.idempotencyKey ?? null,
        row.resultStatus,
        row.httpStatus ?? null,
        row.durationMs,
        new Date().toISOString(),
      );
  } catch (err) {
    logger.warn({ err, toolId: row.toolId }, 'tool_call_audit_log insert failed (non-fatal)');
  }
}

export interface IdempotencyRecord {
  resultContent: string;
  resultIsError: boolean;
  httpStatus: number | null;
}

/** 查询幂等缓存命中（仅命中且上次成功才回放）。 */
export function getIdempotencyRecord(
  userId: string,
  toolId: string,
  key: string,
): IdempotencyRecord | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT result_content, result_is_error, http_status
         FROM tool_call_idempotency
         WHERE user_id = ? AND tool_id = ? AND idempotency_key = ?`,
      )
      .get(userId, toolId, key) as
      | { result_content: string; result_is_error: number; http_status: number | null }
      | undefined;
    if (!row) return null;
    // 上次失败不回放，允许重试
    if (row.result_is_error === 1) return null;
    return {
      resultContent: row.result_content,
      resultIsError: row.result_is_error === 1,
      httpStatus: row.http_status,
    };
  } catch (err) {
    logger.warn({ err, toolId }, 'idempotency lookup failed (non-fatal)');
    return null;
  }
}

/** 写幂等缓存。失败仅 warn，不抛。 */
export function saveIdempotencyRecord(
  userId: string,
  toolId: string,
  key: string,
  resultContent: string,
  resultIsError: boolean,
  httpStatus: number | null,
): void {
  try {
    const id = createHash('sha256')
      .update(`${userId}:${toolId}:${key}`)
      .digest('hex');
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO tool_call_idempotency
         (id, user_id, tool_id, idempotency_key, result_content, result_is_error, http_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        toolId,
        key,
        resultContent,
        resultIsError ? 1 : 0,
        httpStatus,
        new Date().toISOString(),
      );
  } catch (err) {
    logger.warn({ err, toolId }, 'idempotency save failed (non-fatal)');
  }
}

/** 清理过期幂等记录（24h）。启动与周期调用。 */
export function cleanupExpiredIdempotency(maxAgeMs = 24 * 60 * 60 * 1000): number {
  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const r = getDb()
      .prepare('DELETE FROM tool_call_idempotency WHERE created_at < ?')
      .run(cutoff);
    return r.changes;
  } catch {
    return 0;
  }
}
