// ============================================================
// Risk Manager - Phase 3
// ============================================================
// Gatekeeper for all trade entries. No trade happens without
// passing every check in priority order.
//
// Check order:
//   1. Kill switch (>= 15% drawdown from peak)
//   2. Weekly drawdown cap (>= 5%)
//   3. Daily loss cap (>= 2%)
//   4. Max trades per day (1)
//   5. Minimum R:R (>= 2.0)
//   6. Dynamic risk sizing based on consecutive losses
// ============================================================

import { RISK_CONFIG } from '../config/risk.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('RiskManager');

// --------------- Interfaces ---------------

export interface RiskCheck {
  allowed: boolean;
  reason: string;
  riskPercent: number;
  positionSizeUsdt: number;
  leverage: number;
}

export interface RiskState {
  consecutiveLosses: number;
  tradesToday: number;
  dailyPnlUsdt: number;
  weeklyPnlUsdt: number;
  peakEquity: number;
  currentEquity: number;
}

// --------------- Module-Level State ---------------

let riskState: RiskState = {
  consecutiveLosses: 0,
  tradesToday: 0,
  dailyPnlUsdt: 0,
  weeklyPnlUsdt: 0,
  peakEquity: parseFloat(process.env['PAPER_BALANCE'] ?? '10000'),
  currentEquity: parseFloat(process.env['PAPER_BALANCE'] ?? '10000'),
};

// --------------- Public Functions ---------------

/**
 * Calculate position size in USDT given risk parameters.
 *
 * Formula:
 *   riskAmountUsdt = accountBalance * riskPercent
 *   stopDistancePct = |entryPrice - stopLoss| / entryPrice
 *   rawPositionSize = riskAmountUsdt / stopDistancePct
 *   positionSize = rawPositionSize * leverage
 *   Capped at accountBalance * leverage (full margin)
 *
 * @param accountBalance - Total account equity in USDT
 * @param riskPercent    - Risk as decimal (0.01 = 1%)
 * @param entryPrice     - Planned entry price
 * @param stopLoss       - Stop loss price
 * @param leverage       - Leverage multiplier
 */
export function calculatePositionSize(
  accountBalance: number,
  riskPercent: number,
  entryPrice: number,
  stopLoss: number,
  leverage: number,
): number {
  const stopDistancePct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (stopDistancePct === 0) return 0;

  const riskAmountUsdt = accountBalance * riskPercent;
  const rawSize = riskAmountUsdt / stopDistancePct;
  const positionSize = rawSize * leverage;
  const maxAllowed = accountBalance * leverage;

  return Math.min(positionSize, maxAllowed);
}

/**
 * Check if a new trade is allowed under all current risk rules.
 * All checks are synchronous — no DB access needed.
 *
 * @param accountBalance - Current account equity
 * @param proposedRR     - Signal's R:R ratio
 * @param entryPrice     - Planned entry price
 * @param stopLoss       - Stop loss price
 */
export function checkRiskAllowance(
  accountBalance: number,
  proposedRR: number,
  entryPrice: number,
  stopLoss: number,
): RiskCheck {
  const blocked = (reason: string): RiskCheck => ({
    allowed: false, reason, riskPercent: 0, positionSizeUsdt: 0, leverage: 0,
  });

  // 1. Kill switch: drawdown >= 15% from peak
  if (riskState.peakEquity > 0) {
    const drawdownPct = (riskState.peakEquity - riskState.currentEquity) / riskState.peakEquity;
    if (drawdownPct >= RISK_CONFIG.killSwitchDrawdown) {
      return blocked(`Kill switch: ${(drawdownPct * 100).toFixed(2)}% drawdown from peak equity`);
    }
  }

  // 2. Weekly drawdown cap
  if (riskState.peakEquity > 0) {
    const weeklyPct = riskState.weeklyPnlUsdt / riskState.peakEquity;
    if (weeklyPct <= -RISK_CONFIG.maxWeeklyDrawdown) {
      return blocked(`Weekly drawdown limit reached (${(weeklyPct * 100).toFixed(2)}%)`);
    }
  }

  // 3. Daily loss cap
  if (riskState.currentEquity > 0) {
    const dailyPct = riskState.dailyPnlUsdt / riskState.currentEquity;
    if (dailyPct <= -RISK_CONFIG.maxDailyLoss) {
      return blocked(`Daily loss cap reached (${(dailyPct * 100).toFixed(2)}%)`);
    }
  }

  // 4. Max trades per day
  if (riskState.tradesToday >= RISK_CONFIG.maxTradesPerDay) {
    return blocked(`Max trades per day reached (${riskState.tradesToday}/${RISK_CONFIG.maxTradesPerDay})`);
  }

  // 5. Minimum R:R
  if (proposedRR < RISK_CONFIG.minRR) {
    return blocked(`R:R too low (${proposedRR.toFixed(2)} < ${RISK_CONFIG.minRR})`);
  }

  // 6. Dynamic risk sizing
  let riskPercent: number;
  if (riskState.consecutiveLosses === 0) {
    riskPercent = RISK_CONFIG.maxRiskPerTrade; // 1%
  } else if (riskState.consecutiveLosses === 1) {
    riskPercent = RISK_CONFIG.postLossRisk;    // 0.5%
  } else {
    riskPercent = RISK_CONFIG.post2LossRisk;   // 0.25%
  }

  const leverage = RISK_CONFIG.defaultLeverage;
  const positionSizeUsdt = calculatePositionSize(accountBalance, riskPercent, entryPrice, stopLoss, leverage);

  log.info(
    `Risk OK: risk=${(riskPercent * 100).toFixed(2)}% | size=${positionSizeUsdt.toFixed(2)} USDT | lev=${leverage}x | streak_losses=${riskState.consecutiveLosses}`,
  );

  return { allowed: true, reason: 'OK', riskPercent, positionSizeUsdt, leverage };
}

/**
 * Update risk state after a trade closes.
 *
 * @param pnlUsdt - Realized PnL of the closed trade (negative = loss)
 * @param isWin   - Whether the trade was profitable
 */
export function recordTradeResult(pnlUsdt: number, isWin: boolean): void {
  riskState.tradesToday += 1;
  riskState.dailyPnlUsdt += pnlUsdt;
  riskState.weeklyPnlUsdt += pnlUsdt;
  riskState.currentEquity += pnlUsdt;

  riskState.consecutiveLosses = isWin ? 0 : riskState.consecutiveLosses + 1;

  if (riskState.currentEquity > riskState.peakEquity) {
    riskState.peakEquity = riskState.currentEquity;
  }

  log.info(
    `Trade result: PnL=${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT | consec_losses=${riskState.consecutiveLosses} | daily=${riskState.dailyPnlUsdt.toFixed(2)}`,
  );
}

/** Reset daily counters at 00:00 UTC. */
export function resetDaily(): void {
  riskState.tradesToday = 0;
  riskState.dailyPnlUsdt = 0;
  log.info('Daily risk counters reset');
}

/** Reset weekly PnL counter on Monday 00:00 UTC. */
export function resetWeekly(): void {
  riskState.weeklyPnlUsdt = 0;
  log.info('Weekly risk counters reset');
}

/** Update current equity and peak tracking (called hourly). */
export function updateEquity(currentEquity: number): void {
  riskState.currentEquity = currentEquity;
  if (currentEquity > riskState.peakEquity) {
    riskState.peakEquity = currentEquity;
  }
}

/** Returns true if the kill switch is active (>= 15% drawdown from peak). */
export function isKillSwitchActive(): boolean {
  if (riskState.peakEquity <= 0) return false;
  const drawdown = (riskState.peakEquity - riskState.currentEquity) / riskState.peakEquity;
  return drawdown >= RISK_CONFIG.killSwitchDrawdown;
}

/** Export current risk state snapshot (for /risk Telegram command). */
export function getRiskState(): RiskState {
  return { ...riskState };
}
