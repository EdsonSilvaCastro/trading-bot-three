// ============================================================
// ICT Price Action Futures Bot - Main Entry Point
// Phase 2: Analyzers + Bias Engine + Signal Detector
// ============================================================

import 'dotenv/config';
import cron from 'node-cron';
import rootLogger, { createModuleLogger } from './monitoring/logger.js';
import { initTelegramBot, sendAlert, sendDailyBias, setBotState } from './monitoring/telegramBot.js';
import { getSupabaseClient } from './database/supabase.js';
import { collectAll, collectTimeframe } from './collector/candleCollector.js';
import { detectAndStoreSwings } from './analyzer/swingDetector.js';
import { getSessionStatus, isKillzoneActive, getCurrentSession, getSessionHighLow } from './engine/sessionFilter.js';
import { mapLiquidityLevels, updateLiquidityStates } from './analyzer/liquidityMapper.js';
import { scanForSweeps } from './analyzer/sweepDetector.js';
import { detectFVGs, updateFVGStates } from './analyzer/fvgDetector.js';
import { analyzeStructure, detectSMS } from './analyzer/marketStructure.js';
import { computeDailyBias, BiasContext } from './engine/biasEngine.js';
import { detectSignal, TradingSignal, SignalContext } from './engine/signalDetector.js';
import type {
  Candle,
  FairValueGap,
  LiquidityLevel,
  DailyBias,
  Swing,
  Timeframe,
  Sweep,
} from './types/index.js';

const log = createModuleLogger('Main');

// --------------- In-Memory State Caches ---------------

/** Candles per timeframe (last 500 per TF) */
const candleCache: Partial<Record<Timeframe, Candle[]>> = {};

/** Swings per timeframe (last 200 per TF, populated after each swing detection cycle) */
const swingCache: Partial<Record<Timeframe, Swing[]>> = {};

/** Phase 2 state */
let liquidityLevels: LiquidityLevel[] = [];
let activeFVGs: FairValueGap[] = [];
let recentSweeps: Sweep[] = [];
let currentBias: DailyBias | null = null;

// --------------- Startup ---------------

async function startup(): Promise<void> {
  log.info('==============================================');
  log.info(' ICT Price Action Bot — Phase 2 Starting...');
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

  // 5. Run swing detection on backfilled candles (FIX 2: populate swing cache)
  log.info('Running initial swing detection...');
  const swingTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
  for (const tf of swingTimeframes) {
    const candles = candleCache[tf] ?? [];
    if (candles.length >= 7) {
      try {
        const newSwings = await detectAndStoreSwings(candles, []);
        swingCache[tf] = newSwings.slice(-200); // FIX 2: store in cache
        log.info(`  ${tf}: ${newSwings.length} swings detected`);
      } catch (err) {
        log.warn(`  ${tf} swing detection failed: ${(err as Error).message}`);
        swingCache[tf] = [];
      }
    } else {
      log.warn(`  ${tf}: Not enough candles for swing detection (${candles.length})`);
      swingCache[tf] = [];
    }
  }

  // 6. Compute initial daily bias
  try {
    const biasCtx = buildBiasContext();
    currentBias = computeDailyBias(biasCtx);
    log.info(`Initial bias: ${currentBias.bias} | AMD: ${currentBias.amdPhase} | Zone: ${currentBias.b3Zone}`);
  } catch (err) {
    log.warn(`Initial bias computation failed: ${(err as Error).message}`);
  }

  // 7. Push initial state to Telegram bot
  updateBotState();

  // 8. Startup complete alert
  const botMode = process.env['PAPER_TRADING'] === 'true' ? 'PAPER' : 'LIVE';
  const symbol = process.env['SYMBOL'] ?? 'BTCUSDT';
  const biasStr = currentBias ? ` | Bias: ${currentBias.bias}` : '';
  await sendAlert(
    `🚀 <b>ICT Bot Started — Phase 2</b>\nMode: ${botMode}\nSymbol: ${symbol}\nSession: ${sessionStatus}${biasStr}`,
  );

  log.info('Startup complete — scheduling cron jobs');
  scheduleCronJobs();
}

// --------------- Cron Jobs ---------------

function scheduleCronJobs(): void {
  // Every 5 minutes: collect 5M candles + run swing detection
  cron.schedule('*/5 * * * *', async () => {
    await runTimeframeUpdate('5m');
    // Also run analysis cycle (handles killzone check internally)
    await runAnalysisCycle();
  });

  // Every 15 minutes: collect 15M candles + swing detection
  cron.schedule('*/15 * * * *', async () => {
    await runTimeframeUpdate('15m');
  });

  // Every hour at :00: collect 1H candles + swing detection
  cron.schedule('0 * * * *', async () => {
    await runTimeframeUpdate('1h');
  });

  // Every 4 hours: collect 4H candles (no swing detection — low-frequency TF)
  cron.schedule('0 */4 * * *', async () => {
    await runTimeframeUpdate('4h', false);
  });

  // Daily at 00:05 UTC: collect daily candles
  cron.schedule('5 0 * * *', async () => {
    await runTimeframeUpdate('1d', false);
  });

  // Daily at 00:10 UTC: compute fresh daily bias after daily close
  cron.schedule('10 0 * * *', async () => {
    try {
      const biasCtx = buildBiasContext();
      currentBias = computeDailyBias(biasCtx);
      log.info(`Daily bias updated: ${currentBias.bias} | AMD: ${currentBias.amdPhase}`);
      updateBotState();
      await sendDailyBias(currentBias);
    } catch (err) {
      log.error(`Bias calculation error: ${(err as Error).message}`);
    }
  });

  // Every 5 minutes: log session status
  cron.schedule('*/5 * * * *', () => {
    const status = getSessionStatus();
    const kzActive = isKillzoneActive();
    log.info(`[Session] ${status} | Killzone: ${kzActive ? 'ACTIVE' : 'inactive'}`);
  });

  log.info('Cron jobs scheduled:');
  log.info('  - 5m candles + swings + analysis: every 5 minutes');
  log.info('  - 15m candles + swings: every 15 minutes');
  log.info('  - 1h candles + swings: every hour');
  log.info('  - 4h candles: every 4 hours');
  log.info('  - 1d candles: daily at 00:05 UTC');
  log.info('  - Daily bias: daily at 00:10 UTC');
  log.info('  - Session status: every 5 minutes');
}

// --------------- Timeframe Update ---------------

/**
 * Fetch new candles for a timeframe, update cache, run swing detection (FIX 2: uses cache).
 */
async function runTimeframeUpdate(tf: Timeframe, runSwings = true): Promise<void> {
  try {
    const newCandles = await collectTimeframe(tf, 10);

    // Merge into cache (keep last 500 candles per TF)
    const existing = candleCache[tf] ?? [];
    const merged = mergeCandles(existing, newCandles, 500);
    candleCache[tf] = merged;

    // FIX 2: use existing swing cache to detect only NEW swings
    if (runSwings && merged.length >= 7) {
      const existingSwings = swingCache[tf] ?? [];
      const newSwings = await detectAndStoreSwings(merged, existingSwings);
      if (newSwings.length > 0) {
        swingCache[tf] = [...existingSwings, ...newSwings].slice(-200);
        log.info(`[${tf}] ${newSwings.length} new swing(s) detected`);
      }
    }
  } catch (err) {
    log.error(`[${tf}] Update failed: ${(err as Error).message}`);
  }
}

// --------------- Analysis Cycle ---------------

/**
 * Run the full Phase 2 analysis cycle.
 * Only performs full analysis during killzones to save CPU.
 * FVG state updates always run (price-independent).
 */
async function runAnalysisCycle(): Promise<void> {
  try {
    const candles5m = candleCache['5m'] ?? [];
    const candles15m = candleCache['15m'] ?? [];

    // Always update FVG states with latest candles
    if (activeFVGs.length > 0 && candles5m.length > 0) {
      activeFVGs = updateFVGStates(activeFVGs, candles5m.slice(-5));
    }

    // Only full analysis during killzones
    if (!isKillzoneActive()) return;
    if (candles5m.length < 20 || candles15m.length < 20) return;

    const candles1h = candleCache['1h'] ?? [];
    const candles4h = candleCache['4h'] ?? [];

    // 1. Update liquidity map
    liquidityLevels = mapLiquidityLevels(
      candleCache as Record<Timeframe, Candle[]>,
      swingCache as Record<Timeframe, Swing[]>,
      buildSessionHighLows(),
    );

    // 2. Update liquidity states (mark swept levels)
    liquidityLevels = updateLiquidityStates(liquidityLevels, candles5m.slice(-10));

    // 3. Scan for new sweeps
    const activeLevels = liquidityLevels.filter((l) => l.state === 'ACTIVE');
    const newSweeps = scanForSweeps(activeLevels, candles5m.slice(-20));
    if (newSweeps.length > 0) {
      recentSweeps = [...recentSweeps.slice(-10), ...newSweeps];
    }

    // 4. Detect FVGs on 5M and 15M, merge and deduplicate
    const newFVGs5m = detectFVGs(candles5m, '5m');
    const newFVGs15m = detectFVGs(candles15m, '15m');
    activeFVGs = mergeFVGs(activeFVGs, [...newFVGs5m, ...newFVGs15m]);

    // 5. Build structure states
    const structure15m = analyzeStructure(candles15m, swingCache['15m'] ?? []);
    const structure5m = analyzeStructure(candles5m, swingCache['5m'] ?? []);

    // 6. Check for SMS events (the entry trigger)
    const sms15m = detectSMS('15m', candles15m, swingCache['15m'] ?? []);
    const sms5m = detectSMS('5m', candles5m, swingCache['5m'] ?? []);

    if (sms15m !== 'NONE' || sms5m !== 'NONE') {
      log.info(`SMS detected! 15M: ${sms15m} | 5M: ${sms5m}`);
      // Attach last events to structure states for signal detector
      structure15m.lastEvent = sms15m;
      structure5m.lastEvent = sms5m;
    }

    // 7. If no directional bias, skip signal detection
    if (!currentBias || currentBias.bias === 'NO_TRADE') return;

    const currentPrice = candles5m.slice(-1)[0]?.close ?? 0;
    if (currentPrice === 0) return;

    // 8. Try to detect a signal
    const signalCtx: SignalContext = {
      bias: currentBias,
      recentSweeps,
      fvgs: activeFVGs.filter((f) => f.state === 'OPEN' || f.state === 'PARTIALLY_FILLED'),
      liquidityLevels,
      structureState15m: structure15m,
      structureState5m: structure5m,
      currentPrice,
      candles5m,
      candles15m,
      swings5m: swingCache['5m'] ?? [],
      swings15m: swingCache['15m'] ?? [],
    };

    const signal = detectSignal(signalCtx);

    if (signal) {
      await handleSignal(signal);
    }

    // Update bot state with latest info
    updateBotState();

  } catch (err) {
    log.error(`Analysis cycle error: ${(err as Error).message}`);
  }
}

/**
 * Handle a confirmed trading signal: log + alert.
 * Phase 3 will add order execution here.
 */
async function handleSignal(signal: TradingSignal): Promise<void> {
  const entryPrice = signal.entryFVG.ce;

  log.info(
    `SIGNAL: ${signal.direction} | Entry: ${entryPrice.toFixed(2)} | SL: ${signal.stopLoss.toFixed(2)} | TP1: ${signal.tp1.toFixed(2)} | R:R: ${signal.rrRatio.toFixed(1)}x | Conf: ${signal.confidence}`,
  );

  await sendAlert(
    `🎯 <b>ICT Signal: ${signal.direction}</b>\n` +
    `Entry Zone: ${signal.entryFVG.bottom.toFixed(2)} - ${signal.entryFVG.top.toFixed(2)}\n` +
    `Stop Loss: ${signal.stopLoss.toFixed(2)}\n` +
    `TP1 (IRL): ${signal.tp1.toFixed(2)}\n` +
    `TP2 (ERL): ${signal.tp2.toFixed(2)}\n` +
    `R:R: ${signal.rrRatio.toFixed(1)}x\n` +
    `Confidence: ${signal.confidence}/100\n` +
    `Displacement: ${signal.displacementScore}/10\n` +
    `FVG Quality: ${signal.entryFVG.quality}`
  );

  // Phase 3: add execution here
}

// --------------- Context Builders ---------------

/** Build BiasContext from current caches. */
function buildBiasContext(): BiasContext {
  const currentPrice = candleCache['5m']?.slice(-1)[0]?.close ?? 0;
  return {
    dailyCandles: candleCache['1d'] ?? [],
    fourHourCandles: candleCache['4h'] ?? [],
    dailySwings: swingCache['1d'] ?? [],
    fourHourSwings: swingCache['4h'] ?? [],
    liquidityLevels,
    currentPrice,
    currentSession: getCurrentSession(),
  };
}

/** Build session high/low data for liquidity mapper. */
function buildSessionHighLows() {
  const now = new Date();
  const candles1h = candleCache['1h'] ?? [];

  const asian = getSessionHighLow('ASIAN', now, candles1h) ?? undefined;
  const london = getSessionHighLow('LONDON', now, candles1h) ?? undefined;

  return { asian, london };
}

/** Push current bot state to Telegram (for /status, /bias, /levels commands). */
function updateBotState(): void {
  setBotState({
    bias: currentBias,
    activeFVGsCount: activeFVGs.filter((f) => f.state === 'OPEN' || f.state === 'PARTIALLY_FILLED').length,
    liquidityLevels,
    swingCache,
  });
}

// --------------- FVG Merge Utility ---------------

/**
 * Merge new FVGs into the existing pool, deduplicating by id.
 * Expires FVGs older than 24 hours or fully filled/violated.
 */
function mergeFVGs(existing: FairValueGap[], incoming: FairValueGap[]): FairValueGap[] {
  const map = new Map<string, FairValueGap>();
  for (const fvg of existing) map.set(fvg.id, fvg);
  for (const fvg of incoming) {
    if (!map.has(fvg.id)) map.set(fvg.id, fvg);
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h
  return Array.from(map.values()).filter(
    (f) => f.state !== 'FILLED' && f.state !== 'VIOLATED' && f.timestamp.getTime() > cutoff,
  );
}

// --------------- Candle Merge Utility ---------------

/**
 * Merge new candles into existing array, deduplicating by timestamp.
 * Keeps only the most recent maxSize candles.
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
