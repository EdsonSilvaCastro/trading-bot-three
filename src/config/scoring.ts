// ============================================================
// Scoring Thresholds Configuration
// ============================================================

import { SwingMethod } from '../types/index.js';

export const SCORING_CONFIG = {
  displacement: {
    /** Minimum displacement score for a valid Shift in Market Structure */
    minScoreForSMS: 6,
    /** Score threshold for "strong" displacement */
    strongDisplacement: 8,
    /** ATR period for ratio calculation */
    atrPeriod: 14,
    /** Volume lookback for ratio calculation */
    volumeLookback: 20,
  },
  sweep: {
    /** Candles to look forward for sweep confirmation */
    lookforwardCandles: 5,
    /** Maximum wick penetration beyond level (0.2%) */
    maxPenetrationPercent: 0.002,
    /** Minimum sweep score to trigger entry sequence */
    minScoreForTrigger: 5,
  },
  liquidity: {
    /** Tolerance for equal highs/lows detection (0.1%) */
    eqTolerance: 0.001,
    /** Days before a clean high/low becomes significant */
    cleanHighAge: 3,
  },
  swing: {
    /** Default N value for ICT swing detection (3 candles each side) */
    defaultN: 3,
    /** Default swing detection method */
    method: 'ICT_N3' as SwingMethod,
  },
} as const;
