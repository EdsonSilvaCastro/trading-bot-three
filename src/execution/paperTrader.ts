// ============================================================
// Paper Trader - PLACEHOLDER (Phase 3)
// ============================================================
// Simulates trade execution without real orders:
//   - Tracks simulated positions in Supabase
//   - Applies realistic slippage model
//   - Computes PnL at TP1, TP2, and stop loss
//   - Generates performance metrics
// ============================================================

import { Trade, TradeDirection } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('PaperTrader');

/**
 * @phase Phase 3
 * Open a paper trade (no real order placed).
 */
export async function openPaperTrade(
  _direction: TradeDirection,
  _entryPrice: number,
  _stopLoss: number,
  _tp1: number,
  _tp2: number,
  _sizeUsdt: number,
): Promise<Trade | null> {
  log.debug('openPaperTrade — not implemented yet (Phase 3)');
  return null;
}

/**
 * @phase Phase 3
 * Update paper trade status based on current price.
 */
export async function updatePaperTrade(
  _trade: Trade,
  _currentPrice: number,
): Promise<Trade> {
  log.debug('updatePaperTrade — not implemented yet (Phase 3)');
  return _trade;
}
