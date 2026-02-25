// ============================================================
// Risk Manager - PLACEHOLDER (Phase 3)
// ============================================================
// Enforces all risk rules before allowing trade entry:
//   - Maximum 1 trade per day
//   - Dynamic risk sizing (1% -> 0.5% -> 0.25% after losses)
//   - Daily loss cap (2%)
//   - Weekly drawdown cap (5%)
//   - Kill switch at 15% from equity peak
//   - Minimum R:R validation (>= 2.0)
// ============================================================

import { Trade } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('RiskManager');

export interface RiskCheck {
  allowed: boolean;
  reason: string;
  riskPercent: number;
  positionSizeUsdt: number;
}

/**
 * @phase Phase 3
 * Check if a new trade is allowed under current risk rules.
 */
export async function checkRiskAllowance(
  _accountBalanceUsdt: number,
  _proposedRR: number,
): Promise<RiskCheck> {
  log.debug('checkRiskAllowance — not implemented yet (Phase 3)');
  return {
    allowed: false,
    reason: 'Risk manager not implemented yet (Phase 3)',
    riskPercent: 0,
    positionSizeUsdt: 0,
  };
}

/**
 * @phase Phase 3
 * Calculate position size in USDT given risk percentage and stop distance.
 */
export function calculatePositionSize(
  _accountBalance: number,
  _riskPercent: number,
  _entryPrice: number,
  _stopLoss: number,
  _leverage: number,
): number {
  log.debug('calculatePositionSize — not implemented yet (Phase 3)');
  return 0;
}

/**
 * @phase Phase 3
 * Get total realized PnL for today's trades.
 */
export async function getTodayPnL(_trades: Trade[]): Promise<number> {
  log.debug('getTodayPnL — not implemented yet (Phase 3)');
  return 0;
}
