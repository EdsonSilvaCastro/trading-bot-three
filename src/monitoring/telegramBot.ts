// ============================================================
// Telegram Bot - Trade Alerts & Status Notifications
// Phase 2: setBotState for cache access + Phase 2 commands
// ============================================================

import TelegramBot from 'node-telegram-bot-api';
import { DailyBias, Swing, LiquidityLevel, Timeframe } from '../types/index.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('TelegramBot');

let bot: TelegramBot | null = null;
let chatId: string | null = null;

// --------------- Shared Bot State ---------------

/** State container updated by index.ts on each analysis cycle */
interface BotState {
  bias: DailyBias | null;
  activeFVGsCount: number;
  liquidityLevels: LiquidityLevel[];
  swingCache: Partial<Record<Timeframe, Swing[]>>;
}

let botState: BotState = {
  bias: null,
  activeFVGsCount: 0,
  liquidityLevels: [],
  swingCache: {},
};

/**
 * Update the bot's shared state so command handlers can access live data.
 * Called by index.ts after each analysis cycle.
 */
export function setBotState(state: BotState): void {
  botState = state;
}

// --------------- Initialization ---------------

/**
 * Initialize the Telegram bot.
 * Gracefully no-ops if TELEGRAM_BOT_TOKEN is not set.
 */
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
    log.info('Telegram bot initialized');
  } catch (err) {
    log.warn(`Telegram bot init failed: ${(err as Error).message}`);
    bot = null;
  }
}

// --------------- Commands ---------------

/** Register command handlers for the bot. */
function registerCommands(): void {
  if (!bot) return;

  bot.on('message', (msg) => {
    const text = msg.text ?? '';
    const replyTo = String(msg.chat.id);

    if (text === '/status') handleStatus(replyTo);
    else if (text === '/bias') handleBias(replyTo);
    else if (text === '/swings') handleSwings(replyTo);
    else if (text === '/levels') handleLevels(replyTo);
    else if (text === '/help') handleHelp(replyTo);
    else if (text === '/sessions') {
      sendToChat(replyTo, '⏰ Use /status to see current session info').catch(() => {});
    }
  });
}

function handleStatus(replyTo: string): void {
  const { bias, activeFVGsCount, liquidityLevels } = botState;
  const activeLevels = liquidityLevels.filter((l) => l.state === 'ACTIVE').length;

  const lines = [
    '🤖 <b>ICT Bot Status — Phase 2</b>',
    `Bias: <b>${bias?.bias ?? 'Unknown'}</b>`,
    `AMD Phase: ${bias?.amdPhase ?? 'Unknown'}`,
    `Framework: ${bias?.b1Framework ?? 'Unknown'}`,
    `Zone: ${bias?.b3Zone ?? 'Unknown'}`,
    `Active FVGs: ${activeFVGsCount}`,
    `Liquidity Levels: ${activeLevels} active / ${liquidityLevels.length} total`,
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
    `Direction: <b>${bias.bias}</b>`,
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
      .map((s) => {
        const emoji = s.type === 'SWING_HIGH' ? '🔺' : '🔻';
        return `  ${emoji} ${s.level.toFixed(2)} @ ${s.timestamp.toISOString().slice(11, 16)}`;
      })
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

function handleHelp(replyTo: string): void {
  const lines = [
    '🤖 <b>ICT Bot Commands</b>',
    '/status — Overall bot status + Phase 2 state',
    '/bias — Current daily bias (B1/B2/B3 framework)',
    '/swings — Last 5 swings per timeframe',
    '/levels — Top 5 active liquidity levels',
    '/help — This message',
  ];
  sendToChat(replyTo, lines.join('\n')).catch(() => {});
}

// --------------- Core Messaging ---------------

/** Send a message to a specific chat ID. */
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
 *
 * @param message - Message text (supports HTML formatting)
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

/**
 * Send a formatted daily bias summary.
 *
 * @param bias - Daily bias object
 */
export async function sendDailyBias(bias: DailyBias): Promise<void> {
  const date = bias.date.toISOString().split('T')[0];
  const message =
    `<b>📅 Daily Bias — ${date}</b>\n` +
    `Direction: <b>${bias.bias}</b>\n` +
    `AMD Phase: ${bias.amdPhase}\n` +
    `Framework: ${bias.b1Framework}\n` +
    `Draw Level: ${bias.b2DrawLevel.toFixed(2)} (${bias.b2DrawType})\n` +
    `Zone: ${bias.b3Zone} (depth: ${(bias.b3Depth * 100).toFixed(1)}%)`;

  await sendAlert(message);
}

/**
 * Send a notification when a new swing is detected (debug mode only).
 *
 * @param swing - Detected swing point
 */
export async function sendSwingDetected(swing: Swing): Promise<void> {
  if (process.env['LOG_LEVEL'] !== 'debug') return;

  const emoji = swing.type === 'SWING_HIGH' ? '🔺' : '🔻';
  const message =
    `${emoji} <b>Swing ${swing.type}</b>\n` +
    `Timeframe: ${swing.timeframe}\n` +
    `Level: ${swing.level.toFixed(2)}\n` +
    `Time: ${swing.timestamp.toISOString()}`;

  await sendAlert(message);
}
