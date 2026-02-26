// ============================================================
// Exit Strategy - Phase 3
// ============================================================
// ICT-specific exit rules evaluated in priority order:
//   1. KILL_SWITCH: emergency close (drawdown >= 15%)
//   2. STOP_LOSS:   price hit SL
//   3. TP1:         50% close at first target, SL → breakeven
//   4. TP2:         remaining 50% close at second target
//   5. TIME_EXIT:   force-close at 15:30 NY time
//   6. STRUCTURAL:  new SMS in opposite direction on 15M
// ============================================================

import { Trade, StructureState } from '../types/index.js';
import { toNYTime } from './sessionFilter.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('ExitStrategy');

export type ExitReason = 'TP1' | 'TP2' | 'STOP_LOSS' | 'TIME_EXIT' | 'STRUCTURAL' | 'MANUAL' | 'KILL_SWITCH';

export interface ExitDecision {
  shouldExit: boolean;
  reason: ExitReason | null;
  exitPercent: number;    // 0-1 (0.5 for TP1, 1.0 for full close)
  newStopLoss?: number;   // Set when moving SL to breakeven after TP1
  exitPrice?: number;     // Price at which to execute the exit
}

const NO_EXIT: ExitDecision = { shouldExit: false, reason: null, exitPercent: 0 };

/**
 * Evaluate whether an open trade should be exited or adjusted.
 * Checks are applied in priority order — first match wins.
 *
 * @param trade            - The open trade being managed
 * @param currentPrice     - Latest market price
 * @param currentTime      - Current UTC time
 * @param structureState15m - 15M structure (for structural exits)
 * @param isKillSwitch     - Whether kill switch is active
 */
export function evaluateExit(
  trade: Trade,
  currentPrice: number,
  currentTime: Date,
  structureState15m: StructureState,
  isKillSwitch: boolean,
): ExitDecision {
  if (trade.status === 'STOPPED' || trade.status === 'TP2_HIT' || trade.status === 'TIME_EXIT') {
    return NO_EXIT; // Already closed
  }

  // 1. Kill switch — emergency close everything
  if (isKillSwitch) {
    log.warn(`KILL_SWITCH exit triggered for trade ${trade.id}`);
    return { shouldExit: true, reason: 'KILL_SWITCH', exitPercent: 1.0, exitPrice: currentPrice };
  }

  // 2. Stop loss hit
  const slHit =
    trade.direction === 'LONG'
      ? currentPrice <= trade.stopLoss
      : currentPrice >= trade.stopLoss;

  if (slHit) {
    return { shouldExit: true, reason: 'STOP_LOSS', exitPercent: 1.0, exitPrice: trade.stopLoss };
  }

  // 3. TP1 (if not yet executed)
  if (!trade.tp1Hit) {
    const tp1Hit =
      trade.direction === 'LONG'
        ? currentPrice >= trade.tp1Level
        : currentPrice <= trade.tp1Level;

    if (tp1Hit) {
      const newStopLoss = calculateBreakevenStop(trade);
      return {
        shouldExit: true,
        reason: 'TP1',
        exitPercent: 0.5,
        newStopLoss,
        exitPrice: trade.tp1Level,
      };
    }
  }

  // 4. TP2 (after TP1 hit)
  if (trade.tp1Hit) {
    const tp2Hit =
      trade.direction === 'LONG'
        ? currentPrice >= trade.tp2Level
        : currentPrice <= trade.tp2Level;

    if (tp2Hit) {
      return { shouldExit: true, reason: 'TP2', exitPercent: 1.0, exitPrice: trade.tp2Level };
    }
  }

  // 5. Time exit (after 15:30 NY time)
  if (shouldTimeExit(currentTime)) {
    return { shouldExit: true, reason: 'TIME_EXIT', exitPercent: 1.0, exitPrice: currentPrice };
  }

  // 6. Structural exit — 15M SMS shifted AGAINST the trade direction
  const structurallyExited = checkStructuralExit(trade, structureState15m);
  if (structurallyExited) {
    log.info(`Structural exit: 15M structure shifted against ${trade.direction} trade`);
    return { shouldExit: true, reason: 'STRUCTURAL', exitPercent: 1.0, exitPrice: currentPrice };
  }

  return NO_EXIT;
}

/**
 * Calculate breakeven stop loss after TP1 is hit.
 * Places SL at entry price + small buffer to cover spread/slippage.
 *
 * @param trade - The open trade
 */
export function calculateBreakevenStop(trade: Trade): number {
  const buffer = trade.entryPrice * 0.0005; // 0.05% buffer
  return trade.direction === 'LONG'
    ? trade.entryPrice + buffer  // LONG: SL just above entry
    : trade.entryPrice - buffer; // SHORT: SL just below entry
}

// --------------- Helpers ---------------

/**
 * Check if it's time to force-close all positions.
 * Uses 15:30 NY time as the deadline (before the 16:00 NY_CLOSE session).
 */
function shouldTimeExit(currentTime: Date): boolean {
  const ny = toNYTime(currentTime);
  const h = ny.getUTCHours();
  const m = ny.getUTCMinutes();
  return h > 15 || (h === 15 && m >= 30);
}

/**
 * Detect if the 15M market structure has shifted against the open trade.
 * A structural exit fires when:
 *   - LONG trade + SMS_BEARISH or CHOCH_BEARISH on 15M
 *   - SHORT trade + SMS_BULLISH or CHOCH_BULLISH on 15M
 */
function checkStructuralExit(trade: Trade, structure15m: StructureState): boolean {
  if (!structure15m || structure15m.trend === 'UNDEFINED') return false;

  const lastEvent = structure15m.lastEvent;

  if (trade.direction === 'LONG') {
    return lastEvent === 'SMS_BEARISH' || lastEvent === 'CHOCH_BEARISH';
  }

  if (trade.direction === 'SHORT') {
    return lastEvent === 'SMS_BULLISH' || lastEvent === 'CHOCH_BULLISH';
  }

  return false;
}
