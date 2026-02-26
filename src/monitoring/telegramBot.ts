// ============================================================
// Telegram Bot - Trade Alerts & Status Notifications
// Phase 3: /trades /perf /risk /positions /kill commands
// ============================================================

import TelegramBot from 'node-telegram-bot-api';
import { DailyBias, Swing, LiquidityLevel, Timeframe, Trade } from '../types/index.js';
import type { PaperPosition } from '../execution/paperTrader.js';
import type { RiskState } from '../execution/riskManager.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('TelegramBot');

let bot: TelegramBot | null = null;
let chatId: string | null = null;

// --------------- Shared Bot State ---------------

interface BotState {
  bias: DailyBias | null;
  activeFVGsCount: number;
  liquidityLevels: LiquidityLevel[];
  swingCache: Partial<Record<Timeframe, Swing[]>>;
  openPositions: PaperPosition[];
  tradeHistory: Trade[];
  riskState: RiskState | null;
  accountBalance: number;
}

let botState: BotState = {
  bias: null,
  activeFVGsCount: 0,
  liquidityLevels: [],
  swingCache: {},
  openPositions: [],
  tradeHistory: [],
  riskState: null,
  accountBalance: 0,
};

/** Kill switch manual toggle (via /kill command) */
let manualKillSwitch = false;
export function isManualKillSwitchActive(): boolean { return manualKillSwitch; }

/**
 * Update the bot's shared state so command handlers can access live data.
 * Called by index.ts after each analysis cycle.
 */
export function setBotState(state: BotState): void {
  botState = state;
}

// --------------- Initialization ---------------

export function initTelegramBot(): void {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  chatId = process.env['TELEGRAM_CHAT_ID'] ?? null;

  if (!token) {
    log.info('TELEGRAM_BOT_TOKEN not set — Telegram alerts disabled');
    return;
  }

  try {
    bot = new TelegramBot(token, { polling: false });
    registerCommands();
    log.info('Telegram bot initialized (Phase 3)');
  } catch (err) {
    log.warn(`Telegram bot init failed: ${(err as Error).message}`);
    bot = null;
  }
}

// --------------- Commands ---------------

function registerCommands(): void {
  if (!bot) return;

  bot.on('message', (msg) => {
    const text = msg.text ?? '';
    const replyTo = String(msg.chat.id);

    if (text === '/status')    handleStatus(replyTo);
    else if (text === '/bias')      handleBias(replyTo);
    else if (text === '/swings')    handleSwings(replyTo);
    else if (text === '/levels')    handleLevels(replyTo);
    else if (text === '/trades')    handleTrades(replyTo);
    else if (text === '/perf')      handlePerf(replyTo);
    else if (text === '/risk')      handleRisk(replyTo);
    else if (text === '/positions') handlePositions(replyTo);
    else if (text === '/kill')      handleKill(replyTo);
    else if (text === '/help')      handleHelp(replyTo);
  });
}

function handleStatus(replyTo: string): void {
  const { bias, activeFVGsCount, liquidityLevels, openPositions, accountBalance } = botState;
  const activeLevels = liquidityLevels.filter((l) => l.state === 'ACTIVE').length;

  const lines = [
    '🤖 <b>ICT Bot Status — Phase 3</b>',
    `Bias: <b>${bias?.bias ?? 'Unknown'}</b> | AMD: ${bias?.amdPhase ?? 'Unknown'}`,
    `Framework: ${bias?.b1Framework ?? 'Unknown'} | Zone: ${bias?.b3Zone ?? 'Unknown'}`,
    `Active FVGs: ${activeFVGsCount} | Liquidity: ${activeLevels} levels`,
    `Open positions: ${openPositions.filter((p) => p.entryFilled).length}`,
    `Pending entries: ${openPositions.filter((p) => !p.entryFilled).length}`,
    `Paper balance: $${accountBalance.toFixed(2)} USDT`,
    `Kill switch: ${manualKillSwitch ? '🔴 ACTIVE' : '🟢 inactive'}`,
  ];

  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

function handleBias(replyTo: string): void {
  const { bias } = botState;
  if (!bias) {
    sendToChat(replyTo, '📊 Bias not yet computed — refreshes daily at 00:10 UTC').catch(() => {});
    return;
  }

  const date = bias.date.toISOString().split('T')[0];
  const lines = [
    `<b>📅 Daily Bias — ${date}</b>`,
    `Direction: <b>${bias.bias}</b> | TFs agree: ${bias.bothTFAgree ? '✅' : '⚠️'}`,
    `AMD Phase: ${bias.amdPhase}`,
    `Framework (B1): ${bias.b1Framework}`,
    `Draw Level (B2): ${bias.b2DrawLevel > 0 ? bias.b2DrawLevel.toFixed(2) : 'n/a'} (${bias.b2DrawType})`,
    `Zone (B3): ${bias.b3Zone} (${(bias.b3Depth * 100).toFixed(1)}% deep)`,
  ];

  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

function handleSwings(replyTo: string): void {
  const { swingCache } = botState;
  const tfs: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
  const lines = ['📊 <b>Recent Swings (last 5 per TF)</b>'];

  for (const tf of tfs) {
    const swings = swingCache[tf] ?? [];
    if (swings.length === 0) {
      lines.push(`<b>${tf}:</b> none`);
      continue;
    }
    const last5 = swings.slice(-5).reverse();
    const formatted = last5
      .map((s) => `  ${s.type === 'SWING_HIGH' ? '🔺' : '🔻'} ${s.level.toFixed(2)} @ ${s.timestamp.toISOString().slice(11, 16)}`)
      .join('\n');
    lines.push(`<b>${tf}:</b>\n${formatted}`);
  }

  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

function handleLevels(replyTo: string): void {
  const { liquidityLevels } = botState;
  const top5 = liquidityLevels.filter((l) => l.state === 'ACTIVE').slice(0, 5);

  if (top5.length === 0) {
    sendToChat(replyTo, '📍 No active liquidity levels mapped yet').catch(() => {});
    return;
  }

  const lines = ['📍 <b>Top 5 Liquidity Levels</b>'];
  for (const l of top5) {
    lines.push(`  ${l.level.toFixed(2)} [${l.type}] score=${l.score}`);
  }

  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

function handleTrades(replyTo: string): void {
  const { tradeHistory } = botState;
  const last5 = tradeHistory.slice(-5).reverse();

  if (last5.length === 0) {
    sendToChat(replyTo, '📋 No completed trades yet').catch(() => {});
    return;
  }

  const lines = ['📋 <b>Last 5 Trades</b>'];
  for (const t of last5) {
    const pnl = t.pnlUsdt ?? 0;
    const emoji = pnl >= 0 ? '✅' : '❌';
    const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`;
    lines.push(`${emoji} ${t.direction} [${t.status}] ${pnlStr} | R:R ${(t.rrAchieved ?? 0).toFixed(1)}x`);
  }

  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

function handlePerf(replyTo: string): void {
  const { tradeHistory, accountBalance } = botState;

  if (tradeHistory.length === 0) {
    sendToChat(replyTo, '📊 No completed trades to analyze yet').catch(() => {});
    return;
  }

  const closedTrades = tradeHistory.filter((t) => t.pnlUsdt !== undefined);
  const wins = closedTrades.filter((t) => (t.pnlUsdt ?? 0) > 0);
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnlUsdt ?? 0), 0);
  const avgRR = closedTrades.length > 0
    ? closedTrades.reduce((s, t) => s + (t.rrAchieved ?? 0), 0) / closedTrades.length
    : 0;
  const bestTrade = Math.max(...closedTrades.map((t) => t.pnlUsdt ?? 0));
  const worstTrade = Math.min(...closedTrades.map((t) => t.pnlUsdt ?? 0));
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;

  // Current streak
  let streak = 0;
  const lastIsWin = (tradeHistory[tradeHistory.length - 1]?.pnlUsdt ?? 0) > 0;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    const tw = (tradeHistory[i]?.pnlUsdt ?? 0) > 0;
    if (tw !== lastIsWin) break;
    streak++;
  }

  const lines = [
    '📊 <b>Performance Summary</b>',
    '─────────────────',
    `Total trades: ${closedTrades.length}`,
    `Win rate: ${winRate.toFixed(1)}%`,
    `Total PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
    `Avg R:R: ${avgRR.toFixed(1)}x`,
    `Best trade: +$${bestTrade.toFixed(2)}`,
    `Worst trade: $${worstTrade.toFixed(2)}`,
    `Current streak: ${streak}${lastIsWin ? 'W' : 'L'}`,
    `Balance: $${accountBalance.toFixed(2)} USDT`,
    `Paper mode: ✅`,
  ];

  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

function handleRisk(replyTo: string): void {
  const { riskState, accountBalance } = botState;

  if (!riskState) {
    sendToChat(replyTo, '🛡️ Risk state not yet initialized').catch(() => {});
    return;
  }

  const dailyPct = riskState.currentEquity > 0
    ? (riskState.dailyPnlUsdt / riskState.currentEquity) * 100
    : 0;
  const weeklyPct = riskState.peakEquity > 0
    ? (riskState.weeklyPnlUsdt / riskState.peakEquity) * 100
    : 0;
  const riskPerTrade = riskState.consecutiveLosses === 0 ? '1.00%'
    : riskState.consecutiveLosses === 1 ? '0.50%'
    : '0.25%';

  const lines = [
    '🛡️ <b>Risk State</b>',
    '────────────',
    `Consecutive losses: ${riskState.consecutiveLosses}`,
    `Risk per trade: ${riskPerTrade}`,
    `Daily PnL: ${riskState.dailyPnlUsdt >= 0 ? '+' : ''}$${riskState.dailyPnlUsdt.toFixed(2)} (${dailyPct.toFixed(2)}%)`,
    `Weekly PnL: ${riskState.weeklyPnlUsdt >= 0 ? '+' : ''}$${riskState.weeklyPnlUsdt.toFixed(2)} (${weeklyPct.toFixed(2)}%)`,
    `Peak equity: $${riskState.peakEquity.toFixed(2)}`,
    `Current equity: $${riskState.currentEquity.toFixed(2)}`,
    `Trades today: ${riskState.tradesToday}`,
    `Kill switch: ${manualKillSwitch ? '🔴 ACTIVE (manual)' : '🟢 inactive'}`,
  ];

  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

function handlePositions(replyTo: string): void {
  const { openPositions } = botState;

  if (openPositions.length === 0) {
    sendToChat(replyTo, '📭 No open paper positions').catch(() => {});
    return;
  }

  const lines = [`📂 <b>Open Positions (${openPositions.length})</b>`];

  for (const pos of openPositions) {
    const status = pos.entryFilled ? 'OPEN' : 'PENDING';
    const entry = pos.entryFilled ? `Entry: ${pos.trade.entryPrice?.toFixed(2)}` : `FVG: ${pos.fvgBottom.toFixed(2)}-${pos.fvgTop.toFixed(2)}`;
    lines.push(
      `${pos.trade.direction} [${status}] | ${entry}\n` +
      `  SL: ${pos.currentStopLoss.toFixed(2)} | TP1: ${pos.trade.tp1Level.toFixed(2)} | TP2: ${pos.trade.tp2Level.toFixed(2)}\n` +
      `  Size: ${pos.trade.sizeUsdt.toFixed(2)} USDT | Lev: ${pos.trade.leverage}x`,
    );
  }

  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

function handleKill(replyTo: string): void {
  manualKillSwitch = !manualKillSwitch;
  const msg = manualKillSwitch
    ? '🔴 <b>Manual kill switch ACTIVATED</b>\nNo new signals will be executed.'
    : '🟢 <b>Manual kill switch DEACTIVATED</b>\nBot is operating normally.';

  log.warn(`Manual kill switch toggled: ${manualKillSwitch}`);
  sendToChat(replyTo, msg).catch(() => {});
}

function handleHelp(replyTo: string): void {
  const lines = [
    '🤖 <b>ICT Bot Commands</b>',
    '/status    — Bot status + Phase 3 state',
    '/bias      — Current daily bias (B1/B2/B3)',
    '/swings    — Last 5 swings per timeframe',
    '/levels    — Top 5 active liquidity levels',
    '/trades    — Last 5 completed trades',
    '/perf      — Performance summary (win rate, PnL, R:R)',
    '/risk      — Risk state (losses, PnL caps, kill switch)',
    '/positions — Open paper positions + unrealized status',
    '/kill      — Toggle manual kill switch',
    '/help      — This message',
  ];
  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

// --------------- Core Messaging ---------------

async function sendToChat(targetChatId: string, message: string): Promise<void> {
  if (!bot) {
    log.debug(`[Telegram disabled] ${message}`);
    return;
  }
  await bot.sendMessage(targetChatId, message, { parse_mode: 'HTML' });
}

/**
 * Send an alert to the configured chat.
 * Falls back to logging if Telegram is not configured.
 */
export async function sendAlert(message: string): Promise<void> {
  if (!bot || !chatId) {
    log.info(`[ALERT] ${message}`);
    return;
  }
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    log.warn(`Failed to send Telegram alert: ${(err as Error).message}`);
  }
}

/** Send a formatted daily bias summary. */
export async function sendDailyBias(bias: DailyBias): Promise<void> {
  const date = bias.date.toISOString().split('T')[0];
  const message =
    `<b>📅 Daily Bias — ${date}</b>\n` +
    `Direction: <b>${bias.bias}</b> | Both TFs: ${bias.bothTFAgree ? '✅' : '⚠️'}\n` +
    `AMD Phase: ${bias.amdPhase}\n` +
    `Framework: ${bias.b1Framework}\n` +
    `Draw Level: ${bias.b2DrawLevel.toFixed(2)} (${bias.b2DrawType})\n` +
    `Zone: ${bias.b3Zone} (depth: ${(bias.b3Depth * 100).toFixed(1)}%)`;
  await sendAlert(message);
}

/** Send a notification when a new swing is detected (debug mode only). */
export async function sendSwingDetected(swing: Swing): Promise<void> {
  if (process.env['LOG_LEVEL'] !== 'debug') return;
  const emoji = swing.type === 'SWING_HIGH' ? '🔺' : '🔻';
  await sendAlert(
    `${emoji} <b>Swing ${swing.type}</b>\n` +
    `Timeframe: ${swing.timeframe}\n` +
    `Level: ${swing.level.toFixed(2)}\n` +
    `Time: ${swing.timestamp.toISOString()}`,
  );
}
