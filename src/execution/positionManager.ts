// ============================================================
// Position Manager - Phase 3
// ============================================================
// Orchestrates: Risk Check → Paper Trade → Position Monitoring → Exits.
// Holds the isPaperMode flag for easy Phase 4 real-execution switch.
// ============================================================

import { Trade, StructureState, TradeStatus } from '../types/index.js';
import { checkRiskAllowance, recordTradeResult, isKillSwitchActive } from './riskManager.js';
import { openPaperTrade, updatePaperPositions, forceClosePaperPosition, getOpenPositions } from './paperTrader.js';
import { evaluateExit } from '../engine/exitStrategy.js';
import { logTrade } from '../monitoring/tradeLogger.js';
import { sendAlert } from '../monitoring/telegramBot.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('PositionManager');

export class PositionManager {
  private readonly isPaperMode: boolean;
  private readonly onPartialPnL: (pnl: number) => void;

  constructor(
    paperMode: boolean = true,
    onPartialPnL: (pnl: number) => void = () => {},
  ) {
    this.isPaperMode = paperMode;
    this.onPartialPnL = onPartialPnL;
    log.info(`PositionManager initialised (${paperMode ? 'PAPER' : 'LIVE'} mode)`);
  }

  /**
   * Execute a trading signal through the full risk → open pipeline.
   *
   * @param signal         - Validated TradingSignal from signalDetector
   * @param accountBalance - Current account equity in USDT
   * @returns The opened Trade, or null if blocked by risk rules
   */
  async executeSignal(
    signal: {
      direction: 'LONG' | 'SHORT';
      entryFVG: { top: number; bottom: number; ce: number; id: string };
      stopLoss: number;
      tp1: number;
      tp2: number;
      rrRatio: number;
      displacementScore: number;
      confidence: number;
      sweep: { id: string };
    },
    accountBalance: number,
  ): Promise<Trade | null> {
    // Guard: prevent duplicate positions
    if (getOpenPositions().length > 0) {
      log.info('executeSignal: already have an open position — skipping');
      return null;
    }

    const entryPrice = signal.entryFVG.ce;

    // 1. Risk check
    const riskCheck = checkRiskAllowance(accountBalance, signal.rrRatio, entryPrice, signal.stopLoss);
    if (!riskCheck.allowed) {
      log.info(`Signal rejected by risk manager: ${riskCheck.reason}`);
      await sendAlert(`⛔ Signal rejected: ${riskCheck.reason}`);
      return null;
    }

    // 2. Open paper trade (Phase 4: replace with real order placement here)
    const trade = openPaperTrade(signal, riskCheck.positionSizeUsdt, riskCheck.leverage);

    log.info(
      `Paper trade opened: ${trade.direction} | size=${riskCheck.positionSizeUsdt.toFixed(2)} USDT | lev=${riskCheck.leverage}x`,
    );

    await sendAlert(
      `📈 <b>Paper Trade Opened</b>\n` +
      `Direction: <b>${trade.direction}</b>\n` +
      `Entry Zone: ${signal.entryFVG.bottom.toFixed(2)} – ${signal.entryFVG.top.toFixed(2)}\n` +
      `Size: ${riskCheck.positionSizeUsdt.toFixed(2)} USDT | Leverage: ${riskCheck.leverage}x\n` +
      `Risk: ${(riskCheck.riskPercent * 100).toFixed(2)}%\n` +
      `SL: ${trade.stopLoss.toFixed(2)} | TP1: ${trade.tp1Level.toFixed(2)} | TP2: ${trade.tp2Level.toFixed(2)}\n` +
      `R:R: ${signal.rrRatio.toFixed(1)}x | Confidence: ${signal.confidence}/100`,
    );

    return trade;
  }

  /**
   * Check and manage all open positions.
   * Called every 5 minutes (even outside killzones — SL/TP can hit anytime).
   *
   * @param currentPrice     - Latest market price
   * @param currentTime      - Current UTC time
   * @param structureState15m - Latest 15M structure state
   */
  async checkPositions(
    currentPrice: number,
    currentTime: Date,
    structureState15m: StructureState,
  ): Promise<void> {
    const positions = getOpenPositions();
    if (positions.length === 0) return;

    const killSwitch = isKillSwitchActive();

    // 1. Update paper positions (fill detection + TP/SL/time exits)
    const { closedTrades, alerts, partialPnlRealized } = updatePaperPositions(currentPrice, currentTime);

    // Immediately reflect TP1 partial close in account balance
    if (partialPnlRealized !== 0) {
      this.onPartialPnL(partialPnlRealized);
    }

    // 2. Process trades that were closed by the paper trader
    for (const trade of closedTrades) {
      await this.handleClosed(trade);
    }

    // 3. Send position-update alerts (TP1 hit, BE moved, etc.)
    for (const alert of alerts) {
      await sendAlert(alert);
    }

    // 4. Check structural exits for remaining filled positions
    for (const pos of getOpenPositions()) {
      if (!pos.entryFilled) continue;

      const exitDecision = evaluateExit(
        pos.trade,
        currentPrice,
        currentTime,
        structureState15m,
        killSwitch,
      );

      if (!exitDecision.shouldExit) continue;

      // KILL_SWITCH: handled by paperTrader's next update, but force now
      if (exitDecision.reason === 'KILL_SWITCH' || exitDecision.reason === 'STRUCTURAL') {
        const reason: TradeStatus = exitDecision.reason === 'KILL_SWITCH' ? 'KILLED' : 'STRUCTURAL';
        const closed = forceClosePaperPosition(
          pos.trade.id,
          exitDecision.exitPrice ?? currentPrice,
          reason,
        );

        if (closed) {
          await this.handleClosed(closed);
          const label = exitDecision.reason === 'STRUCTURAL' ? '🔄 Structural Exit' : '🚨 Kill Switch Exit';
          await sendAlert(
            `${label}\n${closed.direction} | PnL: ${(closed.pnlUsdt ?? 0) >= 0 ? '+' : ''}${(closed.pnlUsdt ?? 0).toFixed(2)} USDT`,
          );
        }
      }
    }
  }

  /** Handle a freshly closed trade: update risk state, log, Telegram alert. */
  private async handleClosed(trade: Trade): Promise<void> {
    const pnl = trade.pnlUsdt ?? 0;
    const isWin = pnl > 0;

    // Update risk state
    recordTradeResult(pnl, isWin);

    // Persist to CSV + Supabase
    await logTrade(trade).catch((err) => {
      log.warn(`logTrade failed: ${(err as Error).message}`);
    });

    // Telegram notification
    const emoji = isWin ? '✅' : '❌';
    const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (${(trade.pnlPct ?? 0).toFixed(2)}%)`;

    await sendAlert(
      `${emoji} <b>Trade Closed: ${trade.status}</b>\n` +
      `Direction: ${trade.direction}\n` +
      `Entry: ${trade.entryPrice?.toFixed(2)} → Exit: ${trade.exitPrice?.toFixed(2)}\n` +
      `PnL: <b>${pnlStr}</b>\n` +
      `R:R Achieved: ${(trade.rrAchieved ?? 0).toFixed(1)}x`,
    );
  }
}
