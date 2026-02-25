// ============================================================
// Order Block Detector - PLACEHOLDER (Phase 3)
// ============================================================
// An Order Block (OB) is the last opposing candle before a
// strong displacement move. It's used as an alternative entry
// zone when no FVG is available.
//
// BULLISH OB: Last bearish (red) candle before a bullish displacement
// BEARISH OB: Last bullish (green) candle before a bearish displacement
// ============================================================

import { Candle, Timeframe } from '../types/index.js';
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

/**
 * @phase Phase 3
 * Detect order blocks in a candle sequence.
 */
export function detectOrderBlocks(
  _candles: Candle[],
  _timeframe: Timeframe,
): OrderBlock[] {
  log.debug('detectOrderBlocks — not implemented yet (Phase 3)');
  return [];
}
