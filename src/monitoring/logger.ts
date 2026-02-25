// ============================================================
// Structured Logger using Winston
// ============================================================

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const { combine, timestamp, colorize, printf, errors } = winston.format;

// Custom log format: [timestamp] LEVEL [module] message
const logFormat = printf(({ level, message, timestamp: ts, module: mod, stack }) => {
  const moduleLabel = mod ? ` [${mod}]` : '';
  const stackTrace = stack ? `\n${stack}` : '';
  return `${ts} ${level}${moduleLabel}: ${message}${stackTrace}`;
});

const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  logFormat,
);

const fileFormat = combine(
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  logFormat,
);

const rootLogger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new DailyRotateFile({
      filename: path.join(logsDir, 'bot-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      format: fileFormat,
    }),
  ],
});

/**
 * Create a child logger scoped to a module name.
 * All messages will be prefixed with [moduleName].
 *
 * @param moduleName - Name of the module (e.g. 'CandleCollector')
 */
export function createModuleLogger(moduleName: string): winston.Logger {
  return rootLogger.child({ module: moduleName });
}

export default rootLogger;
