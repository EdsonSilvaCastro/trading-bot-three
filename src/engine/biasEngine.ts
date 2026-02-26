// ============================================================
// Bias Engine - Phase 2
// ============================================================
// The ICT B1/B2/B3 Framework for determining daily bias:
//
//   B1 (Framework): Is price in retracement or expansion mode?
//   B2 (Draw): Where is price likely going? (nearest liquidity)
//   B3 (Zone): Where should we look for entries? (P/D zone)
//
// AMD Phase detection (Power of 3):
//   ACCUMULATION → MANIPULATION (Judas swing) → DISTRIBUTION
// ============================================================

import {
  DailyBias,
  BiasDirection,
  FrameworkState,
  AMDPhase,
  PremiumDiscountZone,
  LiquidityLevel,
  LiquidityType,
  Session,
  Candle,
  Swing,
} from '../types/index.js';
import { NO_TRADE_SESSIONS } from '../config/sessions.js';
import { analyzeStructure } from '../analyzer/marketStructure.js';
import { getEquilibrium } from '../analyzer/premiumDiscount.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('BiasEngine');

export type { DailyBias, BiasDirection };

// --------------- Context ---------------

export interface BiasContext {
  dailyCandles: Candle[];
  fourHourCandles: Candle[];
  dailySwings: Swing[];
  fourHourSwings: Swing[];
  liquidityLevels: LiquidityLevel[];
  currentPrice: number;
  currentSession: Session | null;
}

// --------------- Helpers ---------------

/**
 * Determine the B1 framework state from the 4H structure.
 * RETRACEMENT_EXPECTED: a recent SMS or BMS event means price should pull back.
 * EXPANSION_EXPECTED: trending cleanly, no recent event = price should continue.
 * WAITING_FOR_SWEEP: structure is unclear or in transition.
 */
function determineFramework(swings4h: Swing[], candles4h: Candle[]): FrameworkState {
  const structure = analyzeStructure(candles4h, swings4h);

  if (structure.trend === 'UNDEFINED' || structure.trend === 'TRANSITION') {
    return 'WAITING_FOR_SWEEP';
  }

  // Check if a recent BMS/SMS-like event happened (last event was a new HH or LL)
  const sorted = [...swings4h].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const recentSwing = sorted[0];
  if (!recentSwing) return 'WAITING_FOR_SWEEP';

  const ageHours = (Date.now() - recentSwing.timestamp.getTime()) / (3_600_000);

  // If a swing was formed recently (< 40 hours = ~10 4H candles), expect retracement
  if (ageHours < 40) return 'RETRACEMENT_EXPECTED';

  return 'EXPANSION_EXPECTED';
}

const BULLISH_DRAW_TYPES: LiquidityType[] = ['BSL', 'EQH', 'PDH', 'PWH', 'SESSION_HIGH'];
const BEARISH_DRAW_TYPES: LiquidityType[] = ['SSL', 'EQL', 'PDL', 'PWL', 'SESSION_LOW'];

/**
 * B2: Find the nearest significant liquidity target in the bias direction.
 * Prioritizes higher-scored levels that are closest to price.
 */
function findDrawOnLiquidity(
  levels: LiquidityLevel[],
  bias: BiasDirection,
  currentPrice: number,
): { b2DrawLevel: number; b2DrawType: LiquidityType } {
  const fallback = bias === 'BULLISH'
    ? { b2DrawLevel: 0, b2DrawType: 'BSL' as LiquidityType }
    : { b2DrawLevel: 0, b2DrawType: 'SSL' as LiquidityType };

  if (bias === 'NO_TRADE') return fallback;

  const relevantTypes = bias === 'BULLISH' ? BULLISH_DRAW_TYPES : BEARISH_DRAW_TYPES;

  const candidates = levels.filter(
    (l) =>
      l.state === 'ACTIVE' &&
      relevantTypes.includes(l.type) &&
      (bias === 'BULLISH' ? l.level > currentPrice : l.level < currentPrice),
  );

  if (candidates.length === 0) return fallback;

  // Weight: prefer closer levels, break ties by score
  const nearest = candidates.reduce((best, curr) => {
    const currDist = Math.abs(curr.level - currentPrice);
    const bestDist = Math.abs(best.level - currentPrice);
    // Prefer closer unless other has significantly higher score
    if (curr.score - best.score >= 3 && currDist < bestDist * 3) return curr;
    return currDist < bestDist ? curr : best;
  });

  return { b2DrawLevel: nearest.level, b2DrawType: nearest.type };
}

/**
 * B3: Determine current premium/discount zone from the 4H dealing range.
 */
function determineZone(
  currentPrice: number,
  swings4h: Swing[],
): { b3Zone: PremiumDiscountZone; b3Depth: number } {
  const highs = swings4h.filter((s) => s.type === 'SWING_HIGH');
  const lows = swings4h.filter((s) => s.type === 'SWING_LOW');

  if (highs.length === 0 || lows.length === 0) {
    return { b3Zone: 'DISCOUNT', b3Depth: 0 };
  }

  // Use the most recent swing high and low to define the dealing range
  const lastHigh = highs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]!;
  const lastLow = lows.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]!;

  const equilibrium = getEquilibrium(lastHigh.level, lastLow.level);
  const zone: PremiumDiscountZone = currentPrice >= equilibrium ? 'PREMIUM' : 'DISCOUNT';

  const range = lastHigh.level - lastLow.level;
  const depth =
    range > 0
      ? zone === 'PREMIUM'
        ? Math.min(1, (currentPrice - equilibrium) / (lastHigh.level - equilibrium))
        : Math.min(1, (equilibrium - currentPrice) / (equilibrium - lastLow.level))
      : 0;

  return { b3Zone: zone, b3Depth: depth };
}

/**
 * AMD Phase Detection (Power of 3):
 * ACCUMULATION → MANIPULATION (Judas swing) → DISTRIBUTION
 *
 * Based on session timing and price vs daily open.
 */
function determineAMDPhase(
  fourHourCandles: Candle[],
  currentPrice: number,
  currentSession: Session | null,
  bias: BiasDirection,
): AMDPhase {
  if (!currentSession) return 'ACCUMULATION';

  // Get today's approximate daily open (first 4H candle of the day)
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayCandles = fourHourCandles.filter((c) => c.timestamp >= todayStart);
  const dailyOpen = todayCandles.length > 0 ? todayCandles[0]!.open : currentPrice;

  const { name } = currentSession;

  // Asian session = accumulation (price building range)
  if (name === 'ASIAN') return 'ACCUMULATION';

  // London / London-to-NY: check for Judas swing (manipulation)
  if (name === 'LONDON' || name === 'LONDON_TO_NY') {
    const judas_threshold = dailyOpen * 0.003; // 0.3% move considered manipulation
    if (bias === 'BULLISH' && currentPrice < dailyOpen - judas_threshold) {
      return 'MANIPULATION'; // Bullish day: London dip below open = Judas swing down
    }
    if (bias === 'BEARISH' && currentPrice > dailyOpen + judas_threshold) {
      return 'MANIPULATION'; // Bearish day: London spike above open = Judas swing up
    }
    return 'ACCUMULATION';
  }

  // NY Morning = distribution (primary killzone, trending move)
  if (name === 'NY_MORNING') return 'DISTRIBUTION';

  // NY Afternoon = distribution or accumulation for next move
  if (name === 'NY_AFTERNOON') return 'DISTRIBUTION';

  return 'ACCUMULATION';
}

// --------------- Main Function ---------------

/**
 * Compute the daily bias using the ICT B1/B2/B3 framework.
 *
 * Bias direction logic:
 *   1. Get 4H structure trend
 *   2. Get Daily structure trend
 *   3. Both agree → use that direction
 *   4. Disagree → NO_TRADE (conflicting signals)
 *   5. Daily UNDEFINED → use 4H only
 *   6. Override to NO_TRADE if: in no-trade session OR 4H is TRANSITION
 *
 * @param ctx - Full context with candles, swings, levels, and session info
 */
export function computeDailyBias(ctx: BiasContext): DailyBias {
  const { dailyCandles, fourHourCandles, dailySwings, fourHourSwings, liquidityLevels, currentPrice, currentSession } = ctx;

  // Analyze structure on both timeframes
  const structure4h = analyzeStructure(fourHourCandles, fourHourSwings);
  const structureDaily = analyzeStructure(dailyCandles, dailySwings);

  // Determine bias direction
  let bias: BiasDirection = 'NO_TRADE';
  const trend4h = structure4h.trend;
  const trendDaily = structureDaily.trend;

  if (trend4h === 'BULLISH') {
    if (trendDaily === 'BULLISH' || trendDaily === 'UNDEFINED') bias = 'BULLISH';
    else bias = 'NO_TRADE'; // Daily disagrees
  } else if (trend4h === 'BEARISH') {
    if (trendDaily === 'BEARISH' || trendDaily === 'UNDEFINED') bias = 'BEARISH';
    else bias = 'NO_TRADE';
  }
  // TRANSITION or UNDEFINED 4H → NO_TRADE
  if (trend4h === 'TRANSITION' || trend4h === 'UNDEFINED') bias = 'NO_TRADE';

  // Override if in no-trade session
  if (currentSession && (NO_TRADE_SESSIONS as string[]).includes(currentSession.name)) {
    bias = 'NO_TRADE';
  }

  // B1: Framework state
  const b1Framework = determineFramework(fourHourSwings, fourHourCandles);

  // B2: Draw on liquidity
  const { b2DrawLevel, b2DrawType } = findDrawOnLiquidity(liquidityLevels, bias, currentPrice);

  // B3: Premium/Discount zone
  const { b3Zone, b3Depth } = determineZone(currentPrice, fourHourSwings);

  // AMD Phase
  const amdPhase = determineAMDPhase(fourHourCandles, currentPrice, currentSession, bias);

  log.info(
    `Bias: ${bias} | 4H=${trend4h} Daily=${trendDaily} | B1=${b1Framework} | AMD=${amdPhase} | Zone=${b3Zone}`,
  );

  return {
    date: new Date(),
    b1Framework,
    b2DrawLevel,
    b2DrawType,
    b3Zone,
    b3Depth,
    bias,
    amdPhase,
  };
}

/**
 * Determine if the current bias aligns with a potential trade direction.
 *
 * @param bias          - Current daily bias
 * @param tradeDirection - Proposed trade direction
 */
export function isBiasAligned(bias: DailyBias, tradeDirection: 'LONG' | 'SHORT'): boolean {
  if (bias.bias === 'NO_TRADE') return false;
  if (tradeDirection === 'LONG') return bias.bias === 'BULLISH';
  if (tradeDirection === 'SHORT') return bias.bias === 'BEARISH';
  return false;
}
