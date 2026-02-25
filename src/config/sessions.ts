// ============================================================
// Session & Killzone Definitions
// All times in NY time (UTC-5 standard / UTC-4 DST)
// ============================================================

import { Session, SessionName } from '../types/index.js';

export const SESSIONS: Record<SessionName, Session> = {
  ASIAN: {
    name: 'ASIAN',
    startHour: 20,
    startMinute: 0,
    endHour: 0,
    endMinute: 0,
    isTradeable: false,
    role: 'Mark Asian Range H/L',
  },
  LONDON: {
    name: 'LONDON',
    startHour: 2,
    startMinute: 0,
    endHour: 5,
    endMinute: 0,
    isTradeable: true,
    role: 'Killzone - creates daily H or L',
  },
  LONDON_TO_NY: {
    name: 'LONDON_TO_NY',
    startHour: 5,
    startMinute: 0,
    endHour: 7,
    endMinute: 0,
    isTradeable: false,
    role: 'Transition',
  },
  NY_PRE_MARKET: {
    name: 'NY_PRE_MARKET',
    startHour: 7,
    startMinute: 0,
    endHour: 8,
    endMinute: 30,
    isTradeable: false,
    role: 'Mark H/L for stop hunts',
  },
  NY_MORNING: {
    name: 'NY_MORNING',
    startHour: 8,
    startMinute: 30,
    endHour: 12,
    endMinute: 0,
    isTradeable: true,
    role: 'PRIMARY killzone',
  },
  NY_LUNCH: {
    name: 'NY_LUNCH',
    startHour: 12,
    startMinute: 0,
    endHour: 13,
    endMinute: 0,
    isTradeable: false,
    role: 'NO TRADE ZONE',
  },
  NY_AFTERNOON: {
    name: 'NY_AFTERNOON',
    startHour: 13,
    startMinute: 30,
    endHour: 16,
    endMinute: 0,
    isTradeable: true, // conditionally tradeable
    role: 'Continuation or reversal',
  },
  NY_CLOSE: {
    name: 'NY_CLOSE',
    startHour: 16,
    startMinute: 0,
    endHour: 17,
    endMinute: 0,
    isTradeable: false,
    role: 'Close positions',
  },
};

/** Sessions where trading is strictly forbidden */
export const NO_TRADE_SESSIONS: SessionName[] = ['NY_LUNCH', 'NY_CLOSE'];

/** Primary killzone sessions */
export const KILLZONE_SESSIONS: SessionName[] = ['LONDON', 'NY_MORNING', 'NY_AFTERNOON'];
