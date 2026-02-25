// ============================================================
// Candle Collector - Fetches OHLCV from Bybit REST API v5
// ============================================================

import axios from 'axios';
import { Candle, Timeframe, BybitKlineResponse } from '../types/index.js';
import { TIMEFRAMES } from '../config/timeframes.js';
import { insertCandles, getLatestCandle } from '../database/supabase.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('CandleCollector');

const BYBIT_BASE_URL = process.env['BYBIT_TESTNET'] === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';

const SYMBOL = process.env['SYMBOL'] ?? 'BTCUSDT';
const RATE_LIMIT_DELAY_MS = 100;
const MAX_RETRIES = 3;

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse Bybit kline list into Candle objects.
 * Bybit returns: [startTime, open, high, low, close, volume, turnover]
 * Timestamps are milliseconds since epoch as strings.
 */
function parseKlines(rawList: string[][], timeframe: Timeframe): Candle[] {
  return rawList.map((row) => ({
    timestamp: new Date(parseInt(row[0]!, 10)),
    timeframe,
    open: parseFloat(row[1]!),
    high: parseFloat(row[2]!),
    low: parseFloat(row[3]!),
    close: parseFloat(row[4]!),
    volume: parseFloat(row[5]!),
  }));
}

/**
 * Fetch klines from Bybit with retry logic (exponential backoff).
 */
async function fetchKlinesWithRetry(
  interval: string,
  limit: number,
  attempt = 1,
): Promise<string[][]> {
  try {
    const response = await axios.get<BybitKlineResponse>(`${BYBIT_BASE_URL}/v5/market/kline`, {
      params: { category: 'linear', symbol: SYMBOL, interval, limit },
      timeout: 10_000,
    });

    if (response.data.retCode !== 0) {
      throw new Error(`Bybit API error [${response.data.retCode}]: ${response.data.retMsg}`);
    }

    return response.data.result.list;
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
    log.warn(`Fetch failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`);
    await sleep(delay);
    return fetchKlinesWithRetry(interval, limit, attempt + 1);
  }
}

/**
 * Collect candles for a single timeframe and store in Supabase.
 */
export async function collectTimeframe(tf: Timeframe, limit = 200): Promise<Candle[]> {
  const tfConfig = TIMEFRAMES[tf];
  log.info(`Collecting ${limit} candles for ${tf}...`);

  const rawList = await fetchKlinesWithRetry(tfConfig.bybitInterval, limit);
  const candles = parseKlines(rawList, tf);

  // Sort ascending (Bybit returns newest first)
  candles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  try {
    await insertCandles(candles);
    log.info(`Stored ${candles.length} ${tf} candles`);
  } catch (err) {
    log.warn(`Could not store ${tf} candles in DB: ${(err as Error).message}`);
  }

  return candles;
}

/**
 * Collect candles for all 5 timeframes sequentially with rate limiting.
 */
export async function collectAll(limit = 200): Promise<Record<Timeframe, Candle[]>> {
  const timeframes: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
  const result: Partial<Record<Timeframe, Candle[]>> = {};

  for (const tf of timeframes) {
    try {
      result[tf] = await collectTimeframe(tf, limit);
    } catch (err) {
      log.error(`Failed to collect ${tf} candles: ${(err as Error).message}`);
      result[tf] = [];
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return result as Record<Timeframe, Candle[]>;
}

/**
 * Collect only NEW candles since the last stored candle for a timeframe.
 * Falls back to collecting 200 candles if no stored candle is found.
 */
export async function collectIncremental(tf: Timeframe): Promise<Candle[]> {
  try {
    const latest = await getLatestCandle(tf);
    if (!latest) {
      log.info(`No existing ${tf} candles — running full backfill`);
      return collectTimeframe(tf, 200);
    }
    // Always fetch 10 candles to catch up (avoids missing candles with drift)
    return collectTimeframe(tf, 10);
  } catch (err) {
    log.warn(`Incremental collect fell back to full: ${(err as Error).message}`);
    return collectTimeframe(tf, 200);
  }
}
