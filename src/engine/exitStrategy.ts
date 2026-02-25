// ============================================================
// Exit Strategy - PLACEHOLDER (Phase 4)
// ============================================================
// Manages open trade exits:
//   - TP1: Close 50% at first IRL (Internal Range Liquidity) target
//   - TP2: Close remaining 50% at ERL (External Range Liquidity) target
//   - Stop Loss: Moved to breakeven after TP1 hit
//   - Time Exit: Close before NY_CLOSE session
//   - Structural Exit: Close if price breaks the entry swing
// ============================================================

import { Trade } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('ExitStrategy');

export type ExitReason = 'TP1' | 'TP2' | 'STOP_LOSS' | 'TIME_EXIT' | 'STRUCTURAL' | 'MANUAL';

export interface ExitDecision {
  shouldExit: boolean;
  reason: ExitReason | null;
  exitPercent: number; // 0-1 (partial or full)
  newStopLoss?: number;
}

/**
 * @phase Phase 4
 * Evaluate whether an open trade should be exited or adjusted.
 */
export function evaluateExit(
  _trade: Trade,
  _currentPrice: number,
): ExitDecision {
  log.debug('evaluateExit — not implemented yet (Phase 4)');
  return { shouldExit: false, reason: null, exitPercent: 0 };
}

/**
 * @phase Phase 4
 * Calculate where to move stop loss after TP1 is hit (breakeven or beyond).
 */
export function calculateBreakevenStop(_trade: Trade): number {
  log.debug('calculateBreakevenStop — not implemented yet (Phase 4)');
  return 0;
}
