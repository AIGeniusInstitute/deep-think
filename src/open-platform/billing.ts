/**
 * Agent Service 开放平台计费闭环。
 *
 * 把 MaaS / Agent as a Service 的对外调用接入现有 billing 体系：
 * - 前置：checkOpenPlatformBilling 余额/配额校验（不足返回 402）。
 * - 后置：billOpenPlatformUsage 写 usage_records（source='open-platform'）
 *   并 updateUsage + deductUsageCost 扣费。
 *
 * 计费对象 = API Key 属主。admin 与 billing 关闭时豁免（复用 billing.ts 内部逻辑）。
 */
import {
  checkBillingAccess,
  formatBillingAccessDeniedMessage,
  updateUsage,
  deductUsageCost,
} from '../billing.js';
import { getUserById, insertUsageRecord, getModelPricing } from '../db.js';
import { logger } from '../logger.js';
import crypto from 'crypto';

/** 前置校验结果。allowed=false 时 status 为 HTTP 状态码。 */
export type OpenPlatformBillingCheck =
  | { allowed: true }
  | { allowed: false; status: number; reason: string };

/** 前置：余额/配额校验。不足返回 402 + 可读提示。 */
export function checkOpenPlatformBilling(userId: string): OpenPlatformBillingCheck {
  const user = getUserById(userId);
  if (user?.role === 'admin') return { allowed: true };
  const access = checkBillingAccess(userId, user?.role ?? 'member');
  if (access.allowed) return { allowed: true };
  return { allowed: false, status: 402, reason: formatBillingAccessDeniedMessage(access) };
}

/** 按 model_pricing 计算 MaaS 调用成本。未配置定价的模型返回 0（token 仍计量）。 */
export function computeMaaSCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;
  return (
    (inputTokens / 1_000_000) * pricing.input_price_per_mtok +
    (outputTokens / 1_000_000) * pricing.output_price_per_mtok
  );
}

export interface OpenPlatformUsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  agentId?: string | null;
  durationMs?: number;
  numTurns?: number;
}

/** 后置：计量 + 扣费。失败只记日志，不向上抛（流式已发出的场景不因计费失败报错）。 */
export function billOpenPlatformUsage(
  userId: string,
  usage: OpenPlatformUsageInput,
): void {
  try {
    const user = getUserById(userId);
    if (user?.role === 'admin') return; // admin 豁免：不计量、不扣费

    const messageId = `open-platform-${crypto.randomUUID()}`;
    insertUsageRecord({
      userId,
      groupFolder: 'open-platform',
      agentId: usage.agentId ?? null,
      messageId,
      model: usage.model || 'unknown',
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: usage.costUSD || 0,
      durationMs: usage.durationMs ?? 0,
      numTurns: usage.numTurns ?? 0,
      source: 'open-platform',
    });

    if (usage.costUSD > 0) {
      const effective = updateUsage(
        userId,
        usage.costUSD,
        usage.inputTokens || 0,
        usage.outputTokens || 0,
      );
      deductUsageCost(userId, usage.costUSD, messageId, effective);
    }
  } catch (err) {
    logger.warn({ err, userId }, 'open-platform billing failed');
  }
}
