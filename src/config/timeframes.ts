// ============================================================
// Timeframe Definitions
// ============================================================

export const TIMEFRAMES = {
  '5m': { interval: '5', minutes: 5, bybitInterval: '5' },
  '15m': { interval: '15', minutes: 15, bybitInterval: '15' },
  '1h': { interval: '60', minutes: 60, bybitInterval: '60' },
  '4h': { interval: '240', minutes: 240, bybitInterval: '240' },
  '1d': { interval: 'D', minutes: 1440, bybitInterval: 'D' },
} as const;

/**
 * Multi-timeframe analysis hierarchy (Day Trader / Scalper).
 * - longTerm: Used for overall bias direction
 * - intermediate: Used for structure refinement
 * - shortTerm: Used for execution entries
 * - context: Higher timeframe context
 */
export const TF_HIERARCHY = {
  longTerm: '1h' as const,       // Bias direction
  intermediate: '15m' as const,  // Structure refinement
  shortTerm: '5m' as const,      // Execution
  context: ['4h', '1d'] as const, // Higher context
};

export type TimeframeKey = keyof typeof TIMEFRAMES;
