// ============================================================
// Signal Detector - PLACEHOLDER (Phase 2)
// ============================================================
// Combines sweep + SMS + displacement into a confirmed signal.
//
// The full ICT signal sequence (Layer 2 + Layer 3):
//   1. Bias is BULLISH or BEARISH (from biasEngine)
//   2. Price sweeps a qualifying liquidity level
//   3. Displacement candle(s) follow the sweep
//   4. Market structure shifts (SMS) on 5M or 15M
//   5. Price retraces into the FVG created in step 3
//   6. Entry limit order placed at FVG
// ============================================================

import { Sweep, FairValueGap, DailyBias } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('SignalDetector');

export interface TradingSignal {
  direction: 'LONG' | 'SHORT';
  sweep: Sweep;
  entryFVG: FairValueGap;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rrRatio: number;
  displacementScore: number;
  confidence: number; // 0-100
}

/**
 * @phase Phase 2
 * Check if a complete ICT signal has formed.
 */
export function detectSignal(
  _bias: DailyBias,
  _recentSweeps: Sweep[],
  _fvgs: FairValueGap[],
): TradingSignal | null {
  log.debug('detectSignal — not implemented yet (Phase 2)');
  return null;
}
