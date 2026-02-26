// ============================================================
// Liquidity Mapper - Phase 2
// ============================================================
// Maps all liquidity pools where institutional stops accumulate.
// Every swing high = Buy-Side Liquidity (BSL), every swing low = SSL.
// Equal highs/lows, previous day/week highs/lows, and session
// highs/lows are additional high-probability liquidity targets.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { Candle, LiquidityLevel, LiquidityState, LiquidityType, Swing, Timeframe } from '../types/index.js';
import { SCORING_CONFIG } from '../config/scoring.js';
import { createModuleLogger } from '../monitoring/logger.js';

const log = createModuleLogger('LiquidityMapper');

export type { LiquidityLevel };

/** Days before a level expires if never swept (IPDA cycle) */
const EXPIRY_DAYS = 20;
/** Milliseconds in a day */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --------------- Scoring ---------------

/**
 * Score a liquidity level based on its characteristics (0-11).
 *
 * Scoring:
 *   - Base: 1 point per swing forming the level (capped at 3)
 *   - Timeframe bonus: +1 for 1H, +2 for 4H, +3 for Daily
 *   - EQ bonus: +2 if it's an EQH/EQL (multiple touches = more stops)
 *   - Age bonus: +1 if "clean" (untouched) for > 3 days
 *   - Session bonus: +1 if aligns with session high/low
 */
export function scoreLiquidityLevel(level: LiquidityLevel): number {
  return level.score;
}

/** Compute the initial score for a new level */
function computeScore(params: {
  swingCount: number;
  timeframe: Timeframe;
  isEQ: boolean;
  timestamp: Date;
  isSessionLevel: boolean;
}): number {
  const { swingCount, timeframe, isEQ, timestamp, isSessionLevel } = params;

  // Base: number of swings contributing (capped at 3)
  const baseScore = Math.min(3, swingCount);

  // Timeframe bonus
  const tfBonus = timeframe === '1d' ? 3 : timeframe === '4h' ? 2 : timeframe === '1h' ? 1 : 0;

  // EQ bonus (equal high/low cluster = more stops = more significant)
  const eqBonus = isEQ ? 2 : 0;

  // Age bonus: untouched level > 3 days is more significant (more stops accumulated)
  const ageMs = Date.now() - timestamp.getTime();
  const ageDays = ageMs / MS_PER_DAY;
  const ageBonus = ageDays > SCORING_CONFIG.liquidity.cleanHighAge ? 1 : 0;

  // Session bonus
  const sessionBonus = isSessionLevel ? 1 : 0;

  return Math.min(11, baseScore + tfBonus + eqBonus + ageBonus + sessionBonus);
}

// --------------- Level Builders ---------------

/** Build BSL/SSL levels directly from swing points. */
function buildSwingLevels(
  swings: Swing[],
  timeframe: Timeframe,
): LiquidityLevel[] {
  return swings.map((swing) => {
    const type: LiquidityType = swing.type === 'SWING_HIGH' ? 'BSL' : 'SSL';
    const score = computeScore({
      swingCount: 1,
      timeframe,
      isEQ: false,
      timestamp: swing.timestamp,
      isSessionLevel: false,
    });

    return {
      id: uuidv4(),
      timestamp: swing.timestamp,
      level: swing.level,
      type,
      score,
      state: 'ACTIVE' as LiquidityState,
    };
  });
}

/**
 * Detect equal highs / equal lows from swing arrays.
 * Swings within eqTolerance (0.1%) of each other form an EQH/EQL cluster.
 */
function buildEQlevels(swings: Swing[], timeframe: Timeframe): LiquidityLevel[] {
  const { eqTolerance } = SCORING_CONFIG.liquidity;
  const eqLevels: LiquidityLevel[] = [];
  const used = new Set<string>();

  const highs = swings.filter((s) => s.type === 'SWING_HIGH');
  const lows = swings.filter((s) => s.type === 'SWING_LOW');

  for (const group of [highs, lows]) {
    for (let i = 0; i < group.length; i++) {
      if (used.has(group[i]!.id)) continue;

      const base = group[i]!;
      const cluster = [base];

      for (let j = i + 1; j < group.length; j++) {
        if (used.has(group[j]!.id)) continue;
        const other = group[j]!;
        // Within 0.1% tolerance
        if (Math.abs(other.level - base.level) / base.level <= eqTolerance) {
          cluster.push(other);
          used.add(other.id);
        }
      }

      if (cluster.length >= 2) {
        used.add(base.id);
        const avgLevel = cluster.reduce((s, c) => s + c.level, 0) / cluster.length;
        const type: LiquidityType = base.type === 'SWING_HIGH' ? 'EQH' : 'EQL';
        const score = computeScore({
          swingCount: cluster.length,
          timeframe,
          isEQ: true,
          timestamp: base.timestamp,
          isSessionLevel: false,
        });

        eqLevels.push({
          id: uuidv4(),
          timestamp: base.timestamp,
          level: avgLevel,
          type,
          score,
          state: 'ACTIVE',
        });
      }
    }
  }

  return eqLevels;
}

/** Build PDH/PDL from the most recent completed daily candle. */
function buildPreviousDayLevels(dailyCandles: Candle[]): LiquidityLevel[] {
  // Last 2 daily candles: index -1 is current (incomplete), index -2 is previous complete day
  if (dailyCandles.length < 2) return [];

  const prevDay = dailyCandles[dailyCandles.length - 2]!;
  const score = computeScore({ swingCount: 1, timeframe: '1d', isEQ: false, timestamp: prevDay.timestamp, isSessionLevel: false });

  return [
    {
      id: uuidv4(),
      timestamp: prevDay.timestamp,
      level: prevDay.high,
      type: 'PDH',
      score,
      state: 'ACTIVE',
    },
    {
      id: uuidv4(),
      timestamp: prevDay.timestamp,
      level: prevDay.low,
      type: 'PDL',
      score,
      state: 'ACTIVE',
    },
  ];
}

/** Build PWH/PWL from the last 5 daily candles (Mon-Fri). */
function buildPreviousWeekLevels(dailyCandles: Candle[]): LiquidityLevel[] {
  if (dailyCandles.length < 6) return [];

  // Last 5 completed daily candles (skip current)
  const weekCandles = dailyCandles.slice(-6, -1);
  const high = Math.max(...weekCandles.map((c) => c.high));
  const low = Math.min(...weekCandles.map((c) => c.low));
  const ts = weekCandles[0]!.timestamp;
  const score = computeScore({ swingCount: 5, timeframe: '1d', isEQ: false, timestamp: ts, isSessionLevel: false });

  return [
    { id: uuidv4(), timestamp: ts, level: high, type: 'PWH', score, state: 'ACTIVE' },
    { id: uuidv4(), timestamp: ts, level: low, type: 'PWL', score, state: 'ACTIVE' },
  ];
}

/** Build SESSION_HIGH/SESSION_LOW from session data. */
function buildSessionLevels(
  sessionHighLows: { asian?: { high: number; low: number }; london?: { high: number; low: number } },
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];
  const now = new Date();

  if (sessionHighLows.asian) {
    const score = computeScore({ swingCount: 1, timeframe: '1h', isEQ: false, timestamp: now, isSessionLevel: true });
    levels.push(
      { id: uuidv4(), timestamp: now, level: sessionHighLows.asian.high, type: 'SESSION_HIGH', score, state: 'ACTIVE' },
      { id: uuidv4(), timestamp: now, level: sessionHighLows.asian.low, type: 'SESSION_LOW', score, state: 'ACTIVE' },
    );
  }

  if (sessionHighLows.london) {
    const score = computeScore({ swingCount: 1, timeframe: '1h', isEQ: false, timestamp: now, isSessionLevel: true });
    levels.push(
      { id: uuidv4(), timestamp: now, level: sessionHighLows.london.high, type: 'SESSION_HIGH', score, state: 'ACTIVE' },
      { id: uuidv4(), timestamp: now, level: sessionHighLows.london.low, type: 'SESSION_LOW', score, state: 'ACTIVE' },
    );
  }

  return levels;
}

/** Deduplicate levels that are within 0.05% of each other (keep highest scored). */
function deduplicateLevels(levels: LiquidityLevel[]): LiquidityLevel[] {
  const DEDUP_TOLERANCE = 0.0005; // 0.05%
  const result: LiquidityLevel[] = [];

  for (const level of levels) {
    const existing = result.find(
      (r) => Math.abs(r.level - level.level) / level.level <= DEDUP_TOLERANCE,
    );
    if (existing) {
      // Keep the higher-scored one
      if (level.score > existing.score) {
        result.splice(result.indexOf(existing), 1, level);
      }
    } else {
      result.push(level);
    }
  }

  return result;
}

// --------------- Public API ---------------

/**
 * Map all active liquidity levels from multi-timeframe candles and swings.
 *
 * @param candles        - Candles per timeframe (use daily for PDH/PDL/PWH/PWL)
 * @param swings         - Swings per timeframe (BSL/SSL and EQH/EQL detection)
 * @param sessionHighLows - Optional Asian/London session ranges
 */
export function mapLiquidityLevels(
  candles: Partial<Record<Timeframe, Candle[]>>,
  swings: Partial<Record<Timeframe, Swing[]>>,
  sessionHighLows?: { asian?: { high: number; low: number }; london?: { high: number; low: number } },
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];

  // 1. BSL/SSL from each timeframe's swings
  const swingTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
  for (const tf of swingTimeframes) {
    const tfSwings = swings[tf] ?? [];
    if (tfSwings.length > 0) {
      levels.push(...buildSwingLevels(tfSwings, tf));
      levels.push(...buildEQlevels(tfSwings, tf));
    }
  }

  // 2. PDH/PDL and PWH/PWL from daily candles
  const dailyCandles = candles['1d'] ?? [];
  if (dailyCandles.length >= 2) {
    levels.push(...buildPreviousDayLevels(dailyCandles));
  }
  if (dailyCandles.length >= 6) {
    levels.push(...buildPreviousWeekLevels(dailyCandles));
  }

  // 3. Session levels
  if (sessionHighLows) {
    levels.push(...buildSessionLevels(sessionHighLows));
  }

  // 4. Deduplicate and sort by score (highest first)
  const deduplicated = deduplicateLevels(levels).sort((a, b) => b.score - a.score);

  log.debug(`mapLiquidityLevels: ${deduplicated.length} levels mapped`);
  return deduplicated;
}

/**
 * Update liquidity level states based on recent price action.
 *
 * State transitions:
 *   ACTIVE → SWEPT: price traded through the level (wick or close)
 *     - BSL/EQH/PDH/PWH/SESSION_HIGH: candle.high >= level
 *     - SSL/EQL/PDL/PWL/SESSION_LOW:  candle.low <= level
 *   ACTIVE → EXPIRED: level is > 20 days old without being swept
 *
 * @param levels       - Current liquidity levels
 * @param latestCandles - Recent candles to check against
 */
export function updateLiquidityStates(
  levels: LiquidityLevel[],
  latestCandles: Candle[],
): LiquidityLevel[] {
  const now = Date.now();
  const HIGH_TYPES: Set<LiquidityType> = new Set(['BSL', 'EQH', 'PDH', 'PWH', 'SESSION_HIGH']);

  return levels.map((level) => {
    if (level.state !== 'ACTIVE') return level;

    // Check expiry first
    const ageDays = (now - level.timestamp.getTime()) / MS_PER_DAY;
    if (ageDays > EXPIRY_DAYS) {
      log.debug(`Level ${level.type} @ ${level.level.toFixed(2)} expired after ${ageDays.toFixed(1)} days`);
      return { ...level, state: 'EXPIRED' };
    }

    // Check if swept by candles that formed AFTER the level was created.
    // Skipping older candles prevents the level from being instantly swept by
    // historical candles that pre-date the level's existence.
    const isHighLevel = HIGH_TYPES.has(level.type);
    for (const candle of latestCandles) {
      if (candle.timestamp.getTime() <= level.timestamp.getTime()) continue;

      const swept = isHighLevel
        ? candle.high >= level.level // High level swept when price runs above it
        : candle.low <= level.level; // Low level swept when price runs below it

      if (swept) {
        log.debug(`Level ${level.type} @ ${level.level.toFixed(2)} SWEPT at ${candle.timestamp.toISOString()}`);
        return { ...level, state: 'SWEPT', sweptAt: candle.timestamp };
      }
    }

    return level;
  });
}
