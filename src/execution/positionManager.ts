// ============================================================
// Position Manager - PLACEHOLDER (Phase 4)
// ============================================================
// Monitors and manages open positions:
//   - Track position PnL in real-time
//   - Trigger partial close at TP1
//   - Move stop loss to breakeven after TP1
//   - Handle full close at TP2 or stop loss
// ============================================================

import { Trade } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('PositionManager');

/**
 * @phase Phase 4
 * Get the current open position from Bybit (if any).
 */
export async function getCurrentPosition(_symbol: string): Promise<Trade | null> {
  log.debug('getCurrentPosition — not implemented yet (Phase 4)');
  return null;
}

/**
 * @phase Phase 4
 * Close a percentage of an open position.
 */
export async function closePartialPosition(
  _symbol: string,
  _percent: number,
): Promise<boolean> {
  log.debug('closePartialPosition — not implemented yet (Phase 4)');
  return false;
}
