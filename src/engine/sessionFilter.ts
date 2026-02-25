// ============================================================
// Session Filter - Killzone Time Filter
// All session times are in NY time (UTC-5 EST / UTC-4 EDT)
// ============================================================

import { Session, SessionName, Candle } from '../types/index.js';
import { SESSIONS, NO_TRADE_SESSIONS, KILLZONE_SESSIONS } from '../config/sessions.js';

// --------------- NY Time Utilities ---------------

/**
 * Determine if a given UTC date is in US Eastern Daylight Time (EDT / UTC-4).
 * DST in the US starts on the second Sunday of March and ends on the first Sunday of November.
 */
function isEasternDST(utcDate: Date): boolean {
  const year = utcDate.getUTCFullYear();

  // Second Sunday of March at 07:00 UTC (= 02:00 EST)
  const dstStart = getNthSundayOfMonth(year, 2, 2); // March = month 2 (0-indexed)
  dstStart.setUTCHours(7, 0, 0, 0);

  // First Sunday of November at 06:00 UTC (= 02:00 EDT)
  const dstEnd = getNthSundayOfMonth(year, 10, 1); // November = month 10 (0-indexed)
  dstEnd.setUTCHours(6, 0, 0, 0);

  return utcDate >= dstStart && utcDate < dstEnd;
}

/**
 * Get the Nth occurrence of a weekday (0=Sun) in a given month/year.
 */
function getNthSundayOfMonth(year: number, month: number, nth: number): Date {
  const d = new Date(Date.UTC(year, month, 1));
  // Advance to first Sunday
  while (d.getUTCDay() !== 0) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // Advance N-1 more weeks
  d.setUTCDate(d.getUTCDate() + (nth - 1) * 7);
  return d;
}

/**
 * Convert a UTC Date to NY time representation.
 * Returns a Date object where getUTCHours() gives the NY local hour.
 */
export function toNYTime(date: Date): Date {
  const offsetHours = isEasternDST(date) ? -4 : -5;
  return new Date(date.getTime() + offsetHours * 60 * 60 * 1000);
}

/**
 * Get NY hour and minute from a UTC date.
 */
function getNYHourMinute(utcDate: Date): { hour: number; minute: number } {
  const ny = toNYTime(utcDate);
  return { hour: ny.getUTCHours(), minute: ny.getUTCMinutes() };
}

/**
 * Convert NY hour:minute to a comparable number (e.g. 8:30 -> 510).
 */
function toMinutes(hour: number, minute: number): number {
  return hour * 60 + minute;
}

// --------------- Session Detection ---------------

/**
 * Check if a given NY time (as hour/minute) falls within a session.
 * Handles sessions that cross midnight (e.g. ASIAN: 20:00-00:00).
 */
function isInSession(
  session: Session,
  hour: number,
  minute: number,
): boolean {
  const current = toMinutes(hour, minute);
  const start = toMinutes(session.startHour, session.startMinute);
  const end = toMinutes(session.endHour, session.endMinute);

  if (end === 0) {
    // Session ends at midnight (00:00 = 1440 minutes as end boundary)
    return current >= start;
  }

  if (start > end) {
    // Session crosses midnight
    return current >= start || current < end;
  }

  return current >= start && current < end;
}

/**
 * Get the active session for a given UTC timestamp.
 * Returns null if no session is currently active (gaps between sessions).
 *
 * @param date - UTC date (defaults to now)
 */
export function getCurrentSession(date: Date = new Date()): Session | null {
  const { hour, minute } = getNYHourMinute(date);

  for (const session of Object.values(SESSIONS)) {
    if (isInSession(session, hour, minute)) {
      return session;
    }
  }

  return null;
}

/**
 * Returns true if the bot is currently in an active tradeable killzone.
 *
 * @param date - UTC date (defaults to now)
 */
export function isKillzoneActive(date: Date = new Date()): boolean {
  const session = getCurrentSession(date);
  return session !== null && session.isTradeable;
}

/**
 * Returns true if trading is strictly forbidden at this time.
 * NY_LUNCH and NY_CLOSE are no-trade zones.
 *
 * @param date - UTC date (defaults to now)
 */
export function isNoTradeZone(date: Date = new Date()): boolean {
  const session = getCurrentSession(date);
  if (!session) return false;
  return (NO_TRADE_SESSIONS as string[]).includes(session.name);
}

/**
 * Compute the session high and low from a candle array for a named session on a given day.
 * Filters candles that fall within the session time window on the same NY calendar date.
 *
 * @param sessionName - Which session to compute range for
 * @param date        - The reference date (UTC)
 * @param candles     - Candle array to search through
 */
export function getSessionHighLow(
  sessionName: SessionName,
  date: Date,
  candles: Candle[],
): { high: number; low: number } | null {
  const session = SESSIONS[sessionName];
  const nyRef = toNYTime(date);
  const refDateStr = `${nyRef.getUTCFullYear()}-${nyRef.getUTCMonth()}-${nyRef.getUTCDate()}`;

  const sessionCandles = candles.filter((c) => {
    const nyCandle = toNYTime(c.timestamp);
    const candleDateStr = `${nyCandle.getUTCFullYear()}-${nyCandle.getUTCMonth()}-${nyCandle.getUTCDate()}`;
    const { hour, minute } = { hour: nyCandle.getUTCHours(), minute: nyCandle.getUTCMinutes() };
    return candleDateStr === refDateStr && isInSession(session, hour, minute);
  });

  if (sessionCandles.length === 0) return null;

  const high = Math.max(...sessionCandles.map((c) => c.high));
  const low = Math.min(...sessionCandles.map((c) => c.low));

  return { high, low };
}

/**
 * Get the next time a killzone (tradeable session) will start.
 * Searches up to 24 hours ahead in 1-minute increments.
 *
 * @param date - UTC start time (defaults to now)
 */
export function getNextKillzoneStart(date: Date = new Date()): Date {
  const killzoneSessions = KILLZONE_SESSIONS.map((name) => SESSIONS[name]);

  // Check up to 24 hours ahead in 5-minute increments for performance
  for (let minutesAhead = 1; minutesAhead <= 24 * 60; minutesAhead += 5) {
    const candidate = new Date(date.getTime() + minutesAhead * 60 * 1000);
    const { hour, minute } = getNYHourMinute(candidate);

    for (const session of killzoneSessions) {
      if (isInSession(session, hour, minute)) {
        // Rewind to the exact start of this session on this day
        return findSessionStart(session, candidate);
      }
    }
  }

  // Fallback: return 24h from now
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Given a date that's known to be inside a session, find the exact start timestamp.
 */
function findSessionStart(session: Session, insideDate: Date): Date {
  const nyDate = toNYTime(insideDate);
  const isDST = isEasternDST(insideDate);
  const offsetMs = (isDST ? 4 : 5) * 60 * 60 * 1000;

  // Build start time in NY, then convert back to UTC
  const startNY = new Date(Date.UTC(
    nyDate.getUTCFullYear(),
    nyDate.getUTCMonth(),
    nyDate.getUTCDate(),
    session.startHour,
    session.startMinute,
    0,
    0,
  ));

  return new Date(startNY.getTime() + offsetMs);
}

/**
 * Get a human-readable summary of the current session status.
 */
export function getSessionStatus(date: Date = new Date()): string {
  const session = getCurrentSession(date);
  const { hour, minute } = getNYHourMinute(date);
  const isDST = isEasternDST(date);
  const tzLabel = isDST ? 'EDT' : 'EST';
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${tzLabel}`;

  if (!session) {
    const next = getNextKillzoneStart(date);
    const minsUntil = Math.round((next.getTime() - date.getTime()) / 60_000);
    return `No active session at ${timeStr}. Next killzone in ~${minsUntil}m`;
  }

  const tradeStatus = session.isTradeable ? 'TRADEABLE' : 'NO TRADE';
  return `[${session.name}] ${tradeStatus} | ${timeStr} | ${session.role}`;
}
