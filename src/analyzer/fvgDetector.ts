// ============================================================
// Fair Value Gap (FVG) Detector - Phase 2
// ============================================================
// An FVG (imbalance) occurs when a 3-candle sequence leaves a gap:
//   BULLISH FVG: candles[i-1].high < candles[i+1].low  (gap up)
//   BEARISH FVG: candles[i-1].low  > candles[i+1].high (gap down)
//
// candle[i] is the impulse candle. The gap is between i-1 and i+1.
// CE = consequent encroachment (50% midpoint of the gap).
// ============================================================

import { Candle, FairValueGap, FVGState, Timeframe } from '../types/index.js';
import { SCORING_CONFIG } from '../config/scoring.js';
import { scoreDisplacement } from './displacementScorer.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('FVGDetector');

export type { FairValueGap };

/**
 * Assess FVG quality based on displacement context and impulse body ratio.
 * HIGH: formed during displacement AND strong body ratio
 * MEDIUM: formed during displacement OR decent body ratio
 * LOW: otherwise
 */
function assessFVGQuality(
  candles: Candle[],
  impulseIndex: number,
): 'HIGH' | 'MEDIUM' | 'LOW' {
  const impulse = candles[impulseIndex]!;
  const range = impulse.high - impulse.low;
  const bodyRatio = range > 0 ? Math.abs(impulse.close - impulse.open) / range : 0;

  // Score displacement on a short lookback window to detect if we're in a displacement
  const lookbackStart = Math.max(0, impulseIndex - 5);
  const dispResult = scoreDisplacement(candles, lookbackStart, impulseIndex);
  const inDisplacement = dispResult.score >= SCORING_CONFIG.displacement.minScoreForSMS;

  if (inDisplacement && bodyRatio > 0.7) return 'HIGH';
  if (inDisplacement || bodyRatio > 0.5) return 'MEDIUM';
  return 'LOW';
}

/**
 * Detect all FVGs in a candle array.
 * Scans every 3-candle window for bullish/bearish imbalances.
 *
 * @param candles   - Full candle array (ascending time order)
 * @param timeframe - Timeframe label for the detected FVGs
 */
export function detectFVGs(candles: Candle[], timeframe: Timeframe): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  if (candles.length < 3) return fvgs;

  for (let i = 1; i <= candles.length - 2; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const next = candles[i + 1]!;

    // Bullish FVG: gap between prev.high (bottom) and next.low (top)
    if (next.low > prev.high) {
      const bottom = prev.high;
      const top = next.low;
      const quality = assessFVGQuality(candles, i);
      // Deterministic ID: same gap always produces the same ID so mergeFVGs deduplicates correctly
      const id = `fvg_${curr.timestamp.getTime()}_${timeframe}_BULLISH_${bottom.toFixed(2)}_${top.toFixed(2)}`;

      fvgs.push({
        id,
        timestamp: curr.timestamp,
        timeframe,
        type: 'BULLISH',
        top,
        bottom,
        ce: (top + bottom) / 2,
        quality,
        state: 'OPEN',
        inDisplacement: quality !== 'LOW',
      });
    }

    // Bearish FVG: gap between next.high (bottom) and prev.low (top)
    if (next.high < prev.low) {
      const top = prev.low;
      const bottom = next.high;
      const quality = assessFVGQuality(candles, i);
      const id = `fvg_${curr.timestamp.getTime()}_${timeframe}_BEARISH_${bottom.toFixed(2)}_${top.toFixed(2)}`;

      fvgs.push({
        id,
        timestamp: curr.timestamp,
        timeframe,
        type: 'BEARISH',
        top,
        bottom,
        ce: (top + bottom) / 2,
        quality,
        state: 'OPEN',
        inDisplacement: quality !== 'LOW',
      });
    }
  }

  log.debug(`detectFVGs [${timeframe}]: found ${fvgs.length} FVGs in ${candles.length} candles`);
  return fvgs;
}

/**
 * Update FVG states based on how much price has filled each gap.
 *
 * State transitions:
 *   OPEN → PARTIALLY_FILLED: price wick entered the gap zone
 *   PARTIALLY_FILLED → CE_TOUCHED: price wick reached the midpoint
 *   CE_TOUCHED → FILLED: price close went through the entire gap
 *   any → VIOLATED: price close went through the gap against FVG direction
 *     (bullish FVG: close < bottom = violated downward)
 *     (bearish FVG: close > top = violated upward)
 *
 * @param fvgs         - Current FVG array
 * @param recentCandles - Recent candles to check against
 */
export function updateFVGStates(fvgs: FairValueGap[], recentCandles: Candle[]): FairValueGap[] {
  if (recentCandles.length === 0) return fvgs;

  return fvgs.map((fvg) => {
    if (fvg.state === 'FILLED' || fvg.state === 'VIOLATED') return fvg;

    let state: FVGState = fvg.state;

    for (const candle of recentCandles) {
      if (state === 'VIOLATED') break;

      if (fvg.type === 'BULLISH') {
        // Bullish FVG: price should retrace DOWN into the gap
        // Violated if price closes below the bottom (blasted through the support zone)
        if (candle.close < fvg.bottom) {
          state = 'VIOLATED';
        } else if (state === 'PARTIALLY_FILLED' && candle.low <= fvg.ce) {
          state = 'CE_TOUCHED';
        } else if (state === 'OPEN' && candle.low < fvg.top) {
          state = 'PARTIALLY_FILLED';
        }
      } else {
        // Bearish FVG: price should retrace UP into the gap
        // Violated if price closes above the top (blasted through the resistance zone)
        if (candle.close > fvg.top) {
          state = 'VIOLATED';
        } else if (state === 'PARTIALLY_FILLED' && candle.high >= fvg.ce) {
          state = 'CE_TOUCHED';
        } else if (state === 'OPEN' && candle.high > fvg.bottom) {
          state = 'PARTIALLY_FILLED';
        }
      }
    }

    if (state !== fvg.state) {
      log.debug(`FVG ${fvg.id.slice(0, 8)} [${fvg.type}] ${fvg.state} → ${state}`);
    }

    return state !== fvg.state ? { ...fvg, state } : fvg;
  });
}

/**
 * Find the best FVG for trade entry.
 *
 * Criteria (in priority order):
 *   1. State must be OPEN or PARTIALLY_FILLED
 *   2. Quality must be HIGH or MEDIUM
 *   3. Type must match the desired direction
 *   4. Most recently formed FVG wins
 *
 * @param fvgs      - All active FVGs
 * @param direction - 'BULLISH' for longs (buy from bullish FVG), 'BEARISH' for shorts
 */
export function findEntryFVG(
  fvgs: FairValueGap[],
  direction: 'BULLISH' | 'BEARISH',
): FairValueGap | null {
  const candidates = fvgs
    .filter(
      (f) =>
        f.type === direction &&
        (f.state === 'OPEN' || f.state === 'PARTIALLY_FILLED') &&
        (f.quality === 'HIGH' || f.quality === 'MEDIUM'),
    )
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return candidates[0] ?? null;
}
