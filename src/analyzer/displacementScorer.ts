// ============================================================
// Displacement Scorer - Phase 2
// ============================================================
// Scores the "displacement" (aggressive impulse move) that must
// follow a liquidity sweep for the ICT signal to be valid.
//
// ICT: Displacement should be "so obvious, similar to how an
// Elephant would jump into a Children's pool."
// ============================================================

import { Candle, DisplacementResult, FairValueGap, Timeframe } from '../types/index.js';
import { SCORING_CONFIG } from '../config/scoring.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('DisplacementScorer');

export type { DisplacementResult };

/**
 * Calculate ATR (Average True Range) over a given period.
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
 *
 * @param candles - Candle array (ascending time order)
 * @param period  - ATR period (default 14)
 */
export function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 0;

  const limit = Math.min(candles.length - 1, period);
  let atrSum = 0;

  for (let i = candles.length - limit; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const trueRange = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    atrSum += trueRange;
  }

  return atrSum / limit;
}

/**
 * Detect FVGs within a specific range of candles.
 * Helper used internally by scoreDisplacement to count imbalances.
 *
 * @param candles   - Full candle array
 * @param fromIndex - Start index of the range (inclusive)
 * @param toIndex   - End index of the range (inclusive)
 * @param timeframe - Timeframe label for the FVG
 */
export function detectFVGsInRange(
  candles: Candle[],
  fromIndex: number,
  toIndex: number,
  timeframe: Timeframe = '5m',
): FairValueGap[] {
  const fvgs: FairValueGap[] = [];

  // Need prev and next candles, so start at max(fromIndex, 1) and end at min(toIndex, len-2)
  const start = Math.max(fromIndex, 1);
  const end = Math.min(toIndex, candles.length - 2);

  for (let i = start; i <= end; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const next = candles[i + 1]!;

    // Bullish FVG: gap between prev.high and next.low (price jumped up)
    if (next.low > prev.high) {
      const bottom = prev.high;
      const top = next.low;
      fvgs.push({
        id: `fvg_${curr.timestamp.getTime()}_${timeframe}_BULLISH_${bottom.toFixed(2)}_${top.toFixed(2)}`,
        timestamp: curr.timestamp,
        timeframe,
        type: 'BULLISH',
        top,
        bottom,
        ce: (top + bottom) / 2,
        quality: 'LOW',
        state: 'OPEN',
        inDisplacement: true,
      });
    }

    // Bearish FVG: gap between prev.low and next.high (price jumped down)
    if (next.high < prev.low) {
      const top = prev.low;
      const bottom = next.high;
      fvgs.push({
        id: `fvg_${curr.timestamp.getTime()}_${timeframe}_BEARISH_${bottom.toFixed(2)}_${top.toFixed(2)}`,
        timestamp: curr.timestamp,
        timeframe,
        type: 'BEARISH',
        top,
        bottom,
        ce: (top + bottom) / 2,
        quality: 'LOW',
        state: 'OPEN',
        inDisplacement: true,
      });
    }
  }

  return fvgs;
}

/**
 * Score the displacement quality of a candle sequence (0-10).
 *
 * Scoring breakdown:
 *   - atrScore  (0-3): totalRange / ATR ratio (>2.0x = 3, >1.5x = 2, >1.0x = 1)
 *   - volumeScore (0-2): avg volume vs 20-period avg (>3x = 2, >2x = 1)
 *   - bodyScore  (0-2): avg body ratio of displacement candles (>0.7 = 2, >0.5 = 1)
 *   - fvgScore   (0-3): FVG count within displacement (>=3 = 3, 2 = 2, 1 = 1)
 *
 * @param candles   - Full candle array (provides ATR/volume lookback context)
 * @param fromIndex - First candle of the displacement range (inclusive)
 * @param toIndex   - Last candle of the displacement range (inclusive)
 */
export function scoreDisplacement(
  candles: Candle[],
  fromIndex: number,
  toIndex: number,
): DisplacementResult {
  const zero: DisplacementResult = {
    score: 0, totalRange: 0, atrRatio: 0,
    volumeRatio: 0, fvgCount: 0, fvgs: [], bodyRatio: 0, direction: 'BULLISH',
  };

  if (fromIndex < 0 || toIndex >= candles.length || fromIndex > toIndex) {
    log.debug('scoreDisplacement: invalid index range');
    return zero;
  }

  const dispCandles = candles.slice(fromIndex, toIndex + 1);
  if (dispCandles.length === 0) return zero;

  const { atrPeriod, volumeLookback } = SCORING_CONFIG.displacement;

  // 1. ATR: calculated from candles before the displacement start
  const lookbackEnd = Math.min(fromIndex + 1, candles.length);
  const atr = calculateATR(candles.slice(0, lookbackEnd), atrPeriod);

  // 2. Total range of displacement candles
  const highestHigh = Math.max(...dispCandles.map((c) => c.high));
  const lowestLow = Math.min(...dispCandles.map((c) => c.low));
  const totalRange = highestHigh - lowestLow;

  // 3. Direction: bullish if last close > first close
  const firstClose = dispCandles[0]!.close;
  const lastClose = dispCandles[dispCandles.length - 1]!.close;
  const direction: 'BULLISH' | 'BEARISH' = lastClose >= firstClose ? 'BULLISH' : 'BEARISH';

  // 4. ATR ratio score (0-3)
  const atrRatio = atr > 0 ? totalRange / atr : 0;
  let atrScore = 0;
  if (atrRatio >= 2.0) atrScore = 3;
  else if (atrRatio >= 1.5) atrScore = 2;
  else if (atrRatio >= 1.0) atrScore = 1;

  // 5. Volume ratio score (0-2)
  const volStart = Math.max(0, fromIndex - volumeLookback);
  const lookbackCandles = candles.slice(volStart, fromIndex);
  const avgVolume =
    lookbackCandles.length > 0
      ? lookbackCandles.reduce((s, c) => s + c.volume, 0) / lookbackCandles.length
      : 0;
  const dispAvgVolume = dispCandles.reduce((s, c) => s + c.volume, 0) / dispCandles.length;
  const volumeRatio = avgVolume > 0 ? dispAvgVolume / avgVolume : 0;
  let volumeScore = 0;
  if (volumeRatio >= 3.0) volumeScore = 2;
  else if (volumeRatio >= 2.0) volumeScore = 1;

  // 6. Body ratio score (0-2): how much of each candle is body vs wick
  const bodyRatios = dispCandles.map((c) => {
    const range = c.high - c.low;
    return range > 0 ? Math.abs(c.close - c.open) / range : 0;
  });
  const bodyRatio = bodyRatios.reduce((s, r) => s + r, 0) / bodyRatios.length;
  let bodyScore = 0;
  if (bodyRatio >= 0.7) bodyScore = 2;
  else if (bodyRatio >= 0.5) bodyScore = 1;

  // 7. FVG score (0-3): count imbalances created during displacement
  const timeframe = dispCandles[0]?.timeframe ?? '5m';
  const fvgs = detectFVGsInRange(candles, fromIndex, toIndex, timeframe);
  let fvgScore = 0;
  if (fvgs.length >= 3) fvgScore = 3;
  else if (fvgs.length === 2) fvgScore = 2;
  else if (fvgs.length === 1) fvgScore = 1;

  const score = Math.min(10, atrScore + volumeScore + bodyScore + fvgScore);

  log.debug(
    `scoreDisplacement [${fromIndex}-${toIndex}]: atr=${atrScore} vol=${volumeScore} body=${bodyScore} fvg=${fvgScore} → ${score}/10`,
  );

  return { score, totalRange, atrRatio, volumeRatio, fvgCount: fvgs.length, fvgs, bodyRatio, direction };
}
