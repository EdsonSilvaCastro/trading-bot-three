// ============================================================
// Order Block Detector - Phase 2
// ============================================================
// An Order Block (OB) is the last opposing candle before a
// strong displacement move. Used as an alternative entry zone.
//
// BULLISH OB: Last bearish (close < open) candle before bullish displacement
// BEARISH OB: Last bullish (close > open) candle before bearish displacement
//
// Invalidation:
//   Bullish OB: price closes BELOW the OB bottom
//   Bearish OB: price closes ABOVE the OB top
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { Candle, Timeframe } from '../types/index.js';
import { scoreDisplacement } from './displacementScorer.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('OrderBlockDetector');

export interface OrderBlock {
  id: string;
  timestamp: Date;
  timeframe: Timeframe;
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  ce: number;
  isValid: boolean;
  testedAt?: Date;
}

/** Minimum displacement score for an OB to be considered valid */
const MIN_DISPLACEMENT_SCORE = 4;

/**
 * Detect order blocks in a candle sequence.
 *
 * For each displacement move that scores >= 4:
 *   - BULLISH displacement: find the last bearish candle (close < open) before the move
 *   - BEARISH displacement: find the last bullish candle (close > open) before the move
 *
 * Only creates OBs where a qualifying displacement follows the opposing candle.
 *
 * @param candles   - Candle array (ascending time order)
 * @param timeframe - Timeframe label for detected OBs
 */
export function detectOrderBlocks(candles: Candle[], timeframe: Timeframe): OrderBlock[] {
  const orderBlocks: OrderBlock[] = [];
  if (candles.length < 5) return orderBlocks;

  // Scan with a rolling window to find displacement moves
  for (let dispEnd = 4; dispEnd < candles.length; dispEnd++) {
    const dispStart = Math.max(0, dispEnd - 5);
    const result = scoreDisplacement(candles, dispStart, dispEnd);

    if (result.score < MIN_DISPLACEMENT_SCORE) continue;

    if (result.direction === 'BULLISH') {
      // Find last BEARISH candle (close < open) before the displacement start
      let lastBearish: Candle | null = null;
      for (let j = dispStart - 1; j >= Math.max(0, dispStart - 3); j--) {
        const c = candles[j]!;
        if (c.close < c.open) {
          lastBearish = c;
          break;
        }
      }
      if (lastBearish) {
        orderBlocks.push({
          id: uuidv4(),
          timestamp: lastBearish.timestamp,
          timeframe,
          type: 'BULLISH',
          top: lastBearish.high,
          bottom: lastBearish.low,
          ce: (lastBearish.high + lastBearish.low) / 2,
          isValid: true,
        });
      }
    } else {
      // Find last BULLISH candle (close > open) before the displacement start
      let lastBullish: Candle | null = null;
      for (let j = dispStart - 1; j >= Math.max(0, dispStart - 3); j--) {
        const c = candles[j]!;
        if (c.close > c.open) {
          lastBullish = c;
          break;
        }
      }
      if (lastBullish) {
        orderBlocks.push({
          id: uuidv4(),
          timestamp: lastBullish.timestamp,
          timeframe,
          type: 'BEARISH',
          top: lastBullish.high,
          bottom: lastBullish.low,
          ce: (lastBullish.high + lastBullish.low) / 2,
          isValid: true,
        });
      }
    }
  }

  // Deduplicate by timestamp (same candle can only produce one OB)
  const seen = new Set<number>();
  const unique = orderBlocks.filter((ob) => {
    const key = ob.timestamp.getTime();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  log.debug(`detectOrderBlocks [${timeframe}]: ${unique.length} order blocks found`);
  return unique;
}

/**
 * Invalidate order blocks where price has closed through the zone.
 *
 * @param orderBlocks - Existing order blocks
 * @param recentCandles - Recent candles to check for invalidation
 */
export function updateOrderBlockValidity(
  orderBlocks: OrderBlock[],
  recentCandles: Candle[],
): OrderBlock[] {
  return orderBlocks.map((ob) => {
    if (!ob.isValid) return ob;

    for (const candle of recentCandles) {
      const invalidated =
        ob.type === 'BULLISH'
          ? candle.close < ob.bottom // Bullish OB broken: close below bottom
          : candle.close > ob.top;   // Bearish OB broken: close above top

      if (invalidated) {
        log.debug(`OB [${ob.type}] @ ${ob.bottom.toFixed(2)}-${ob.top.toFixed(2)} invalidated`);
        return { ...ob, isValid: false };
      }

      // Mark as tested if price entered but didn't close through
      const tested =
        ob.type === 'BULLISH'
          ? candle.low <= ob.top && candle.close > ob.bottom
          : candle.high >= ob.bottom && candle.close < ob.top;

      if (tested && !ob.testedAt) {
        return { ...ob, testedAt: candle.timestamp };
      }
    }

    return ob;
  });
}
