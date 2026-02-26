// ============================================================
// Premium/Discount Zone Calculator - Phase 2
// ============================================================
// ICT uses Fibonacci-based premium/discount zones:
//   - DISCOUNT zone: 0% to 50% of the swing range (BUY zone)
//   - PREMIUM zone: 50% to 100% of the swing range (SELL zone)
//   - OTE (Optimal Trade Entry): Fibonacci 0.618 to 0.79 retracement
//
// In bullish bias: look to BUY from DISCOUNT (below 50% of range)
// In bearish bias: look to SELL from PREMIUM (above 50% of range)
// ============================================================

import { PremiumDiscountZone, Swing } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('PremiumDiscount');

export type { PremiumDiscountZone };

export interface PremiumDiscountState {
  zone: PremiumDiscountZone;
  equilibrium: number;   // 50% level (EQ)
  depth: number;         // 0-1: how deep in zone (0 = near EQ, 1 = at extreme)
  oteRange: { high: number; low: number }; // OTE zone for bullish entries (62-79% retracement)
}

/**
 * Determine if current price is in premium or discount relative to a swing range,
 * and compute the Optimal Trade Entry (OTE) zone.
 *
 * OTE is based on Fibonacci retracement levels 0.618-0.79:
 *   For BULLISH OTE (buying the discount):
 *     OTE high = swingLow + range * 0.382  (61.8% retracement = 38.2% from low)
 *     OTE low  = swingLow + range * 0.21   (79% retracement = 21% from low)
 *
 * @param currentPrice - Current market price
 * @param swingHigh    - Reference swing high (defines the range top)
 * @param swingLow     - Reference swing low (defines the range bottom)
 */
export function getPremiumDiscountState(
  currentPrice: number,
  swingHigh: Swing,
  swingLow: Swing,
): PremiumDiscountState {
  const range = swingHigh.level - swingLow.level;

  if (range <= 0) {
    log.debug('getPremiumDiscountState: invalid range (swingHigh <= swingLow)');
    return { zone: 'DISCOUNT', equilibrium: swingLow.level, depth: 0, oteRange: { high: 0, low: 0 } };
  }

  const equilibrium = (swingHigh.level + swingLow.level) / 2;
  const zone: PremiumDiscountZone = currentPrice >= equilibrium ? 'PREMIUM' : 'DISCOUNT';

  // Depth: 0 = at equilibrium, 1 = at the extreme
  const depth =
    zone === 'PREMIUM'
      ? Math.min(1, (currentPrice - equilibrium) / (swingHigh.level - equilibrium))
      : Math.min(1, (equilibrium - currentPrice) / (equilibrium - swingLow.level));

  // OTE range: Fibonacci 0.618-0.79 retracement from swing high (bullish entry zone)
  // When price retraces 61.8-79% of the up-move, that's where smart money buys
  const oteRange = {
    high: swingLow.level + range * 0.382, // 61.8% retracement from high = 38.2% from low
    low: swingLow.level + range * 0.21,   // 79% retracement from high = 21% from low
  };

  log.debug(
    `PremiumDiscount: price=${currentPrice.toFixed(2)} zone=${zone} depth=${depth.toFixed(2)} eq=${equilibrium.toFixed(2)}`,
  );

  return { zone, equilibrium, depth, oteRange };
}

/**
 * Calculate the equilibrium (50%) of a price range.
 *
 * @param high - Range high
 * @param low  - Range low
 */
export function getEquilibrium(high: number, low: number): number {
  return (high + low) / 2;
}

/**
 * Check if a price is within the OTE (Optimal Trade Entry) zone.
 *
 * @param price    - Price to test
 * @param oteRange - OTE range from getPremiumDiscountState
 */
export function isInOTE(price: number, oteRange: { high: number; low: number }): boolean {
  return price >= oteRange.low && price <= oteRange.high;
}
