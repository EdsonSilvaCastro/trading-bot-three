// ============================================================
// Swing Detector - ICT N=3 Method
// ============================================================
// A swing is confirmed when N candles on both sides are lower (high)
// or higher (low) than the center candle.
//
// ICT N=3 rule:
//   SWING HIGH at i: candle[i].high > candle[i±1..3].high
//   SWING LOW  at i: candle[i].low  < candle[i±1..3].low
//
// IMPORTANT: The last 3 candles in any array can never be confirmed
// because we need 3 candles to the right. The detector handles this
// lag gracefully by stopping at index (len - N - 1).
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { Candle, Swing, SwingMethod, Timeframe } from '../types/index.js';
import { insertSwing, getSwings } from '../database/supabase.js';
import { SCORING_CONFIG } from '../config/scoring.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('SwingDetector');
const DEFAULT_N = SCORING_CONFIG.swing.defaultN; // 3

/**
 * Check if candle at index `i` is a swing high using N candles each side.
 */
function isSwingHigh(candles: Candle[], i: number, n: number): boolean {
  const center = candles[i]!.high;
  for (let offset = 1; offset <= n; offset++) {
    if (candles[i - offset]!.high >= center) return false;
    if (candles[i + offset]!.high >= center) return false;
  }
  return true;
}

/**
 * Check if candle at index `i` is a swing low using N candles each side.
 */
function isSwingLow(candles: Candle[], i: number, n: number): boolean {
  const center = candles[i]!.low;
  for (let offset = 1; offset <= n; offset++) {
    if (candles[i - offset]!.low <= center) return false;
    if (candles[i + offset]!.low <= center) return false;
  }
  return true;
}

/**
 * Detect all swing highs and lows in a candle array using the ICT N=3 method.
 *
 * Requires minimum 2*N+1 candles (7 for default N=3).
 * The last N candles cannot be confirmed — this is handled automatically.
 *
 * @param candles - Array of candles in ascending time order
 * @param method  - Detection method (default: ICT_N3)
 * @param n       - Number of candles required each side (default: 3)
 * @returns Array of confirmed swing points
 */
export function detectSwings(
  candles: Candle[],
  method: SwingMethod = 'ICT_N3',
  n = DEFAULT_N,
): Swing[] {
  const minRequired = 2 * n + 1;
  if (candles.length < minRequired) {
    log.debug(`Not enough candles for swing detection: ${candles.length} < ${minRequired}`);
    return [];
  }

  const swings: Swing[] = [];

  // Start at index n, stop at length-n-1 (need n candles to the right)
  for (let i = n; i < candles.length - n; i++) {
    const candle = candles[i]!;

    if (isSwingHigh(candles, i, n)) {
      swings.push({
        id: uuidv4(),
        timestamp: candle.timestamp,
        timeframe: candle.timeframe,
        type: 'SWING_HIGH',
        level: candle.high,
        method,
        isValid: true,
        candleIndex: i,
      });
    }

    if (isSwingLow(candles, i, n)) {
      swings.push({
        id: uuidv4(),
        timestamp: candle.timestamp,
        timeframe: candle.timeframe,
        type: 'SWING_LOW',
        level: candle.low,
        method,
        isValid: true,
        candleIndex: i,
      });
    }
  }

  log.debug(`Detected ${swings.length} swings from ${candles.length} candles`);
  return swings;
}

/**
 * Detect only NEW swings not already present in existingSwings.
 * Comparison is done by timestamp + type to avoid duplicates.
 *
 * @param candles       - Full candle array (ascending time order)
 * @param existingSwings - Already known swings to deduplicate against
 * @returns Only newly detected swings
 */
export function detectNewSwings(candles: Candle[], existingSwings: Swing[]): Swing[] {
  const allDetected = detectSwings(candles);

  // Build a Set of existing keys for O(1) lookup
  const existingKeys = new Set(
    existingSwings.map((s) => `${s.timestamp.getTime()}_${s.type}`),
  );

  const newSwings = allDetected.filter((s) => {
    const key = `${s.timestamp.getTime()}_${s.type}`;
    return !existingKeys.has(key);
  });

  log.debug(`New swings: ${newSwings.length} (total detected: ${allDetected.length})`);
  return newSwings;
}

/**
 * Fetch the most recent confirmed swings for a timeframe from the database.
 *
 * @param timeframe - Timeframe to query
 * @param limit     - Maximum number of swings to return
 */
export async function getLatestSwings(timeframe: Timeframe, limit: number): Promise<Swing[]> {
  return getSwings(timeframe, limit);
}

/**
 * Detect new swings and persist them to the database.
 * Gracefully handles DB unavailability.
 *
 * @param candles        - Candles to analyze
 * @param existingSwings - Already persisted swings (to avoid duplicates)
 * @returns Newly detected and persisted swings
 */
export async function detectAndStoreSwings(
  candles: Candle[],
  existingSwings: Swing[],
): Promise<Swing[]> {
  const newSwings = detectNewSwings(candles, existingSwings);

  if (newSwings.length === 0) {
    log.debug('No new swings detected');
    return [];
  }

  log.info(`Storing ${newSwings.length} new swing(s)`);
  const stored: Swing[] = [];

  for (const swing of newSwings) {
    try {
      await insertSwing(swing);
      stored.push(swing);
      log.info(
        `[${swing.timeframe}] ${swing.type} @ ${swing.level.toFixed(2)} (${swing.timestamp.toISOString()})`,
      );
    } catch (err) {
      log.warn(`Could not store swing: ${(err as Error).message}`);
      stored.push(swing); // Still return it even if DB insert failed
    }
  }

  return stored;
}
