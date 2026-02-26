// ============================================================
// Signal Detector - Phase 2
// ============================================================
// Combines all ICT analysis into the final trading signal.
//
// Full ICT 2022 signal sequence:
//   1. Daily bias is BULLISH or BEARISH (not NO_TRADE)
//   2. We're in a killzone (London or NY_MORNING)
//   3. A qualifying sweep occurred (score >= 5)
//   4. Displacement follows the sweep (SMS on 15M or 5M)
//   5. An FVG exists within the displacement range
//   6. Price is in correct zone (DISCOUNT for longs, PREMIUM for shorts)
//   7. No opposing liquidity blocks the trade
// ============================================================

import {
  Sweep,
  FairValueGap,
  DailyBias,
  LiquidityLevel,
  LiquidityType,
  StructureState,
  Candle,
  Swing,
} from '../types/index.js';
import { RISK_CONFIG } from '../config/risk.js';
import { SCORING_CONFIG } from '../config/scoring.js';
import { isKillzoneActive } from './sessionFilter.js';
import { findEntryFVG } from '../analyzer/fvgDetector.js';
import { getPremiumDiscountState, isInOTE } from '../analyzer/premiumDiscount.js';
import { scoreDisplacement } from '../analyzer/displacementScorer.js';
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

export interface SignalContext {
  bias: DailyBias;
  recentSweeps: Sweep[];
  fvgs: FairValueGap[];
  liquidityLevels: LiquidityLevel[];
  structureState15m: StructureState;
  structureState5m: StructureState;
  currentPrice: number;
  candles5m: Candle[];
  candles15m: Candle[];
  swings5m: Swing[];
  swings15m: Swing[];
}

/** Minimum confidence to generate a signal */
const MIN_CONFIDENCE = 50;

const BULLISH_TP_TYPES: Set<LiquidityType> = new Set(['BSL', 'EQH', 'PDH', 'PWH', 'SESSION_HIGH']);
const BEARISH_TP_TYPES: Set<LiquidityType> = new Set(['SSL', 'EQL', 'PDL', 'PWL', 'SESSION_LOW']);

// --------------- Helpers ---------------

/**
 * Find the nearest FVG of the opposing type above/below a reference price.
 * Used for TP1 (IRL — Internal Range Liquidity).
 */
function findTP1FVG(
  fvgs: FairValueGap[],
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
): number | null {
  const targetType = direction === 'LONG' ? 'BEARISH' : 'BULLISH';
  const candidates = fvgs
    .filter(
      (f) =>
        f.type === targetType &&
        (direction === 'LONG' ? f.bottom > entryPrice : f.top < entryPrice),
    )
    .sort((a, b) =>
      direction === 'LONG'
        ? a.bottom - b.bottom  // Nearest bearish FVG above entry
        : b.top - a.top,       // Nearest bullish FVG below entry
    );

  return candidates[0]
    ? direction === 'LONG' ? candidates[0].ce : candidates[0].ce
    : null;
}

/**
 * Find the nearest TP2 liquidity target (ERL — External Range Liquidity).
 */
function findTP2Level(
  levels: LiquidityLevel[],
  direction: 'LONG' | 'SHORT',
  tp1: number,
): number | null {
  const targetTypes = direction === 'LONG' ? BULLISH_TP_TYPES : BEARISH_TP_TYPES;

  const candidates = levels
    .filter(
      (l) =>
        l.state === 'ACTIVE' &&
        targetTypes.has(l.type) &&
        (direction === 'LONG' ? l.level > tp1 : l.level < tp1),
    )
    .sort((a, b) =>
      direction === 'LONG' ? a.level - b.level : b.level - a.level,
    );

  return candidates[0]?.level ?? null;
}

/**
 * Check if the trade path is blocked by opposing liquidity.
 * For LONG: no significant SSL within 0.5% below entry
 * For SHORT: no significant BSL within 0.5% above entry
 */
function hasBlockingLiquidity(
  levels: LiquidityLevel[],
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
): boolean {
  const BLOCK_THRESHOLD = 0.005; // 0.5%
  const blockingTypes: LiquidityType[] = direction === 'LONG'
    ? ['SSL', 'EQL', 'PDL']  // Lows below entry can act as obstacles for longs
    : ['BSL', 'EQH', 'PDH']; // Highs above entry can block shorts

  return levels.some((l) => {
    if (!blockingTypes.includes(l.type) || l.state !== 'ACTIVE' || l.score < 5) return false;
    const dist = Math.abs(l.level - entryPrice) / entryPrice;
    return direction === 'LONG'
      ? l.level < entryPrice && dist < BLOCK_THRESHOLD
      : l.level > entryPrice && dist < BLOCK_THRESHOLD;
  });
}

/**
 * Calculate confidence score (0-100) based on signal quality.
 *
 * Breakdown:
 *   - Bias alignment: +20 (Daily + 4H agree) or +10 (only 4H)
 *   - Sweep quality: sweepScore * 2 (max 20)
 *   - Displacement quality: displacementScore * 2 (max 20)
 *   - FVG quality: HIGH=+15, MEDIUM=+10, LOW=+5
 *   - Zone alignment: in OTE=+15, correct zone but not OTE=+10
 *   - R:R ratio: >= 3.0=+10, >= 2.0=+5
 */
function calculateConfidence(params: {
  biasFromDailyAndHour: boolean;
  sweep: Sweep;
  displacementScore: number;
  fvg: FairValueGap;
  inOTE: boolean;
  inCorrectZone: boolean;
  rrRatio: number;
}): number {
  const { biasFromDailyAndHour, sweep, displacementScore, fvg, inOTE, inCorrectZone, rrRatio } = params;

  let confidence = 0;

  // Bias alignment
  confidence += biasFromDailyAndHour ? 20 : 10;

  // Sweep quality
  confidence += Math.min(20, sweep.score * 2);

  // Displacement quality
  confidence += Math.min(20, displacementScore * 2);

  // FVG quality
  if (fvg.quality === 'HIGH') confidence += 15;
  else if (fvg.quality === 'MEDIUM') confidence += 10;
  else confidence += 5;

  // Zone alignment
  if (inOTE) confidence += 15;
  else if (inCorrectZone) confidence += 10;

  // R:R ratio
  if (rrRatio >= 3.0) confidence += 10;
  else if (rrRatio >= 2.0) confidence += 5;

  return Math.min(100, confidence);
}

// --------------- Main Function ---------------

/**
 * Detect a complete ICT trading signal from the current market context.
 *
 * Returns null if any required condition is not met.
 * Conditions are checked in order of importance.
 *
 * @param ctx - Full signal context (bias, sweeps, FVGs, structure, price)
 */
export function detectSignal(ctx: SignalContext): TradingSignal | null {
  const {
    bias, recentSweeps, fvgs, liquidityLevels,
    structureState15m, structureState5m,
    currentPrice, candles5m, candles15m, swings5m, swings15m,
  } = ctx;

  // 1. Bias must be directional
  if (bias.bias === 'NO_TRADE') {
    log.debug('detectSignal: NO_TRADE bias — skipping');
    return null;
  }

  // 2. Must be in a killzone
  if (!isKillzoneActive()) {
    log.debug('detectSignal: not in killzone — skipping');
    return null;
  }

  const direction: 'LONG' | 'SHORT' = bias.bias === 'BULLISH' ? 'LONG' : 'SHORT';
  const fvgType = direction === 'LONG' ? 'BULLISH' : 'BEARISH';

  // 3. Find qualifying sweep (score >= minScoreForTrigger)
  const qualifyingSweep = recentSweeps
    .filter((s) => s.score >= SCORING_CONFIG.sweep.minScoreForTrigger)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

  if (!qualifyingSweep) {
    log.debug('detectSignal: no qualifying sweep');
    return null;
  }

  // 4. Require confirmed SMS on 15M or 5M.
  // CHOCH alone does NOT qualify — it lacks the displacement confirmation that proves
  // the structure break is real and not a fakeout.
  const has15mSMS =
    structureState15m.lastEvent === 'SMS_BULLISH' ||
    structureState15m.lastEvent === 'SMS_BEARISH';

  const has5mSMS =
    structureState5m.lastEvent === 'SMS_BULLISH' ||
    structureState5m.lastEvent === 'SMS_BEARISH';

  if (!has15mSMS && !has5mSMS) {
    log.debug('detectSignal: no confirmed SMS on 5M or 15M (CHOCH without displacement rejected)');
    return null;
  }

  // 5. Find entry FVG
  const activeOpenFVGs = fvgs.filter(
    (f) => f.state === 'OPEN' || f.state === 'PARTIALLY_FILLED',
  );
  const entryFVG = findEntryFVG(activeOpenFVGs, fvgType);

  if (!entryFVG) {
    log.debug(`detectSignal: no entry FVG found for ${fvgType}`);
    return null;
  }

  // 6. Check zone alignment (price should be in DISCOUNT for longs, PREMIUM for shorts)
  const swingHighs = [...swings15m, ...swings5m]
    .filter((s) => s.type === 'SWING_HIGH')
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const swingLows = [...swings15m, ...swings5m]
    .filter((s) => s.type === 'SWING_LOW')
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const refHigh = swingHighs[0];
  const refLow = swingLows[0];

  let inCorrectZone = false;
  let inOTE = false;

  if (refHigh && refLow) {
    const pdState = getPremiumDiscountState(currentPrice, refHigh, refLow);
    inCorrectZone =
      (direction === 'LONG' && pdState.zone === 'DISCOUNT') ||
      (direction === 'SHORT' && pdState.zone === 'PREMIUM');
    inOTE = inCorrectZone && isInOTE(currentPrice, pdState.oteRange);
  }

  if (!inCorrectZone) {
    log.debug(`detectSignal: price ${currentPrice.toFixed(2)} not in correct zone for ${direction}`);
    return null;
  }

  // 7. Check for blocking liquidity
  const entryPrice = direction === 'LONG' ? entryFVG.ce : entryFVG.ce;
  if (hasBlockingLiquidity(liquidityLevels, direction, entryPrice)) {
    log.debug('detectSignal: blocking liquidity found — skipping');
    return null;
  }

  // 8. Calculate stop loss
  // SL = beyond the swing that caused the SMS + buffer
  const criticalSwing =
    direction === 'LONG'
      ? structureState5m.criticalSwing ?? structureState15m.criticalSwing
      : structureState5m.criticalSwing ?? structureState15m.criticalSwing;

  const slBuffer = entryPrice * RISK_CONFIG.slBufferPercent;
  const stopLoss = criticalSwing
    ? direction === 'LONG'
      ? criticalSwing.level - slBuffer   // LONG: SL below swing low
      : criticalSwing.level + slBuffer   // SHORT: SL above swing high
    : direction === 'LONG'
      ? entryFVG.bottom - slBuffer       // Fallback: below FVG bottom
      : entryFVG.top + slBuffer;

  // 9. Calculate TP1 (IRL: nearest opposing FVG or structure)
  const allFVGs = [...fvgs];
  const tp1FVG = findTP1FVG(allFVGs, direction, entryPrice);
  const tp1 = tp1FVG ?? (direction === 'LONG' ? entryFVG.top * 1.01 : entryFVG.bottom * 0.99);

  // 10. Calculate TP2 (ERL: nearest liquidity pool beyond TP1)
  const tp2Level = findTP2Level(liquidityLevels, direction, tp1);
  const tp2 = tp2Level ?? (direction === 'LONG' ? tp1 * 1.01 : tp1 * 0.99);

  // 11. Calculate R:R ratio
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(tp1 - entryPrice);
  const rrRatio = risk > 0 ? reward / risk : 0;

  if (rrRatio < RISK_CONFIG.minRR) {
    log.debug(`detectSignal: R:R too low (${rrRatio.toFixed(2)} < ${RISK_CONFIG.minRR})`);
    return null;
  }

  // 12. Score displacement quality (used for confidence)
  const dispStart = Math.max(0, candles5m.length - 11);
  const dispResult = scoreDisplacement(candles5m, dispStart, candles5m.length - 1);

  // 13. Calculate confidence — use actual bothTFAgree from bias computation
  const biasFromBothTF = bias.bothTFAgree;

  const confidence = calculateConfidence({
    biasFromDailyAndHour: biasFromBothTF,
    sweep: qualifyingSweep,
    displacementScore: dispResult.score,
    fvg: entryFVG,
    inOTE,
    inCorrectZone,
    rrRatio,
  });

  if (confidence < MIN_CONFIDENCE) {
    log.debug(`detectSignal: confidence too low (${confidence} < ${MIN_CONFIDENCE})`);
    return null;
  }

  const signal: TradingSignal = {
    direction,
    sweep: qualifyingSweep,
    entryFVG,
    stopLoss,
    tp1,
    tp2,
    rrRatio,
    displacementScore: dispResult.score,
    confidence,
  };

  log.info(
    `SIGNAL: ${direction} | Entry: ${entryPrice.toFixed(2)} | SL: ${stopLoss.toFixed(2)} | TP1: ${tp1.toFixed(2)} | TP2: ${tp2.toFixed(2)} | R:R: ${rrRatio.toFixed(1)} | Conf: ${confidence}`,
  );

  return signal;
}
