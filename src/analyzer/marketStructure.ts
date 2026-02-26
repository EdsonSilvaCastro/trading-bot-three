// ============================================================
// Market Structure Analyzer - Phase 2
// ============================================================
// Analyzes swing sequences to determine:
//   - Current trend (HH/HL = bullish, LH/LL = bearish)
//   - BMS (Break of Market Structure): trend continuation
//   - CHOCH (Change of Character): first warning of trend change
//   - SMS (Shift in Market Structure): CHOCH + displacement = entry trigger
//
// ICT: "A break of structure should be with a candle body close."
// ============================================================

import { Candle, Swing, StructureState, StructureEvent, Timeframe } from '../types/index.js';
import { SCORING_CONFIG } from '../config/scoring.js';
import { scoreDisplacement } from './displacementScorer.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('MarketStructure');

export type { StructureState, StructureEvent };

/**
 * Build the full structure state from a sequence of swings.
 *
 * Uses the last two swing highs and last two swing lows to determine:
 *   - BULLISH: Higher High (HH) + Higher Low (HL) pattern
 *   - BEARISH: Lower High (LH) + Lower Low (LL) pattern
 *   - TRANSITION: Mixed signals (HH+LL or LH+HL)
 *   - UNDEFINED: Not enough swings (< 2 of each type)
 *
 * criticalSwing = the swing that, if closed beyond, signals CHOCH:
 *   - In BULLISH trend: criticalSwing = last HL (break below = CHOCH_BEARISH)
 *   - In BEARISH trend: criticalSwing = last LH (break above = CHOCH_BULLISH)
 *
 * @param _candles - Candle array (reserved for future use)
 * @param swings   - All detected swings for this timeframe (ascending time order)
 */
export function analyzeStructure(_candles: Candle[], swings: Swing[]): StructureState {
  const empty: StructureState = {
    trend: 'UNDEFINED',
    lastHH: null,
    lastHL: null,
    lastLH: null,
    lastLL: null,
    criticalSwing: null,
    lastEvent: 'NONE',
  };

  const sorted = [...swings].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const highs = sorted.filter((s) => s.type === 'SWING_HIGH');
  const lows = sorted.filter((s) => s.type === 'SWING_LOW');

  if (highs.length < 2 || lows.length < 2) {
    log.debug(`analyzeStructure: insufficient swings (${highs.length} highs, ${lows.length} lows)`);
    return empty;
  }

  // Classify each swing high relative to the previous
  let lastHH: Swing | null = null;
  let lastLH: Swing | null = null;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i]!.level > highs[i - 1]!.level) {
      lastHH = highs[i]!;
    } else {
      lastLH = highs[i]!;
    }
  }

  // Classify each swing low relative to the previous
  let lastHL: Swing | null = null;
  let lastLL: Swing | null = null;
  for (let i = 1; i < lows.length; i++) {
    if (lows[i]!.level > lows[i - 1]!.level) {
      lastHL = lows[i]!;
    } else {
      lastLL = lows[i]!;
    }
  }

  // Determine trend from most recent pair
  const isHH = highs[highs.length - 1]!.level > highs[highs.length - 2]!.level;
  const isHL = lows[lows.length - 1]!.level > lows[lows.length - 2]!.level;

  let trend: StructureState['trend'] = 'TRANSITION';
  if (isHH && isHL) trend = 'BULLISH';
  else if (!isHH && !isHL) trend = 'BEARISH';

  // Critical swing to watch for CHOCH
  let criticalSwing: Swing | null = null;
  if (trend === 'BULLISH') criticalSwing = lastHL;
  else if (trend === 'BEARISH') criticalSwing = lastLH;

  log.debug(
    `analyzeStructure: trend=${trend} | HH=${lastHH?.level.toFixed(2) ?? 'n/a'} HL=${lastHL?.level.toFixed(2) ?? 'n/a'} LH=${lastLH?.level.toFixed(2) ?? 'n/a'} LL=${lastLL?.level.toFixed(2) ?? 'n/a'}`,
  );

  return { trend, lastHH, lastHL, lastLH, lastLL, criticalSwing, lastEvent: 'NONE' };
}

/**
 * Check if the latest candle constitutes a Break of Market Structure or CHOCH.
 *
 * BMS (trend continuation):
 *   - BMS_BULLISH: BULLISH trend, candle closes ABOVE last HH
 *   - BMS_BEARISH: BEARISH trend, candle closes BELOW last LL
 *
 * CHOCH (Change of Character — first warning of reversal):
 *   - CHOCH_BULLISH: BEARISH trend, candle closes ABOVE criticalSwing (last LH)
 *   - CHOCH_BEARISH: BULLISH trend, candle closes BELOW criticalSwing (last HL)
 *
 * @param candle - Latest closed candle
 * @param state  - Current structure state from analyzeStructure
 */
export function detectBMS(candle: Candle, state: StructureState): StructureEvent {
  if (state.trend === 'UNDEFINED' || state.trend === 'TRANSITION') return 'NONE';

  if (state.trend === 'BULLISH') {
    // CHOCH has priority: close below HL = change of character
    if (state.criticalSwing && candle.close < state.criticalSwing.level) {
      log.debug(`CHOCH_BEARISH: close ${candle.close.toFixed(2)} < HL ${state.criticalSwing.level.toFixed(2)}`);
      return 'CHOCH_BEARISH';
    }
    // BMS continuation: close above last HH
    if (state.lastHH && candle.close > state.lastHH.level) {
      log.debug(`BMS_BULLISH: close ${candle.close.toFixed(2)} > HH ${state.lastHH.level.toFixed(2)}`);
      return 'BMS_BULLISH';
    }
  }

  if (state.trend === 'BEARISH') {
    // CHOCH has priority: close above LH = change of character
    if (state.criticalSwing && candle.close > state.criticalSwing.level) {
      log.debug(`CHOCH_BULLISH: close ${candle.close.toFixed(2)} > LH ${state.criticalSwing.level.toFixed(2)}`);
      return 'CHOCH_BULLISH';
    }
    // BMS continuation: close below last LL
    if (state.lastLL && candle.close < state.lastLL.level) {
      log.debug(`BMS_BEARISH: close ${candle.close.toFixed(2)} < LL ${state.lastLL.level.toFixed(2)}`);
      return 'BMS_BEARISH';
    }
  }

  return 'NONE';
}

/**
 * Detect a Shift in Market Structure (SMS) — THE primary entry trigger.
 *
 * SMS = CHOCH + displacement score >= minScoreForSMS (default 6).
 * A CHOCH without sufficient displacement remains a CHOCH.
 * Displacement is measured over the most recent ~10 candles (the impulse leg).
 *
 * @param timeframe - Timeframe being analyzed (for logging)
 * @param candles   - Full candle array
 * @param swings    - All detected swings
 */
export function detectSMS(
  timeframe: Timeframe,
  candles: Candle[],
  swings: Swing[],
): StructureEvent {
  if (candles.length < 5) return 'NONE';

  const state = analyzeStructure(candles, swings);
  if (state.trend === 'UNDEFINED' || state.trend === 'TRANSITION') return 'NONE';

  const latestCandle = candles[candles.length - 1]!;
  const event = detectBMS(latestCandle, state);

  // SMS only upgrades CHOCH events, not plain BMS continuations
  if (event !== 'CHOCH_BULLISH' && event !== 'CHOCH_BEARISH') return event;

  // Measure displacement over the impulse move that caused the CHOCH (~last 10 candles)
  const dispStart = Math.max(0, candles.length - 11);
  const dispResult = scoreDisplacement(candles, dispStart, candles.length - 1);

  if (dispResult.score >= SCORING_CONFIG.displacement.minScoreForSMS) {
    const smsEvent: StructureEvent = event === 'CHOCH_BULLISH' ? 'SMS_BULLISH' : 'SMS_BEARISH';
    log.info(
      `[${timeframe}] SMS: ${smsEvent} | displacement=${dispResult.score}/10 | direction=${dispResult.direction}`,
    );
    return smsEvent;
  }

  log.debug(
    `[${timeframe}] ${event} insufficient displacement (${dispResult.score}/${SCORING_CONFIG.displacement.minScoreForSMS}) — stays CHOCH`,
  );
  return event;
}
