// ============================================================
// Paper Trader - Phase 3
// ============================================================
// Simulates trade execution using real Bybit prices.
// No real orders are ever placed.
//
// Trade lifecycle:
//   PENDING → OPEN (when price reaches entry FVG)
//   OPEN → TP1_HIT → (TP2_HIT | STOPPED | TIME_EXIT)
//   OPEN → STOPPED (if SL hit before TP1)
//
// Slippage: 0.05% adverse slippage applied at fill time.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { Trade, TradeStatus } from '../types/index.js';
import { createModuleLogger } from '../monitoring/logger.js';
import { toNYTime } from '../engine/sessionFilter.js';

const log = createModuleLogger('PaperTrader');

/** Conservative slippage applied to fill price */
const SLIPPAGE = 0.0005; // 0.05%
/** Time exit threshold: 15:30 NY time */
const TIME_EXIT_NY_HOUR = 15;
const TIME_EXIT_NY_MINUTE = 30;

// --------------- Interfaces ---------------

export interface PaperPosition {
  trade: Trade;
  /** Has price reached the entry FVG zone? */
  entryFilled: boolean;
  /** Has TP1 partial close been executed? */
  tp1Executed: boolean;
  /** Has SL been moved to breakeven after TP1? */
  beStopMoved: boolean;
  /** Current active stop loss (updated to BE after TP1) */
  currentStopLoss: number;
  /** Remaining size as a fraction of original (1.0 → 0.5 after TP1) */
  remainingSizePercent: number;
  /** PnL already realized from TP1 partial close */
  partialPnlUsdt: number;
  /** FVG zone bounds for fill detection */
  fvgTop: number;
  fvgBottom: number;
  fvgCE: number;
  openTimestamp: Date;
  lastCheckPrice: number;
}

// --------------- Module-Level State ---------------

const openPositions: PaperPosition[] = [];
const tradeHistory: Trade[] = [];

// --------------- PnL Helpers ---------------

function calcPnL(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  exitPrice: number,
  sizeUsdt: number,
  leverage: number,
): { pnlUsdt: number; pnlPct: number } {
  const priceDiff = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
  const pnlPct = (priceDiff / entryPrice) * leverage * 100;
  const pnlUsdt = (priceDiff / entryPrice) * sizeUsdt * leverage;
  return { pnlUsdt, pnlPct };
}

function calcRR(trade: Trade): number {
  if (!trade.entryPrice || !trade.exitPrice) return 0;
  const risk = Math.abs(trade.entryPrice - trade.stopLoss);
  if (risk === 0) return 0;
  const reward = Math.abs(trade.exitPrice - trade.entryPrice);
  return reward / risk;
}

/** Close a position and record it in history. */
function closePaperPosition(
  pos: PaperPosition,
  exitPrice: number,
  status: TradeStatus,
  partialPnl: number,
): Trade {
  const idx = openPositions.indexOf(pos);
  if (idx !== -1) openPositions.splice(idx, 1);

  const sizeRemaining = pos.trade.sizeUsdt * pos.remainingSizePercent;
  const { pnlUsdt: remainingPnl, pnlPct } = calcPnL(
    pos.trade.direction,
    pos.trade.entryPrice,
    exitPrice,
    sizeRemaining,
    pos.trade.leverage,
  );

  const totalPnlUsdt = partialPnl + remainingPnl;
  const totalPnlPct = (totalPnlUsdt / pos.trade.sizeUsdt) * 100;

  const closedTrade: Trade = {
    ...pos.trade,
    exitPrice,
    pnlUsdt: totalPnlUsdt,
    pnlPct: totalPnlPct,
    rrAchieved: calcRR({ ...pos.trade, exitPrice }),
    status,
  };

  tradeHistory.push(closedTrade);
  log.info(
    `Trade closed [${status}]: ${closedTrade.direction} | entry=${closedTrade.entryPrice?.toFixed(2)} exit=${exitPrice.toFixed(2)} | PnL=${totalPnlUsdt >= 0 ? '+' : ''}${totalPnlUsdt.toFixed(2)} USDT`,
  );

  return closedTrade;
}

// --------------- Public API ---------------

/**
 * Open a new paper trade based on a trading signal.
 * Trade starts as PENDING until price fills the entry FVG.
 *
 * @param signal    - The trading signal from signalDetector
 * @param sizeUsdt  - Position size from risk manager
 * @param leverage  - Leverage from risk config
 */
export function openPaperTrade(
  signal: {
    direction: 'LONG' | 'SHORT';
    entryFVG: { top: number; bottom: number; ce: number; id: string };
    stopLoss: number;
    tp1: number;
    tp2: number;
    displacementScore: number;
    confidence: number;
    sweep: { id: string };
  },
  sizeUsdt: number,
  leverage: number,
): Trade {
  // For LONG: fill price = FVG CE + slippage; SHORT: CE - slippage
  const fillPrice =
    signal.direction === 'LONG'
      ? signal.entryFVG.ce * (1 + SLIPPAGE)
      : signal.entryFVG.ce * (1 - SLIPPAGE);

  const trade: Trade = {
    id: uuidv4(),
    timestamp: new Date(),
    direction: signal.direction,
    entryPrice: fillPrice, // Anticipated fill — set at creation for simplicity
    sizeUsdt,
    leverage,
    stopLoss: signal.stopLoss,
    tp1Level: signal.tp1,
    tp2Level: signal.tp2,
    tp1Hit: false,
    status: 'PENDING',
    isPaper: true,
    displacementScore: signal.displacementScore,
    sweepId: signal.sweep.id,
    fvgId: signal.entryFVG.id,
  };

  const pos: PaperPosition = {
    trade,
    entryFilled: false,
    tp1Executed: false,
    beStopMoved: false,
    currentStopLoss: signal.stopLoss,
    remainingSizePercent: 1.0,
    partialPnlUsdt: 0,
    fvgTop: signal.entryFVG.top,
    fvgBottom: signal.entryFVG.bottom,
    fvgCE: signal.entryFVG.ce,
    openTimestamp: new Date(),
    lastCheckPrice: fillPrice,
  };

  openPositions.push(pos);
  log.info(
    `Paper trade PENDING: ${trade.direction} | FVG ${signal.entryFVG.bottom.toFixed(2)}-${signal.entryFVG.top.toFixed(2)} | SL=${signal.stopLoss.toFixed(2)} TP1=${signal.tp1.toFixed(2)} | size=${sizeUsdt.toFixed(2)} USDT`,
  );

  return trade;
}

/**
 * Update all open paper positions based on current price.
 * Called every 5 minutes during the analysis cycle.
 *
 * Returns closed trades, alerts to send, and any PnL realized from TP1 partial
 * closes so the caller can update the account balance immediately.
 *
 * NOTE: SL/TP/time exit logic is also in exitStrategy.ts.
 * The paper trader handles these exits directly for simplicity.
 * exitStrategy.ts is used by positionManager for STRUCTURAL exits only.
 * TODO Phase 4: consolidate into a single exit path.
 *
 * @param currentPrice - Latest market price
 * @param currentTime  - Current UTC time (for time-based exits)
 */
export function updatePaperPositions(
  currentPrice: number,
  currentTime: Date,
): { closedTrades: Trade[]; alerts: string[]; partialPnlRealized: number } {
  const closedTrades: Trade[] = [];
  const alerts: string[] = [];
  let partialPnlRealized = 0;

  const isTimeExit = checkTimeExit(currentTime);

  for (let i = openPositions.length - 1; i >= 0; i--) {
    const pos = openPositions[i]!;
    pos.lastCheckPrice = currentPrice;

    // ── Fill pending entries ──────────────────────────────
    if (!pos.entryFilled) {
      const filled =
        pos.trade.direction === 'LONG'
          ? currentPrice <= pos.fvgTop  // Price retraced into FVG
          : currentPrice >= pos.fvgBottom;

      if (filled) {
        pos.entryFilled = true;
        pos.trade.status = 'OPEN';
        // Apply slippage to fill price
        pos.trade.entryPrice =
          pos.trade.direction === 'LONG'
            ? pos.fvgCE * (1 + SLIPPAGE)
            : pos.fvgCE * (1 - SLIPPAGE);

        log.info(
          `Paper trade FILLED: ${pos.trade.direction} @ ${pos.trade.entryPrice.toFixed(2)}`,
        );
        alerts.push(
          `✅ <b>Paper Trade Filled</b>\n${pos.trade.direction} @ ${pos.trade.entryPrice.toFixed(2)}\nSL: ${pos.trade.stopLoss.toFixed(2)} | TP1: ${pos.trade.tp1Level.toFixed(2)}`,
        );
      }
      continue; // Don't check exits for un-filled positions
    }

    // ── Check time exit ──────────────────────────────────
    if (isTimeExit) {
      const closed = closePaperPosition(pos, currentPrice, 'TIME_EXIT', pos.partialPnlUsdt);
      closedTrades.push(closed);
      alerts.push(`⏰ <b>Time Exit</b>: ${closed.direction} @ ${currentPrice.toFixed(2)}`);
      continue;
    }

    const dir = pos.trade.direction;

    // ── Check stop loss ───────────────────────────────────
    const slHit =
      dir === 'LONG'
        ? currentPrice <= pos.currentStopLoss
        : currentPrice >= pos.currentStopLoss;

    if (slHit) {
      const exitPrice = pos.currentStopLoss;
      const closed = closePaperPosition(pos, exitPrice, 'STOPPED', pos.partialPnlUsdt);
      closedTrades.push(closed);
      continue;
    }

    // ── Check TP2 (after TP1 already hit) ────────────────
    if (pos.tp1Executed) {
      const tp2Hit =
        dir === 'LONG'
          ? currentPrice >= pos.trade.tp2Level
          : currentPrice <= pos.trade.tp2Level;

      if (tp2Hit) {
        const closed = closePaperPosition(pos, pos.trade.tp2Level, 'TP2_HIT', pos.partialPnlUsdt);
        closedTrades.push(closed);
        alerts.push(`🎯 <b>TP2 Hit</b>: ${closed.direction} @ ${pos.trade.tp2Level.toFixed(2)}`);
        continue;
      }
    }

    // ── Check TP1 ─────────────────────────────────────────
    if (!pos.tp1Executed) {
      const tp1Hit =
        dir === 'LONG'
          ? currentPrice >= pos.trade.tp1Level
          : currentPrice <= pos.trade.tp1Level;

      if (tp1Hit) {
        // Close 50% and move SL to breakeven
        const { pnlUsdt: tp1Pnl } = calcPnL(
          dir,
          pos.trade.entryPrice,
          pos.trade.tp1Level,
          pos.trade.sizeUsdt * 0.5, // 50% close
          pos.trade.leverage,
        );

        pos.partialPnlUsdt += tp1Pnl;
        partialPnlRealized += tp1Pnl; // Propagate to caller for balance update
        pos.tp1Executed = true;
        pos.trade.tp1Hit = true;
        pos.trade.status = 'TP1_HIT';
        pos.remainingSizePercent = 0.5;

        // Move SL to breakeven + small buffer
        const buffer = pos.trade.entryPrice * 0.0005;
        pos.currentStopLoss =
          dir === 'LONG'
            ? pos.trade.entryPrice + buffer
            : pos.trade.entryPrice - buffer;
        pos.beStopMoved = true;

        log.info(
          `TP1 hit: ${dir} | partial PnL=${tp1Pnl >= 0 ? '+' : ''}${tp1Pnl.toFixed(2)} USDT | new SL=${pos.currentStopLoss.toFixed(2)} (BE)`,
        );
        alerts.push(
          `🎯 <b>TP1 Hit — 50% Closed</b>\n${dir} @ ${pos.trade.tp1Level.toFixed(2)}\nSL moved to BE: ${pos.currentStopLoss.toFixed(2)}\nPartial PnL: +${tp1Pnl.toFixed(2)} USDT`,
        );
      }
    }
  }

  return { closedTrades, alerts, partialPnlRealized };
}

/**
 * Force-close a specific paper position (e.g. structural exit).
 *
 * @param tradeId - ID of the trade to close
 * @param price   - Exit price
 * @param reason  - Reason for the forced close
 */
export function forceClosePaperPosition(
  tradeId: string,
  price: number,
  reason: TradeStatus,
): Trade | null {
  const idx = openPositions.findIndex((p) => p.trade.id === tradeId);
  if (idx === -1) return null;

  const pos = openPositions[idx]!;
  if (!pos.entryFilled) {
    // Cancel pending — remove without recording PnL
    openPositions.splice(idx, 1);
    log.info(`Pending paper trade cancelled: ${pos.trade.id}`);
    return null;
  }

  return closePaperPosition(pos, price, reason, pos.partialPnlUsdt);
}

/**
 * Force-close ALL open paper positions (shutdown or kill switch).
 *
 * @param currentPrice - Current market price
 */
export function closeAllPaperPositions(currentPrice: number): Trade[] {
  const closed: Trade[] = [];
  while (openPositions.length > 0) {
    const pos = openPositions[0]!;
    if (pos.entryFilled) {
      closed.push(closePaperPosition(pos, currentPrice, 'MANUAL', pos.partialPnlUsdt));
    } else {
      openPositions.shift();
    }
  }
  return closed;
}

/** Get all currently open paper positions (for /positions command). */
export function getOpenPositions(): PaperPosition[] {
  return [...openPositions];
}

/** Get complete trade history (for /trades and /perf commands). */
export function getTradeHistory(): Trade[] {
  return [...tradeHistory];
}

// --------------- Helpers ---------------

/**
 * Check if it's time to force-close all positions.
 * Uses 15:30 NY time as the cutoff.
 */
function checkTimeExit(currentTime: Date): boolean {
  const ny = toNYTime(currentTime);
  const h = ny.getUTCHours();
  const m = ny.getUTCMinutes();
  return h > TIME_EXIT_NY_HOUR || (h === TIME_EXIT_NY_HOUR && m >= TIME_EXIT_NY_MINUTE);
}
