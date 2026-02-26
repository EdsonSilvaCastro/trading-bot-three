// ============================================================
// Sweep Detector - Phase 2
// ============================================================
// A "sweep" occurs when price takes out a liquidity level
// (swing high/low, EQH/EQL, PDH/PDL) and then reverses.
//
// Detection:
//   BSL sweep: candle.high > level AND close returns below level
//   SSL sweep: candle.low  < level AND close returns above level
//
// Sweep Score (0-10):
//   - Penetration depth (0-3): shallower = cleaner = more significant
//   - Reversal speed (0-3): faster = more institutional
//   - Displacement on reversal candle (0-2): strong body = real move
//   - Level quality (0-2): from liquidityLevel.score
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { Candle, Sweep, LiquidityLevel, LiquidityType } from '../types/index.js';
import { SCORING_CONFIG } from '../config/scoring.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('SweepDetector');

export type { Sweep };

const HIGH_TYPES: Set<LiquidityType> = new Set(['BSL', 'EQH', 'PDH', 'PWH', 'SESSION_HIGH']);

/**
 * Score a sweep based on its characteristics (0-10).
 */
function computeSweepScore(
  level: LiquidityLevel,
  extreme: number,
  delay: number,
  reversalBodyRatio: number,
): number {
  // 1. Penetration depth (0-3): how far past the level price went
  const penetrationPct = Math.abs(extreme - level.level) / level.level;
  let penetrationScore = 0;
  if (penetrationPct < 0.001) penetrationScore = 3;       // < 0.1% — ultra-clean sweep
  else if (penetrationPct < 0.002) penetrationScore = 2;  // < 0.2% — clean sweep
  else if (penetrationPct < 0.005) penetrationScore = 1;  // < 0.5% — moderate
  // >= 0.5%: score 0 (too deep, likely a real breakout)

  // 2. Reversal speed (0-3): IMMEDIATE = delay 0 (same candle)
  let speedScore = 0;
  if (delay === 0) speedScore = 3;
  else if (delay === 1) speedScore = 2;
  else if (delay <= 3) speedScore = 1;
  // delay 4-5: score 0

  // 3. Displacement on reversal (0-2): body ratio > 0.6 = 2, > 0.4 = 1
  let dispScore = 0;
  if (reversalBodyRatio >= 0.6) dispScore = 2;
  else if (reversalBodyRatio >= 0.4) dispScore = 1;

  // 4. Level quality (0-2): from the liquidity level's score
  let qualityScore = 0;
  if (level.score >= 8) qualityScore = 2;
  else if (level.score >= 5) qualityScore = 1;

  return Math.min(10, penetrationScore + speedScore + dispScore + qualityScore);
}

/**
 * Attempt to detect a sweep of a liquidity level in recent candles.
 *
 * @param level   - The liquidity level to check (must be ACTIVE)
 * @param candles - Recent candles to scan through
 */
export function detectSweep(level: LiquidityLevel, candles: Candle[]): Sweep | null {
  if (level.state !== 'ACTIVE') return null;

  const isHighLevel = HIGH_TYPES.has(level.type);
  const { lookforwardCandles } = SCORING_CONFIG.sweep;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;

    // Check if this candle's wick exceeded the level
    const levelExceeded = isHighLevel
      ? candle.high > level.level
      : candle.low < level.level;

    if (!levelExceeded) continue;

    const extreme = isHighLevel ? candle.high : candle.low;

    // EARLY REJECT: penetration > 1% is never a sweep — it's a real directional move.
    // Guards against false matches with very old candles from the backfill window.
    const penetrationPct = Math.abs(extreme - level.level) / level.level;
    if (penetrationPct > 0.01) continue;

    // IMMEDIATE: same candle closes back on the correct side
    const immediateReversal = isHighLevel
      ? candle.close < level.level  // Ran above, closed below = BSL swept
      : candle.close > level.level; // Ran below, closed above = SSL swept

    if (immediateReversal) {
      const range = candle.high - candle.low;
      const bodyRatio = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
      const score = computeSweepScore(level, extreme, 0, bodyRatio);
      if (score === 0) continue; // Too deep to be valid

      log.debug(
        `SWEEP [IMMEDIATE] ${level.type} @ ${level.level.toFixed(2)} | extreme=${extreme.toFixed(2)} | pen=${(penetrationPct * 100).toFixed(3)}% | score=${score}`,
      );

      return {
        id: uuidv4(),
        timestamp: candle.timestamp,
        liquidityLevel: level,
        confirmation: 'IMMEDIATE',
        delay: 0,
        score,
        extreme,
      };
    }

    // DELAYED: check next N candles for reversal confirmation
    const maxDelay = Math.min(lookforwardCandles, candles.length - i - 1);
    for (let d = 1; d <= maxDelay; d++) {
      const confirmCandle = candles[i + d]!;
      const delayedReversal = isHighLevel
        ? confirmCandle.close < level.level
        : confirmCandle.close > level.level;

      if (delayedReversal) {
        const range = confirmCandle.high - confirmCandle.low;
        const bodyRatio = range > 0 ? Math.abs(confirmCandle.close - confirmCandle.open) / range : 0;
        const score = computeSweepScore(level, extreme, d, bodyRatio);
        if (score === 0) break; // Too deep

        log.debug(
          `SWEEP [DELAYED +${d}] ${level.type} @ ${level.level.toFixed(2)} | extreme=${extreme.toFixed(2)} | pen=${(penetrationPct * 100).toFixed(3)}% | score=${score}`,
        );

        return {
          id: uuidv4(),
          timestamp: confirmCandle.timestamp,
          liquidityLevel: level,
          confirmation: 'DELAYED',
          delay: d,
          score,
          extreme,
        };
      }
    }
  }

  return null;
}

/**
 * Scan all active liquidity levels for sweeps in the latest candles.
 *
 * @param levels        - Active liquidity levels to scan
 * @param recentCandles - Recent candles window
 */
export function scanForSweeps(levels: LiquidityLevel[], recentCandles: Candle[]): Sweep[] {
  const sweeps: Sweep[] = [];

  for (const level of levels) {
    try {
      const sweep = detectSweep(level, recentCandles);
      if (sweep && sweep.score >= SCORING_CONFIG.sweep.minScoreForTrigger) {
        sweeps.push(sweep);
        log.info(
          `QUALIFYING SWEEP: ${level.type} @ ${level.level.toFixed(2)} | score=${sweep.score} | ${sweep.confirmation} +${sweep.delay}`,
        );
      }
    } catch (err) {
      log.warn(`sweepDetector error for ${level.type} @ ${level.level}: ${(err as Error).message}`);
    }
  }

  if (sweeps.length > 0) {
    log.info(`scanForSweeps: ${sweeps.length} qualifying sweep(s) detected`);
  }

  return sweeps;
}

/**
 * Re-score a sweep from its stored data.
 * Since the original reversal candle is not stored, body ratio is estimated from confirmation type.
 *
 * @param sweep - Previously detected sweep
 */
export function scoreSweep(sweep: Sweep): number {
  // Estimate body ratio from confirmation speed (immediate sweeps tend to have stronger bodies)
  const estimatedBodyRatio = sweep.confirmation === 'IMMEDIATE' ? 0.65 : 0.45;
  return computeSweepScore(sweep.liquidityLevel, sweep.extreme, sweep.delay, estimatedBodyRatio);
}
