// ============================================================
// Trade Logger - Phase 3
// ============================================================
// Persists closed trades to both a local CSV file and Supabase.
// CSV path: ./logs/trades.csv (relative to project root)
// ============================================================

import fs from 'fs';
import path from 'path';
import { Trade } from '../types/index.js';
import { getSupabaseClient } from '../database/supabase.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('TradeLogger');
const CSV_PATH = path.resolve(process.cwd(), 'logs', 'trades.csv');

const CSV_HEADER = [
  'id', 'timestamp', 'direction', 'entryPrice', 'exitPrice', 'sizeUsdt', 'leverage',
  'stopLoss', 'tp1', 'tp2', 'tp1Hit', 'pnlUsdt', 'pnlPct', 'rrAchieved',
  'status', 'displacementScore', 'confidence', 'sweepId', 'fvgId', 'isPaper',
].join(',');

// --------------- Main Function ---------------

/**
 * Log a completed trade to both CSV and Supabase (in parallel).
 * Gracefully swallows errors — trade data is not lost if one sink fails.
 *
 * @param trade - The fully closed Trade object
 */
export async function logTrade(trade: Trade): Promise<void> {
  await Promise.allSettled([logToCSV(trade), logToSupabase(trade)]);
}

// --------------- CSV ---------------

/**
 * Append a trade record to the local CSV file.
 * Creates the file with headers if it doesn't exist.
 */
async function logToCSV(trade: Trade): Promise<void> {
  try {
    // Ensure logs directory exists
    fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });

    // Write header on first run
    if (!fs.existsSync(CSV_PATH)) {
      fs.writeFileSync(CSV_PATH, CSV_HEADER + '\n', 'utf8');
    }

    const row = [
      trade.id,
      trade.timestamp.toISOString(),
      trade.direction,
      trade.entryPrice?.toFixed(4) ?? '',
      trade.exitPrice?.toFixed(4) ?? '',
      trade.sizeUsdt.toFixed(2),
      trade.leverage,
      trade.stopLoss.toFixed(4),
      trade.tp1Level.toFixed(4),
      trade.tp2Level.toFixed(4),
      trade.tp1Hit ? '1' : '0',
      trade.pnlUsdt?.toFixed(4) ?? '',
      trade.pnlPct?.toFixed(4) ?? '',
      trade.rrAchieved?.toFixed(3) ?? '',
      trade.status,
      trade.displacementScore ?? '',
      '',  // confidence — not on Trade type, reserved
      trade.sweepId ?? '',
      trade.fvgId ?? '',
      trade.isPaper ? '1' : '0',
    ].join(',');

    fs.appendFileSync(CSV_PATH, row + '\n', 'utf8');
    log.debug(`Trade logged to CSV: ${trade.id}`);
  } catch (err) {
    log.warn(`CSV logging failed: ${(err as Error).message}`);
  }
}

// --------------- Supabase ---------------

/**
 * Insert a trade record into the Supabase trades table.
 * No-ops gracefully if Supabase is not configured.
 */
async function logToSupabase(trade: Trade): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return; // Supabase not configured — skip silently

  try {
    const { error } = await client.from('trades').upsert({
      id: trade.id,
      timestamp: trade.timestamp.toISOString(),
      direction: trade.direction,
      entry_price: trade.entryPrice ?? null,
      exit_price: trade.exitPrice ?? null,
      size_usdt: trade.sizeUsdt,
      leverage: trade.leverage,
      stop_loss: trade.stopLoss,
      tp1_level: trade.tp1Level,
      tp2_level: trade.tp2Level,
      tp1_hit: trade.tp1Hit,
      pnl_usdt: trade.pnlUsdt ?? null,
      pnl_pct: trade.pnlPct ?? null,
      rr_achieved: trade.rrAchieved ?? null,
      status: trade.status,
      displacement_score: trade.displacementScore ?? null,
      sweep_id: trade.sweepId ?? null,
      fvg_id: trade.fvgId ?? null,
      is_paper: trade.isPaper,
    }, { onConflict: 'id' });

    if (error) throw error;
    log.debug(`Trade logged to Supabase: ${trade.id}`);
  } catch (err) {
    log.warn(`Supabase trade logging failed: ${(err as Error).message}`);
  }
}
