// ============================================================
// Telegram Bot - Trade Alerts & Status Notifications
// ============================================================

import TelegramBot from 'node-telegram-bot-api';
import { DailyBias, Swing } from '../types/index.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('TelegramBot');

let bot: TelegramBot | null = null;
let chatId: string | null = null;

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

/**
 * Register command handlers for the bot.
 */
function registerCommands(): void {
  if (!bot) return;

  bot.on('message', (msg) => {
    const text = msg.text ?? '';
    const replyTo = String(msg.chat.id);

    if (text === '/status') {
      sendToChat(replyTo, '🤖 ICT Bot is running. Phase 1 active.').catch(() => {});
    } else if (text === '/swings') {
      sendToChat(replyTo, '📊 /swings — Not implemented yet (Phase 2)').catch(() => {});
    } else if (text === '/sessions') {
      sendToChat(replyTo, '⏰ /sessions — Not implemented yet (Phase 2)').catch(() => {});
    } else if (text === '/pause') {
      sendToChat(replyTo, '⏸ /pause — Not implemented yet (Phase 2)').catch(() => {});
    }
  });
}

/**
 * Send a message to a specific chat ID.
 */
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
 * Placeholder — full formatting in Phase 2.
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
 * Send a notification when a new swing is detected (optional, debug mode).
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
