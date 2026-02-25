// ============================================================
// ICT Price Action Futures Bot - Main Entry Point
// Phase 1: Foundation + Data Pipeline + Swing Detection
// ============================================================

import 'dotenv/config';
import cron from 'node-cron';
import rootLogger, { createModuleLogger } from './monitoring/logger.js';
import { initTelegramBot, sendAlert } from './monitoring/telegramBot.js';
import { getSupabaseClient } from './database/supabase.js';
import { collectAll, collectTimeframe } from './collector/candleCollector.js';
import { detectAndStoreSwings } from './analyzer/swingDetector.js';
import { getSessionStatus, isKillzoneActive } from './engine/sessionFilter.js';
import type { Candle, Timeframe } from './types/index.js';

const log = createModuleLogger('Main');

// In-memory cache of candles per timeframe (avoids DB queries on every cron tick)
const candleCache: Partial<Record<Timeframe, Candle[]>> = {};

// --------------- Startup ---------------

async function startup(): Promise<void> {
  log.info('==============================================');
  log.info(' ICT Price Action Bot — Phase 1 Starting...');
  log.info('==============================================');

  // 1. Check session status
  const sessionStatus = getSessionStatus();
  log.info(`Current session: ${sessionStatus}`);
  log.info(`Kill zone active: ${isKillzoneActive()}`);

  // 2. Initialize Telegram (graceful if not configured)
  initTelegramBot();

  // 3. Check Supabase connectivity
  const db = getSupabaseClient();
  if (!db) {
    log.warn('Supabase not configured — running in memory-only mode');
  } else {
    log.info('Supabase connected');
  }

  // 4. Initial backfill: collect 200 candles per timeframe
  log.info('Starting initial candle backfill (200 candles × 5 timeframes)...');
  try {
    const allCandles = await collectAll(200);
    for (const [tf, candles] of Object.entries(allCandles)) {
      candleCache[tf as Timeframe] = candles;
      log.info(`  ${tf}: ${candles.length} candles collected`);
    }
  } catch (err) {
    log.error(`Backfill failed: ${(err as Error).message}`);
  }

  // 5. Run swing detection on backfilled candles
  log.info('Running initial swing detection...');
  const swingTimeframes: Timeframe[] = ['5m', '15m', '1h'];
  for (const tf of swingTimeframes) {
    const candles = candleCache[tf] ?? [];
    if (candles.length >= 7) {
      try {
        const newSwings = await detectAndStoreSwings(candles, []);
        log.info(`  ${tf}: ${newSwings.length} swings detected`);
      } catch (err) {
        log.warn(`  ${tf} swing detection failed: ${(err as Error).message}`);
      }
    } else {
      log.warn(`  ${tf}: Not enough candles for swing detection (${candles.length})`);
    }
  }

  // 6. Startup complete alert
  const botMode = process.env['PAPER_TRADING'] === 'true' ? 'PAPER' : 'LIVE';
  const symbol = process.env['SYMBOL'] ?? 'BTCUSDT';
  await sendAlert(
    `🚀 <b>ICT Bot Started</b>\nMode: ${botMode}\nSymbol: ${symbol}\nSession: ${sessionStatus}`,
  );

  log.info('Startup complete — scheduling cron jobs');
  scheduleCronJobs();
}

// --------------- Cron Jobs ---------------

function scheduleCronJobs(): void {
  // Every 5 minutes: collect 5M candles + run swing detection
  cron.schedule('*/5 * * * *', async () => {
    await runTimeframeUpdate('5m');
  });

  // Every 15 minutes: collect 15M candles + swing detection
  cron.schedule('*/15 * * * *', async () => {
    await runTimeframeUpdate('15m');
  });

  // Every hour at :00: collect 1H candles + swing detection
  cron.schedule('0 * * * *', async () => {
    await runTimeframeUpdate('1h');
  });

  // Every 4 hours: collect 4H candles
  cron.schedule('0 */4 * * *', async () => {
    await runTimeframeUpdate('4h', false);
  });

  // Daily at 00:05 UTC: collect daily candles
  cron.schedule('5 0 * * *', async () => {
    await runTimeframeUpdate('1d', false);
  });

  // Every 5 minutes: log session status
  cron.schedule('*/5 * * * *', () => {
    const status = getSessionStatus();
    const kzActive = isKillzoneActive();
    log.info(`[Session] ${status} | Killzone: ${kzActive ? 'ACTIVE' : 'inactive'}`);
  });

  log.info('Cron jobs scheduled:');
  log.info('  - 5m candles + swings: every 5 minutes');
  log.info('  - 15m candles + swings: every 15 minutes');
  log.info('  - 1h candles + swings: every hour');
  log.info('  - 4h candles: every 4 hours');
  log.info('  - 1d candles: daily at 00:05 UTC');
  log.info('  - Session status: every 5 minutes');
}

/**
 * Fetch new candles for a timeframe, update cache, run swing detection.
 */
async function runTimeframeUpdate(
  tf: Timeframe,
  runSwings = true,
): Promise<void> {
  try {
    const newCandles = await collectTimeframe(tf, 10);

    // Merge into cache (keep last 500 candles per TF)
    const existing = candleCache[tf] ?? [];
    const merged = mergeCandles(existing, newCandles, 500);
    candleCache[tf] = merged;

    if (runSwings && merged.length >= 7) {
      const swings = await detectAndStoreSwings(merged, []);
      if (swings.length > 0) {
        log.info(`[${tf}] ${swings.length} new swing(s) detected`);
      }
    }
  } catch (err) {
    log.error(`[${tf}] Update failed: ${(err as Error).message}`);
  }
}

/**
 * Merge new candles into an existing array, deduplicating by timestamp,
 * keeping only the most recent `maxSize` candles.
 */
function mergeCandles(existing: Candle[], incoming: Candle[], maxSize: number): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(c.timestamp.getTime(), c);
  for (const c of incoming) map.set(c.timestamp.getTime(), c); // incoming overwrites

  const sorted = Array.from(map.values()).sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  return sorted.slice(-maxSize);
}

// --------------- Graceful Shutdown ---------------

function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal} — shutting down gracefully...`);
    await sendAlert(`⛔ ICT Bot stopping (${signal})`).catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  });

  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${String(reason)}`);
  });
}

// --------------- Run ---------------

setupShutdownHandlers();
startup().catch((err) => {
  rootLogger.error(`Fatal startup error: ${(err as Error).message}`);
  process.exit(1);
});
