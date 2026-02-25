// ============================================================
// Displacement Scorer - PLACEHOLDER (Phase 2)
// ============================================================
// This module will score the "displacement" (aggressive impulse move)
// that must follow a liquidity sweep for the signal to be valid.
//
// Scoring criteria (0-10):
//   - Range relative to ATR (14)
//   - Volume ratio vs 20-period average
//   - Number of FVGs created
//   - Body ratio (close - open vs high - low)
//   - Single-candle vs multi-candle displacement
// ============================================================

import { Candle, DisplacementResult } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('DisplacementScorer');

export type { DisplacementResult };

/**
 * @phase Phase 2
 * Score the displacement quality of a candle sequence.
 */
export function scoreDisplacement(
  _candles: Candle[],
  _fromIndex: number,
  _toIndex: number,
): DisplacementResult {
  log.debug('scoreDisplacement — not implemented yet (Phase 2)');
  return {
    score: 0,
    totalRange: 0,
    atrRatio: 0,
    volumeRatio: 0,
    fvgCount: 0,
    fvgs: [],
    bodyRatio: 0,
    direction: 'BULLISH',
  };
}

/**
 * @phase Phase 2
 * Calculate ATR over a given period.
 */
export function calculateATR(_candles: Candle[], _period: number): number {
  log.debug('calculateATR — not implemented yet (Phase 2)');
  return 0;
}
