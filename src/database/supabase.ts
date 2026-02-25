// ============================================================
// Supabase Client & Query Helpers
// ============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Candle, Swing, Timeframe } from '../types/index.js';

let supabaseInstance: SupabaseClient | null = null;

/**
 * Initialize and return the Supabase client (singleton).
 * Returns null if env vars are not configured.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseInstance) return supabaseInstance;

  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_ANON_KEY'];

  if (!url || !key) {
    return null;
  }

  supabaseInstance = createClient(url, key, {
    auth: { persistSession: false },
  });

  return supabaseInstance;
}

/**
 * Upsert candles into the database.
 * On conflict (timestamp + timeframe), does nothing.
 */
export async function insertCandles(candles: Candle[]): Promise<void> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const rows = candles.map((c) => ({
    timestamp: c.timestamp.toISOString(),
    timeframe: c.timeframe,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  const { error } = await client
    .from('candles')
    .upsert(rows, { onConflict: 'timestamp,timeframe', ignoreDuplicates: true });

  if (error) throw new Error(`insertCandles failed: ${error.message}`);
}

/**
 * Fetch candles for a given timeframe, ordered DESC by timestamp.
 * Optionally filter by a 'before' date.
 */
export async function getCandles(
  timeframe: Timeframe,
  limit: number,
  before?: Date,
): Promise<Candle[]> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  let query = client
    .from('candles')
    .select('*')
    .eq('timeframe', timeframe)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt('timestamp', before.toISOString());
  }

  const { data, error } = await query;
  if (error) throw new Error(`getCandles failed: ${error.message}`);

  return (data ?? []).map(rowToCandle).reverse(); // Return ascending order
}

/**
 * Get the most recent candle for a timeframe.
 */
export async function getLatestCandle(timeframe: Timeframe): Promise<Candle | null> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const { data, error } = await client
    .from('candles')
    .select('*')
    .eq('timeframe', timeframe)
    .order('timestamp', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // No rows found
    throw new Error(`getLatestCandle failed: ${error.message}`);
  }

  return data ? rowToCandle(data) : null;
}

/**
 * Insert a single detected swing point.
 */
export async function insertSwing(swing: Swing): Promise<void> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const { error } = await client.from('swings').insert({
    id: swing.id,
    timestamp: swing.timestamp.toISOString(),
    timeframe: swing.timeframe,
    type: swing.type,
    level: swing.level,
    method: swing.method,
    is_valid: swing.isValid,
    candle_index: swing.candleIndex,
  });

  if (error) throw new Error(`insertSwing failed: ${error.message}`);
}

/**
 * Fetch recent swings for a given timeframe.
 */
export async function getSwings(timeframe: Timeframe, limit: number): Promise<Swing[]> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase not configured');

  const { data, error } = await client
    .from('swings')
    .select('*')
    .eq('timeframe', timeframe)
    .eq('is_valid', true)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`getSwings failed: ${error.message}`);

  return (data ?? []).map(rowToSwing);
}

// --------------- Row Mappers ---------------

function rowToCandle(row: Record<string, unknown>): Candle {
  return {
    timestamp: new Date(row['timestamp'] as string),
    timeframe: row['timeframe'] as Timeframe,
    open: Number(row['open']),
    high: Number(row['high']),
    low: Number(row['low']),
    close: Number(row['close']),
    volume: Number(row['volume']),
  };
}

function rowToSwing(row: Record<string, unknown>): Swing {
  return {
    id: row['id'] as string,
    timestamp: new Date(row['timestamp'] as string),
    timeframe: row['timeframe'] as Timeframe,
    type: row['type'] as 'SWING_HIGH' | 'SWING_LOW',
    level: Number(row['level']),
    method: (row['method'] as string ?? 'ICT_N3') as 'ICT_N3' | 'PIVOT_N3',
    isValid: Boolean(row['is_valid']),
    candleIndex: Number(row['candle_index']),
  };
}
