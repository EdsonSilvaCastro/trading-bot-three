// ============================================================
// ICT Price Action Futures Bot - Main Entry Point
// Phase 3: Execution Layer (Paper Trading + Risk Management)
// ============================================================

import 'dotenv/config';
import cron from 'node-cron';
import rootLogger, { createModuleLogger } from './monitoring/logger.js';
import { initTelegramBot, sendAlert, sendDailyBias, setBotState, isManualKillSwitchActive } from './monitoring/telegramBot.js';
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
import { PositionManager } from './execution/positionManager.js';
import { resetDaily, resetWeekly, updateEquity, getRiskState, isKillSwitchActive } from './execution/riskManager.js';
import { getOpenPositions, getTradeHistory, closeAllPaperPositions } from './execution/paperTrader.js';
import type {
  Candle,
  FairValueGap,
  LiquidityLevel,
  DailyBias,
  Swing,
  Timeframe,
  Sweep,
  StructureEvent,
} from './types/index.js';

const log = createModuleLogger('Main');

// --------------- In-Memory State Caches ---------------

const candleCache: Partial<Record<Timeframe, Candle[]>> = {};
const swingCache: Partial<Record<Timeframe, Swing[]>> = {};

let liquidityLevels: LiquidityLevel[] = [];
let activeFVGs: FairValueGap[] = [];
let recentSweeps: Sweep[] = [];
let currentBias: DailyBias | null = null;

// Phase 3 execution state
let accountBalance = parseFloat(process.env['PAPER_BALANCE'] ?? '10000');

/** Debounce cache — prevents the same SMS/CHOCH from re-firing every 5 min cycle */
const lastSMSEvent: Partial<Record<Timeframe, {
  event: StructureEvent;
  swingCount: number; // Number of swings when the event was first detected
}>> = {};
const positionManager = new PositionManager(true, (pnl) => {
  accountBalance += pnl;
  log.info(`TP1 partial PnL applied: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT | Balance: $${accountBalance.toFixed(2)}`);
});

// --------------- Startup ---------------

async function startup(): Promise<void> {
  log.info('==============================================');
  log.info(' ICT Price Action Bot — Phase 3 Starting...');
  log.info('==============================================');

  const sessionStatus = getSessionStatus();
  log.info(`Current session: ${sessionStatus}`);
  log.info(`Paper balance: $${accountBalance.toFixed(2)} USDT`);

  initTelegramBot();

  const db = getSupabaseClient();
  log.info(db ? 'Supabase connected' : 'Supabase not configured — memory-only mode');

  // Backfill candles
  log.info('Starting initial candle backfill (200 × 5 timeframes)...');
  try {
    const allCandles = await collectAll(200);
    for (const [tf, candles] of Object.entries(allCandles)) {
      candleCache[tf as Timeframe] = candles;
      log.info(`  ${tf}: ${candles.length} candles`);
    }
  } catch (err) {
    log.error(`Backfill failed: ${(err as Error).message}`);
  }

  // Initial swing detection (populates swing cache)
  log.info('Running initial swing detection...');
  const swingTFs: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
  for (const tf of swingTFs) {
    const candles = candleCache[tf] ?? [];
    if (candles.length >= 7) {
      try {
        const swings = await detectAndStoreSwings(candles, []);
        swingCache[tf] = swings.slice(-200);
        log.info(`  ${tf}: ${swings.length} swings`);
      } catch (err) {
        log.warn(`  ${tf} swing detection failed: ${(err as Error).message}`);
        swingCache[tf] = [];
      }
    } else {
      swingCache[tf] = [];
    }
  }

  // Initial bias
  try {
    currentBias = computeDailyBias(buildBiasContext());
    log.info(`Initial bias: ${currentBias.bias} | AMD: ${currentBias.amdPhase} | Zone: ${currentBias.b3Zone}`);
  } catch (err) {
    log.warn(`Initial bias failed: ${(err as Error).message}`);
  }

  updateBotState();

  const symbol = process.env['SYMBOL'] ?? 'BTCUSDT';
  await sendAlert(
    `🚀 <b>ICT Bot Started — Phase 3</b>\n` +
    `Mode: PAPER | Symbol: ${symbol}\n` +
    `Balance: $${accountBalance.toFixed(2)} USDT\n` +
    `Session: ${sessionStatus}\n` +
    `Bias: ${currentBias?.bias ?? 'Unknown'}`,
  );

  log.info('Startup complete — scheduling cron jobs');
  scheduleCronJobs();
}

// --------------- Cron Jobs ---------------

function scheduleCronJobs(): void {
  // 5M: candle update + analysis + position management
  cron.schedule('*/5 * * * *', async () => {
    await runTimeframeUpdate('5m');

    const price = candleCache['5m']?.slice(-1)[0]?.close ?? 0;
    if (price > 0) {
      // Always manage positions (SL/TP can hit outside killzones)
      const structure15m = analyzeStructure(candleCache['15m'] ?? [], swingCache['15m'] ?? []);
      await positionManager.checkPositions(price, new Date(), structure15m);
    }

    // Full analysis only during killzones
    await runAnalysisCycle();
  });

  // 15M candles + swings
  cron.schedule('*/15 * * * *', async () => {
    await runTimeframeUpdate('15m');
  });

  // 1H candles + swings
  cron.schedule('0 * * * *', async () => {
    await runTimeframeUpdate('1h');
  });

  // 4H candles
  cron.schedule('0 */4 * * *', async () => {
    await runTimeframeUpdate('4h', false);
  });

  // Daily 00:05 UTC: daily candles
  cron.schedule('5 0 * * *', async () => {
    await runTimeframeUpdate('1d', false);
  });

  // Daily 00:10 UTC: recalculate bias after daily close
  cron.schedule('10 0 * * *', async () => {
    try {
      currentBias = computeDailyBias(buildBiasContext());
      log.info(`Daily bias: ${currentBias.bias} | AMD: ${currentBias.amdPhase}`);
      updateBotState();
      await sendDailyBias(currentBias);
    } catch (err) {
      log.error(`Bias calculation error: ${(err as Error).message}`);
    }
  });

  // Daily 00:00 UTC: reset daily risk counters
  cron.schedule('0 0 * * *', () => {
    resetDaily();
    log.info('Daily risk counters reset');
  });

  // Monday 00:00 UTC: reset weekly risk counters
  cron.schedule('0 0 * * 1', () => {
    resetWeekly();
    log.info('Weekly risk counters reset');
  });

  // Hourly: update equity tracking
  cron.schedule('0 * * * *', () => {
    try {
      const openPnL = getOpenPositions().reduce((sum, pos) => {
        if (!pos.entryFilled || !pos.trade.entryPrice) return sum;
        const price = candleCache['5m']?.slice(-1)[0]?.close ?? 0;
        if (!price) return sum;
        const dir = pos.trade.direction === 'LONG' ? 1 : -1;
        const pnl = dir * ((price - pos.trade.entryPrice) / pos.trade.entryPrice)
          * pos.trade.sizeUsdt * pos.trade.leverage;
        return sum + pnl;
      }, 0);
      updateEquity(accountBalance + openPnL);
    } catch (err) {
      log.error(`Equity update error: ${(err as Error).message}`);
    }
  });

  // Every 5 minutes: log session status
  cron.schedule('*/5 * * * *', () => {
    log.info(`[Session] ${getSessionStatus()} | Killzone: ${isKillzoneActive() ? 'ACTIVE' : 'inactive'}`);
  });

  log.info('Cron jobs scheduled (Phase 3)');
}

// --------------- Timeframe Update ---------------

async function runTimeframeUpdate(tf: Timeframe, runSwings = true): Promise<void> {
  try {
    const newCandles = await collectTimeframe(tf, 10);
    const existing = candleCache[tf] ?? [];
    candleCache[tf] = mergeCandles(existing, newCandles, 500);

    if (runSwings && (candleCache[tf]?.length ?? 0) >= 7) {
      const existingSwings = swingCache[tf] ?? [];
      const newSwings = await detectAndStoreSwings(candleCache[tf]!, existingSwings);
      if (newSwings.length > 0) {
        swingCache[tf] = [...existingSwings, ...newSwings].slice(-200);
        log.info(`[${tf}] ${newSwings.length} new swing(s)`);
      }
    }
  } catch (err) {
    log.error(`[${tf}] Update failed: ${(err as Error).message}`);
  }
}

// --------------- Analysis Cycle ---------------

async function runAnalysisCycle(): Promise<void> {
  try {
    const candles5m = candleCache['5m'] ?? [];
    const candles15m = candleCache['15m'] ?? [];

    // Always update FVG states
    if (activeFVGs.length > 0 && candles5m.length > 0) {
      activeFVGs = updateFVGStates(activeFVGs, candles5m.slice(-5));
    }

    // Full analysis only in killzones
    if (!isKillzoneActive()) return;
    if (candles5m.length < 20 || candles15m.length < 20) return;

    // Skip if kill switch active
    if (isKillSwitchActive() || isManualKillSwitchActive()) {
      log.warn('Kill switch active — skipping signal detection');
      return;
    }

    // 1. Update liquidity map
    liquidityLevels = mapLiquidityLevels(
      candleCache as Record<Timeframe, Candle[]>,
      swingCache as Record<Timeframe, Swing[]>,
      buildSessionHighLows(),
    );
    log.info(`Liquidity mapped: ${liquidityLevels.length} total levels`);
    liquidityLevels = updateLiquidityStates(liquidityLevels, candles5m.slice(-10));
    log.info(`Liquidity after state update: ${liquidityLevels.filter((l) => l.state === 'ACTIVE').length} active / ${liquidityLevels.length} total`);

    // 2. Scan for sweeps
    const newSweeps = scanForSweeps(
      liquidityLevels.filter((l) => l.state === 'ACTIVE'),
      candles5m.slice(-20),
    );
    if (newSweeps.length > 0) {
      recentSweeps = [...recentSweeps.slice(-10), ...newSweeps];
    }

    // 3. Detect FVGs
    const newFVGs5m = detectFVGs(candles5m, '5m');
    const newFVGs15m = detectFVGs(candles15m, '15m');
    activeFVGs = mergeFVGs(activeFVGs, [...newFVGs5m, ...newFVGs15m]);

    // 4. Structure states
    const structure15m = analyzeStructure(candles15m, swingCache['15m'] ?? []);
    const structure5m = analyzeStructure(candles5m, swingCache['5m'] ?? []);

    // 5. SMS detection (debounced — only fires once per structural event, not every cycle)
    const sms15mRaw = detectSMS('15m', candles15m, swingCache['15m'] ?? []);
    const sms5mRaw = detectSMS('5m', candles5m, swingCache['5m'] ?? []);
    const sms15m = debounceSMS('15m', sms15mRaw, swingCache['15m'] ?? []);
    const sms5m = debounceSMS('5m', sms5mRaw, swingCache['5m'] ?? []);
    if (sms15m !== 'NONE' || sms5m !== 'NONE') {
      log.info(`SMS! 15M: ${sms15m} | 5M: ${sms5m}`);
      structure15m.lastEvent = sms15m;
      structure5m.lastEvent = sms5m;
    }

    if (!currentBias || currentBias.bias === 'NO_TRADE') return;

    const currentPrice = candles5m.slice(-1)[0]?.close ?? 0;
    if (!currentPrice) return;

    // 6. Signal detection
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

    updateBotState();
  } catch (err) {
    log.error(`Analysis cycle error: ${(err as Error).message}`);
  }
}

// --------------- Signal Handler ---------------

async function handleSignal(signal: TradingSignal): Promise<void> {
  const entry = signal.entryFVG.ce;
  log.info(
    `SIGNAL: ${signal.direction} | Entry ~${entry.toFixed(2)} | SL: ${signal.stopLoss.toFixed(2)} | TP1: ${signal.tp1.toFixed(2)} | R:R: ${signal.rrRatio.toFixed(1)}x | Conf: ${signal.confidence}`,
  );

  // Alert before executing (so user sees it even if execution fails)
  await sendAlert(
    `🎯 <b>ICT Signal: ${signal.direction}</b>\n` +
    `Entry Zone: ${signal.entryFVG.bottom.toFixed(2)} – ${signal.entryFVG.top.toFixed(2)}\n` +
    `SL: ${signal.stopLoss.toFixed(2)} | TP1: ${signal.tp1.toFixed(2)} | TP2: ${signal.tp2.toFixed(2)}\n` +
    `R:R: ${signal.rrRatio.toFixed(1)}x | Confidence: ${signal.confidence}/100\n` +
    `Displacement: ${signal.displacementScore}/10 | FVG: ${signal.entryFVG.quality}`,
  );

  // Execute via position manager
  await positionManager.executeSignal(signal, accountBalance);
  updateBotState();
}

// --------------- Context Builders ---------------

function buildBiasContext(): BiasContext {
  return {
    dailyCandles: candleCache['1d'] ?? [],
    fourHourCandles: candleCache['4h'] ?? [],
    dailySwings: swingCache['1d'] ?? [],
    fourHourSwings: swingCache['4h'] ?? [],
    liquidityLevels,
    currentPrice: candleCache['5m']?.slice(-1)[0]?.close ?? 0,
    currentSession: getCurrentSession(),
  };
}

/**
 * Prevent the same SMS/CHOCH event from firing on every 5-min cycle.
 *
 * An SMS is a one-time structural event. It is considered "new" only when:
 *   - No prior event was recorded for this timeframe, OR
 *   - New swings have formed since the last event (swing count increased), OR
 *   - The event direction changed (was BULLISH, now BEARISH or vice-versa)
 *
 * BMS events (trend continuation) are intentionally NOT debounced here because
 * they are not entry triggers and are filtered downstream.
 *
 * @param tf    - Timeframe being evaluated
 * @param event - Raw StructureEvent from detectSMS
 * @param swings - Current swing array for this timeframe
 */
function debounceSMS(tf: Timeframe, event: StructureEvent, swings: Swing[]): StructureEvent {
  if (event === 'NONE') return 'NONE';

  const prev = lastSMSEvent[tf];
  const currentSwingCount = swings.length;

  if (prev) {
    // Suppress if same event AND swing count hasn't changed (candles are the same)
    if (prev.event === event && prev.swingCount === currentSwingCount) {
      return 'NONE';
    }
  }

  // New event — record and let it through
  lastSMSEvent[tf] = { event, swingCount: currentSwingCount };
  return event;
}

function buildSessionHighLows() {
  const now = new Date();
  const candles1h = candleCache['1h'] ?? [];
  return {
    asian: getSessionHighLow('ASIAN', now, candles1h) ?? undefined,
    london: getSessionHighLow('LONDON', now, candles1h) ?? undefined,
  };
}

function updateBotState(): void {
  setBotState({
    bias: currentBias,
    activeFVGsCount: activeFVGs.filter((f) => f.state === 'OPEN' || f.state === 'PARTIALLY_FILLED').length,
    liquidityLevels,
    swingCache,
    openPositions: getOpenPositions(),
    tradeHistory: getTradeHistory(),
    riskState: getRiskState(),
    accountBalance,
  });
}

// --------------- Merge Utilities ---------------

function mergeFVGs(existing: FairValueGap[], incoming: FairValueGap[]): FairValueGap[] {
  const map = new Map<string, FairValueGap>();
  for (const fvg of existing) map.set(fvg.id, fvg);
  for (const fvg of incoming) {
    if (!map.has(fvg.id)) map.set(fvg.id, fvg);
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return Array.from(map.values()).filter(
    (f) => f.state !== 'FILLED' && f.state !== 'VIOLATED' && f.timestamp.getTime() > cutoff,
  );
}

function mergeCandles(existing: Candle[], incoming: Candle[], maxSize: number): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(c.timestamp.getTime(), c);
  for (const c of incoming) map.set(c.timestamp.getTime(), c);
  return Array.from(map.values())
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .slice(-maxSize);
}

// --------------- Graceful Shutdown ---------------

function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal} — shutting down gracefully...`);
    // Close all open paper positions at current price
    const price = candleCache['5m']?.slice(-1)[0]?.close ?? 0;
    if (price > 0) {
      const closed = closeAllPaperPositions(price);
      if (closed.length > 0) {
        log.info(`Force-closed ${closed.length} paper position(s) at shutdown`);
      }
    }
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
