# Claude Code Prompt — ICT Price Action Bot (Phase 2: Analyzers + Bias Engine)

## Paste this into Claude Code:

---

```
We're continuing the ICT Price Action Bot project. Phase 1 (scaffold, data collector, swing detector, session filter) is complete. Now we're implementing PHASE 2: all the analyzer modules + bias engine + signal detector.

BEFORE implementing Phase 2, fix these 3 bugs from Phase 1.

## ═══════════════════════════════════════════
## PHASE 1 BUG FIXES (do these FIRST)
## ═══════════════════════════════════════════

### FIX 1: tsconfig module conflict

All imports use `.js` extensions (ESM pattern) but tsconfig has `"module": "commonjs"`. Fix by updating tsconfig.json to use ESM properly:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

Also add `"type": "module"` to package.json, and update the dev script to use `tsx` instead of `ts-node` (tsx handles ESM natively):

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/index.js",
  "dev": "tsx src/index.ts",
  "dev:watch": "tsx --watch src/index.ts",
  "typecheck": "tsc --noEmit"
}
```

Install tsx: `npm install -D tsx` and remove ts-node/ts-node-dev from devDependencies.

### FIX 2: Swing detection re-detects everything every cycle

In `src/index.ts`, `runTimeframeUpdate()` calls `detectAndStoreSwings(merged, [])` with an empty array, causing ALL swings to be "new" every cycle.

Fix: Add a swing cache alongside the candle cache:

```typescript
const swingCache: Partial<Record<Timeframe, Swing[]>> = {};
```

Update `runTimeframeUpdate()`:
```typescript
if (runSwings && merged.length >= 7) {
  const existingSwings = swingCache[tf] ?? [];
  const newSwings = await detectAndStoreSwings(merged, existingSwings);
  if (newSwings.length > 0) {
    swingCache[tf] = [...existingSwings, ...newSwings].slice(-200); // Keep last 200
    log.info(`[${tf}] ${newSwings.length} new swing(s) detected`);
  }
}
```

Also fix the startup section to populate the swing cache:
```typescript
const newSwings = await detectAndStoreSwings(candles, []);
swingCache[tf as Timeframe] = newSwings;
```

### FIX 3: Session midnight edge case

In `src/engine/sessionFilter.ts`, the `isInSession` function handles `end === 0` (midnight) incorrectly. When end is 0 (Asian session ends at midnight), `current >= start` matches any time after 20:00 without upper bound.

Fix the midnight check:
```typescript
if (end === 0) {
  // Session ends at midnight: match from start to 23:59
  return current >= start;
  // This works because no other sessions overlap with 20:00-23:59
  // but make it explicit for safety:
}

// Replace with:
if (start > end || end === 0) {
  // Session crosses midnight (or ends at midnight)
  const effectiveEnd = end === 0 ? 1440 : end;
  return current >= start || current < effectiveEnd;
}
```

Wait — actually the Asian session (20:00 to 00:00) DOES cross midnight. When it's 22:00 NY time, current = 1320, start = 1200, so `current >= start` = true. That's correct. When it's 01:00 NY time, current = 60, start = 1200, so `current >= start` = false. That's correct too.

BUT the real issue: what about sessions that cross midnight where end > 0? The current code handles `start > end` separately. Actually the existing code is almost fine. Just make the midnight case explicit:

```typescript
function isInSession(session: Session, hour: number, minute: number): boolean {
  const current = toMinutes(hour, minute);
  const start = toMinutes(session.startHour, session.startMinute);
  const end = toMinutes(session.endHour, session.endMinute);

  // Session ends at midnight — treat as 24:00
  const effectiveEnd = end === 0 ? 1440 : end;

  if (start >= effectiveEnd) {
    // Session wraps past midnight
    return current >= start || current < effectiveEnd;
  }

  return current >= start && current < effectiveEnd;
}
```

This is cleaner and handles all edge cases.

## ═══════════════════════════════════════════
## PHASE 2: ANALYZER IMPLEMENTATIONS
## ═══════════════════════════════════════════

The project has placeholder files in `src/analyzer/` and `src/engine/`. Implement them all following the specs below. The ICT 2022 Mentorship 3-step trading model is:

  Step 1: Price sweeps a liquidity pool (clean highs/lows, old highs/lows)
  Step 2: Market Structure Shift (break of recent high/low after sweep)
  Step 3: Fair Value Gap entry within the displacement range

## ───────────────────────────────────────────
## FILE 1: src/analyzer/displacementScorer.ts
## ───────────────────────────────────────────

Replace the placeholder. This scores "how aggressive" a price move is. ICT says displacement should be "so obvious, similar to how an Elephant would jump into a Children's pool."

### Implementation:

```typescript
/**
 * Calculate ATR (Average True Range) over a given period.
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
 */
export function calculateATR(candles: Candle[], period: number = 14): number
```

```typescript
/**
 * Score displacement quality from 0-10 based on:
 *   - atrScore (0-3): totalRange / ATR ratio. >2.0x ATR = 3, >1.5x = 2, >1.0x = 1
 *   - volumeScore (0-2): avg volume of displacement candles vs 20-period avg. >3x = 2, >2x = 1
 *   - bodyScore (0-2): avg (|close-open| / (high-low)) of displacement candles. >0.7 = 2, >0.5 = 1
 *   - fvgScore (0-3): count of FVGs created within displacement. >=3 = 3, 2 = 2, 1 = 1
 *
 * @param candles - Full candle array (need lookback for ATR)
 * @param fromIndex - Start of displacement range
 * @param toIndex - End of displacement range (inclusive)
 * @returns DisplacementResult with score 0-10 and component metrics
 */
export function scoreDisplacement(candles: Candle[], fromIndex: number, toIndex: number): DisplacementResult
```

The function should:
1. Calculate ATR(14) using candles before fromIndex
2. Compute the total range (highest high to lowest low of displacement candles)
3. Determine direction: if close[toIndex] > close[fromIndex] = BULLISH, else BEARISH
4. Calculate average volume vs 20-period lookback average
5. Calculate average body ratio across displacement candles
6. Count FVGs within the displacement range (call detectFVGsInRange — a helper you create)
7. Sum sub-scores into total 0-10

### Scoring thresholds (from config):
- minScoreForSMS: 6 (already in SCORING_CONFIG)
- strongDisplacement: 8 (already in SCORING_CONFIG)

## ───────────────────────────────────────────
## FILE 2: src/analyzer/fvgDetector.ts
## ───────────────────────────────────────────

Replace placeholder. An FVG is a 3-candle pattern where there's a price gap.

### Detection Logic:
```
BULLISH FVG at index i:
  gap exists when: candles[i+1].low > candles[i-1].high
  → FVG zone: bottom = candles[i-1].high, top = candles[i+1].low
  → CE (consequent encroachment) = (top + bottom) / 2

BEARISH FVG at index i:
  gap exists when: candles[i+1].high < candles[i-1].low
  → FVG zone: top = candles[i-1].low, bottom = candles[i+1].high
  → CE = (top + bottom) / 2
```

Note: candle[i] is the impulse candle (the middle one). The gap is between candle[i-1] and candle[i+1].

### Quality scoring:
- HIGH: FVG formed during displacement (displacement score >= 6) AND body ratio of impulse candle > 0.7
- MEDIUM: FVG formed during displacement OR impulse body ratio > 0.5
- LOW: everything else

### State management:
```typescript
/**
 * Update FVG states based on how much price has filled the gap.
 * State transitions:
 *   OPEN → PARTIALLY_FILLED: price has entered the FVG zone
 *   OPEN/PARTIALLY_FILLED → CE_TOUCHED: price reached the CE (midpoint)
 *   CE_TOUCHED → FILLED: price has crossed through entire FVG
 *   any → VIOLATED: price closed through the FVG against its direction
 *     (bullish FVG violated = candle close below FVG bottom)
 *     (bearish FVG violated = candle close above FVG top)
 */
export function updateFVGStates(fvgs: FairValueGap[], recentCandles: Candle[]): FairValueGap[]
```

```typescript
/**
 * Find the best FVG for trade entry.
 * Criteria: state must be OPEN or PARTIALLY_FILLED, quality HIGH or MEDIUM,
 * in correct direction, most recent first.
 */
export function findEntryFVG(fvgs: FairValueGap[], direction: 'BULLISH' | 'BEARISH'): FairValueGap | null
```

## ───────────────────────────────────────────
## FILE 3: src/analyzer/liquidityMapper.ts
## ───────────────────────────────────────────

Replace placeholder. Maps all liquidity levels where stops accumulate.

### Level types to detect:

1. **BSL/SSL (Buy-Side/Sell-Side Liquidity)**: Every swing high = BSL, every swing low = SSL. Direct from swing detector output.

2. **EQH/EQL (Equal Highs/Lows)**: When 2+ swing highs (or lows) are within tolerance of each other.
   - Tolerance: 0.1% (from SCORING_CONFIG.liquidity.eqTolerance = 0.001)
   - Use the average level of the cluster

3. **PDH/PDL (Previous Day High/Low)**: From the last complete daily candle in the candle cache.

4. **PWH/PWL (Previous Week High/Low)**: From the last 5 daily candles (Mon-Fri).

5. **SESSION_HIGH/SESSION_LOW**: From the session filter's `getSessionHighLow()`. Track Asian and London sessions.

### Scoring (0-11):
Each level gets a score based on:
- Base: 1 point per swing that forms the level (capped at 3)
- Timeframe bonus: +1 if from 1H swing, +2 if from 4H swing, +3 if from Daily swing
- EQ bonus: +2 if it's an EQH/EQL (multiple touches = more stops = more significant)
- Age bonus: +1 if level has been "clean" (untouched) for > 3 days
- Session bonus: +1 if aligns with a session high/low

### State management:
- ACTIVE: Level exists and hasn't been taken
- SWEPT: Price has traded through the level (wick or close) — mark with sweptAt timestamp
- EXPIRED: Level is > 20 days old and never swept (IPDA cycle)

### Key function:
```typescript
export function mapLiquidityLevels(
  candles: Record<Timeframe, Candle[]>,  // NOTE: changed signature to accept multi-TF candles
  swings: Record<Timeframe, Swing[]>,    // Multi-TF swings
  sessionHighLows?: { asian?: {high: number, low: number}, london?: {high: number, low: number} }
): LiquidityLevel[]
```

## ───────────────────────────────────────────
## FILE 4: src/analyzer/sweepDetector.ts
## ───────────────────────────────────────────

Replace placeholder. A sweep = price takes out a liquidity level then reverses.

### Detection Logic:
```
For each active liquidity level:
  For BSL (highs) sweep:
    - A candle's high exceeds the level
    - BUT the candle closes back below the level (IMMEDIATE confirmation)
    - OR within next N candles (lookforwardCandles=5), a candle closes below (DELAYED)
    
  For SSL (lows) sweep:
    - A candle's low goes below the level
    - BUT the candle closes back above the level (IMMEDIATE)
    - OR within next N candles, closes back above (DELAYED)
```

### Sweep scoring (0-10):
- Penetration depth (0-3): how far price went past level as % of ATR
  - < 0.2% of level = 3 (shallow = cleaner sweep)
  - < 0.5% = 2
  - < maxPenetrationPercent (0.2%) from config = 1
  - Beyond = 0 (too deep, might be a real breakout)
- Reversal speed (0-3): IMMEDIATE confirmation = 3, 1 candle delay = 2, 2-3 candles = 1, 4-5 = 0
- Displacement on reversal (0-2): if the reversal candle has body ratio > 0.6 = 2, > 0.4 = 1
- Level quality (0-2): liquidityLevel.score >= 8 = 2, >= 5 = 1

### Functions:
```typescript
export function detectSweep(level: LiquidityLevel, candles: Candle[]): Sweep | null
export function scanForSweeps(levels: LiquidityLevel[], recentCandles: Candle[]): Sweep[]
export function scoreSweep(sweep: Sweep): number  // Apply scoring formula above
```

## ───────────────────────────────────────────
## FILE 5: src/analyzer/premiumDiscount.ts
## ───────────────────────────────────────────

Replace placeholder. ICT Fibonacci zones for entry.

### Implementation:
```typescript
export function getPremiumDiscountState(
  currentPrice: number,
  swingHigh: Swing,
  swingLow: Swing,
): PremiumDiscountState {
  const range = swingHigh.level - swingLow.level;
  const equilibrium = (swingHigh.level + swingLow.level) / 2;
  
  // Zone: above EQ = PREMIUM, below = DISCOUNT
  const zone: PremiumDiscountZone = currentPrice >= equilibrium ? 'PREMIUM' : 'DISCOUNT';
  
  // Depth: 0 = at equilibrium, 1 = at extreme
  // For PREMIUM: depth = (price - EQ) / (high - EQ)
  // For DISCOUNT: depth = (EQ - price) / (EQ - low)
  const depth = zone === 'PREMIUM'
    ? Math.min(1, (currentPrice - equilibrium) / (swingHigh.level - equilibrium))
    : Math.min(1, (equilibrium - currentPrice) / (equilibrium - swingLow.level));
  
  // OTE (Optimal Trade Entry) range: Fib 0.618 to 0.79
  // For bullish OTE (buying in discount): from swing low up
  //   oteHigh = swingLow.level + range * (1 - 0.618) = swingLow.level + range * 0.382
  //   oteLow  = swingLow.level + range * (1 - 0.79)  = swingLow.level + range * 0.21
  // For bearish OTE (selling in premium): from swing high down
  //   oteHigh = swingHigh.level - range * (1 - 0.79) = swingHigh.level - range * 0.21
  //   oteLow  = swingHigh.level - range * (1 - 0.618) = swingHigh.level - range * 0.382
  
  // We return both zones — let the signal detector pick based on bias
  const oteRange = {
    high: swingLow.level + range * 0.382,  // bullish OTE upper bound
    low: swingLow.level + range * 0.21,    // bullish OTE lower bound
  };
  
  return { zone, equilibrium, depth, oteRange };
}
```

## ───────────────────────────────────────────
## FILE 6: src/analyzer/marketStructure.ts
## ───────────────────────────────────────────

Replace placeholder. Analyzes swing sequence to determine trend and detect structure breaks.

### Core logic — Trend Determination:
```
Given a sequence of swings (alternating highs and lows):

BULLISH: Pattern of Higher Highs (HH) and Higher Lows (HL)
  - Latest swing high > previous swing high = HH
  - Latest swing low > previous swing low = HL

BEARISH: Pattern of Lower Highs (LH) and Lower Lows (LL)
  - Latest swing high < previous swing high = LH  
  - Latest swing low < previous swing low = LL

TRANSITION: Mixed signals (HH + LL or LH + HL)
UNDEFINED: Not enough swings to determine (< 4 swings needed)
```

### Structure Events:

**BMS (Break of Market Structure)** — trend continuation:
  - BMS_BULLISH: In bullish trend, price breaks above the most recent swing high
  - BMS_BEARISH: In bearish trend, price breaks below the most recent swing low

**CHOCH (Change of Character)** — first warning of trend change:
  - CHOCH_BULLISH: In bearish trend, price breaks above the most recent Lower High
  - CHOCH_BEARISH: In bullish trend, price breaks below the most recent Higher Low

**SMS (Shift in Market Structure)** — confirmed trend change (THE entry trigger):
  - SMS_BULLISH: CHOCH_BULLISH + displacement score >= minScoreForSMS (6)
  - SMS_BEARISH: CHOCH_BEARISH + displacement score >= minScoreForSMS (6)
  - An SMS without displacement is just a CHOCH

### Critical concept — "criticalSwing":
The critical swing is the swing that, if broken, would signal a change of character:
  - In BULLISH trend: criticalSwing = the most recent Higher Low
  - In BEARISH trend: criticalSwing = the most recent Lower High

### Functions:
```typescript
/**
 * Build the full structure state from a sequence of swings.
 * Needs minimum 4 swings to determine trend.
 */
export function analyzeStructure(candles: Candle[], swings: Swing[]): StructureState

/**
 * Check if the LATEST candle(s) break structure.
 * For BMS: does latest candle close beyond the relevant swing?
 * For CHOCH: does latest candle close beyond the critical swing?
 *
 * IMPORTANT: Use candle CLOSE for confirmation, not just wick.
 * ICT: "A break of structure should be with a candle body close."
 */
export function detectBMS(candle: Candle, state: StructureState): StructureEvent

/**
 * Detect SMS: CHOCH + displacement validation.
 * This combines detectBMS (for CHOCH detection) with scoreDisplacement.
 * Only returns SMS if displacement score >= SCORING_CONFIG.displacement.minScoreForSMS
 */
export function detectSMS(timeframe: Timeframe, candles: Candle[], swings: Swing[]): StructureEvent
```

## ───────────────────────────────────────────
## FILE 7: src/analyzer/orderBlockDetector.ts
## ───────────────────────────────────────────

Replace placeholder. Order Block = last opposing candle before displacement.

### Detection Logic:
```
BULLISH OB (demand):
  - Find the last bearish candle (close < open) before a bullish displacement
  - OB zone: top = candle high, bottom = candle low
  - CE = midpoint
  - Better OBs have less wick (ICT: "the best OBs don't have wicks")

BEARISH OB (supply):
  - Find the last bullish candle (close > open) before a bearish displacement
  - OB zone: top = candle high, bottom = candle low
  
Invalidation:
  - A bullish OB is invalidated if price closes below the OB bottom
  - A bearish OB is invalidated if price closes above the OB top
```

### Functions:
```typescript
export function detectOrderBlocks(candles: Candle[], timeframe: Timeframe): OrderBlock[]
```

OB detection depends on displacement detection, so call scoreDisplacement internally. Only create OBs where displacement score >= 4 (moderate move).

## ───────────────────────────────────────────
## FILE 8: src/engine/biasEngine.ts
## ───────────────────────────────────────────

Replace placeholder. Uses the ICT "3 B's" framework from the 2022 Mentorship.

### B1 — Framework (What is the current context?):
```
Look at the DAILY and 4H structure:
  - Did price recently sweep a significant liquidity pool? → WAITING_FOR_SWEEP or done
  - Was there a displacement after the sweep? → If yes, expect RETRACEMENT_EXPECTED
  - After retracement to FVG/OB, expect EXPANSION_EXPECTED (continuation)
```

Implementation: Check the 4H structure state (from marketStructure). If the last event was an SMS or BMS within the last 10 4H candles, framework = RETRACEMENT_EXPECTED. If structure is clean trending with no recent events, framework = EXPANSION_EXPECTED. Otherwise WAITING_FOR_SWEEP.

### B2 — Draw on Liquidity (Where is price going next?):
```
Find the nearest significant liquidity target in the direction of the trend:
  - In BULLISH bias: find nearest BSL/EQH/PDH above current price
  - In BEARISH bias: find nearest SSL/EQL/PDL below current price
  - Use the one with the highest liquidity score
```

### B3 — Premium/Discount (Where should we look for entries?):
```
Determine the "Dealing Range" = the range of the most recent significant swing (4H or Daily):
  - If BULLISH: we should be looking to BUY from DISCOUNT (below 50%)
  - If BEARISH: we should be looking to SELL from PREMIUM (above 50%)
```

### AMD Phase Detection (Power of 3):
```
Based on session timing and price relative to daily open:
  - ACCUMULATION: Price is near the daily open, Asian/early London session
  - MANIPULATION: Price creates a false move (Judas swing) opposite to bias direction
    - Bullish day: price dips below daily open in London = manipulation
    - Bearish day: price spikes above daily open in London = manipulation
  - DISTRIBUTION: Price moves aggressively in bias direction, NY session
```

### Main function:
```typescript
export async function computeDailyBias(): Promise<DailyBias>
```

This needs access to:
- 4H and Daily candles (from candle cache — import or receive as params)
- 4H and Daily swings
- Liquidity levels
- Current session info
- Current price

Since this is a complex function, it should accept a context object:

```typescript
interface BiasContext {
  dailyCandles: Candle[];
  fourHourCandles: Candle[];
  dailySwings: Swing[];
  fourHourSwings: Swing[];
  liquidityLevels: LiquidityLevel[];
  currentPrice: number;
  currentSession: Session | null;
}

export function computeDailyBias(ctx: BiasContext): DailyBias
```

(Change from async to sync since it doesn't need DB — data is passed in.)

### Bias direction logic:
```
1. Get 4H structure trend
2. Get Daily structure trend
3. If both agree → that's the bias
4. If they disagree → NO_TRADE (conflicting signals)
5. If Daily is UNDEFINED → use 4H only
6. Override to NO_TRADE if:
   - Current session is NY_LUNCH or NY_CLOSE
   - 4H structure is in TRANSITION
```

## ───────────────────────────────────────────
## FILE 9: src/engine/signalDetector.ts
## ───────────────────────────────────────────

Replace placeholder. This combines everything into the final ICT trading signal.

### The Full Signal Sequence (2022 ICT Mentorship Model):

```
1. Daily bias is BULLISH or BEARISH (from biasEngine) — NOT NO_TRADE
2. We're in a killzone (London or NY_MORNING — from sessionFilter)
3. A qualifying sweep occurred (sweep score >= 5)
4. Displacement follows the sweep (displacement score >= 6 = SMS)
5. Market structure shifts on 15M or 5M (SMS detected)
6. An FVG exists within the displacement range (from fvgDetector)
7. Price is in correct zone: DISCOUNT for longs, PREMIUM for shorts (from premiumDiscount)
8. No opposing liquidity blocks the trade:
   - For LONG: no EQL or significant SSL within 0.5% below entry
   - For SHORT: no EQH or significant BSL within 0.5% above entry
```

### Signal construction:
```typescript
export interface TradingSignal {
  direction: 'LONG' | 'SHORT';
  sweep: Sweep;
  entryFVG: FairValueGap;
  stopLoss: number;       // Below/above the swing that caused the SMS + buffer
  tp1: number;            // IRL target (nearest FVG or OB in profit direction)
  tp2: number;            // ERL target (nearest liquidity pool in profit direction)
  rrRatio: number;        // (tp1 - entry) / (entry - stopLoss)
  displacementScore: number;
  confidence: number;     // 0-100
}
```

### Stop loss placement:
```
LONG: SL = swing low that formed the SMS - (level * RISK_CONFIG.slBufferPercent)
SHORT: SL = swing high that formed the SMS + (level * RISK_CONFIG.slBufferPercent)
```

### Take profit:
```
TP1 (Internal Range Liquidity): Nearest opposing FVG or OB in profit direction
  - LONG: nearest bearish FVG above entry, OR if none, the CE of the displacement FVG
  - SHORT: nearest bullish FVG below entry

TP2 (External Range Liquidity): Next liquidity pool in profit direction
  - LONG: nearest BSL/EQH/PDH above TP1
  - SHORT: nearest SSL/EQL/PDL below TP1
```

### Confidence scoring (0-100):
```
- Bias alignment: +20 if Daily AND 4H agree, +10 if only 4H
- Sweep quality: sweepScore * 2 (max 20)
- Displacement quality: displacementScore * 2 (max 20)
- FVG quality: HIGH = +15, MEDIUM = +10, LOW = +5
- Zone alignment: in OTE range = +15, in correct zone but not OTE = +10
- R:R ratio: >= 3.0 = +10, >= 2.0 = +5
```

### Minimum requirements to generate signal:
- confidence >= 50
- rrRatio >= RISK_CONFIG.minRR (2.0)
- bias is not NO_TRADE
- isKillzoneActive() is true

### Main function:
```typescript
interface SignalContext {
  bias: DailyBias;
  recentSweeps: Sweep[];
  fvgs: FairValueGap[];
  liquidityLevels: LiquidityLevel[];
  structureState15m: StructureState;
  structureState5m: StructureState;
  currentPrice: number;
  candles5m: Candle[];
  candles15m: Candle[];
  swings5m: Swing[];
  swings15m: Swing[];
}

export function detectSignal(ctx: SignalContext): TradingSignal | null
```

## ═══════════════════════════════════════════
## WIRING — Update src/index.ts
## ═══════════════════════════════════════════

After all analyzers are implemented, update the main entry point:

### Add Phase 2 imports and caches:
```typescript
import { mapLiquidityLevels, updateLiquidityStates } from './analyzer/liquidityMapper.js';
import { scanForSweeps } from './analyzer/sweepDetector.js';
import { detectFVGs, updateFVGStates } from './analyzer/fvgDetector.js';
import { analyzeStructure, detectSMS } from './analyzer/marketStructure.js';
import { computeDailyBias } from './engine/biasEngine.js';
import { detectSignal, TradingSignal } from './engine/signalDetector.js';
import { isKillzoneActive, getCurrentSession, getSessionHighLow } from './engine/sessionFilter.js';
import { sendDailyBias } from './monitoring/telegramBot.js';

// Phase 2 state caches
let liquidityLevels: LiquidityLevel[] = [];
let activeFVGs: FairValueGap[] = [];
let recentSweeps: Sweep[] = [];
let currentBias: DailyBias | null = null;
```

### Add a new "analysis cycle" cron (every 5 minutes, but only runs full analysis in killzones):
```typescript
cron.schedule('*/5 * * * *', async () => {
  try {
    // Always update FVG states with current price
    const price5m = candleCache['5m']?.slice(-1)[0]?.close;
    if (price5m && activeFVGs.length > 0) {
      activeFVGs = updateFVGStates(activeFVGs, candleCache['5m']?.slice(-5) ?? []);
    }

    // Only run full analysis during killzones
    if (!isKillzoneActive()) return;

    await runAnalysisCycle();
  } catch (err) {
    log.error(`Analysis cycle error: ${(err as Error).message}`);
  }
});
```

### Add daily bias calculation cron (once per day at 00:10 UTC, after daily candle closes):
```typescript
cron.schedule('10 0 * * *', async () => {
  try {
    const biasCtx = buildBiasContext();
    currentBias = computeDailyBias(biasCtx);
    log.info(`Daily bias: ${currentBias.bias} | AMD: ${currentBias.amdPhase}`);
    await sendDailyBias(currentBias);
  } catch (err) {
    log.error(`Bias calculation error: ${(err as Error).message}`);
  }
});
```

### The analysis cycle function:
```typescript
async function runAnalysisCycle(): Promise<void> {
  const candles5m = candleCache['5m'] ?? [];
  const candles15m = candleCache['15m'] ?? [];
  const candles1h = candleCache['1h'] ?? [];
  const candles4h = candleCache['4h'] ?? [];
  
  if (candles5m.length < 20 || candles15m.length < 20) return;
  
  // 1. Update liquidity map
  liquidityLevels = mapLiquidityLevels(
    candleCache as Record<Timeframe, Candle[]>,
    swingCache as Record<Timeframe, Swing[]>,
  );
  
  // 2. Update liquidity states (check for sweeps)
  liquidityLevels = updateLiquidityStates(liquidityLevels, candles5m.slice(-10));
  
  // 3. Scan for new sweeps
  const newSweeps = scanForSweeps(
    liquidityLevels.filter(l => l.state === 'ACTIVE'),
    candles5m.slice(-20)
  );
  recentSweeps = [...recentSweeps.slice(-10), ...newSweeps]; // Keep last 10

  // 4. Detect FVGs on 5M and 15M
  const newFVGs5m = detectFVGs(candles5m, '5m');
  const newFVGs15m = detectFVGs(candles15m, '15m');
  // Merge and deduplicate by timestamp+timeframe
  activeFVGs = mergeFVGs(activeFVGs, [...newFVGs5m, ...newFVGs15m]);
  
  // 5. Get structure states
  const structure15m = analyzeStructure(candles15m, swingCache['15m'] ?? []);
  const structure5m = analyzeStructure(candles5m, swingCache['5m'] ?? []);
  
  // 6. Check for SMS
  const sms15m = detectSMS('15m', candles15m, swingCache['15m'] ?? []);
  const sms5m = detectSMS('5m', candles5m, swingCache['5m'] ?? []);
  
  if (sms15m !== 'NONE' || sms5m !== 'NONE') {
    log.info(`🔄 SMS detected! 15M: ${sms15m} | 5M: ${sms5m}`);
  }

  // 7. If we have a bias, try to detect a signal
  if (!currentBias || currentBias.bias === 'NO_TRADE') return;
  
  const currentPrice = candles5m.slice(-1)[0]?.close ?? 0;
  
  const signal = detectSignal({
    bias: currentBias,
    recentSweeps,
    fvgs: activeFVGs.filter(f => f.state === 'OPEN' || f.state === 'PARTIALLY_FILLED'),
    liquidityLevels,
    structureState15m: structure15m,
    structureState5m: structure5m,
    currentPrice,
    candles5m,
    candles15m,
    swings5m: swingCache['5m'] ?? [],
    swings15m: swingCache['15m'] ?? [],
  });
  
  if (signal) {
    log.info(`🎯 SIGNAL: ${signal.direction} | Entry FVG: ${signal.entryFVG.top.toFixed(2)}-${signal.entryFVG.bottom.toFixed(2)} | SL: ${signal.stopLoss.toFixed(2)} | TP1: ${signal.tp1.toFixed(2)} | R:R: ${signal.rrRatio.toFixed(1)} | Confidence: ${signal.confidence}`);
    
    await sendAlert(
      `🎯 <b>ICT Signal: ${signal.direction}</b>\n` +
      `Entry Zone: ${signal.entryFVG.bottom.toFixed(2)} - ${signal.entryFVG.top.toFixed(2)}\n` +
      `Stop Loss: ${signal.stopLoss.toFixed(2)}\n` +
      `TP1 (IRL): ${signal.tp1.toFixed(2)}\n` +
      `TP2 (ERL): ${signal.tp2.toFixed(2)}\n` +
      `R:R: ${signal.rrRatio.toFixed(1)}x\n` +
      `Confidence: ${signal.confidence}/100\n` +
      `Displacement: ${signal.displacementScore}/10`
    );
    
    // Phase 3 will add execution here
  }
}

// Helper to merge and deduplicate FVGs
function mergeFVGs(existing: FairValueGap[], incoming: FairValueGap[]): FairValueGap[] {
  const map = new Map<string, FairValueGap>();
  for (const fvg of existing) map.set(fvg.id, fvg);
  for (const fvg of incoming) {
    if (!map.has(fvg.id)) map.set(fvg.id, fvg);
  }
  // Keep only non-FILLED, non-VIOLATED FVGs from last 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return Array.from(map.values()).filter(
    f => f.state !== 'FILLED' && f.state !== 'VIOLATED' && f.timestamp.getTime() > cutoff
  );
}

// Helper to build bias context from caches
function buildBiasContext() {
  const price = candleCache['5m']?.slice(-1)[0]?.close ?? 0;
  return {
    dailyCandles: candleCache['1d'] ?? [],
    fourHourCandles: candleCache['4h'] ?? [],
    dailySwings: swingCache['1d'] ?? [],
    fourHourSwings: swingCache['4h'] ?? [],
    liquidityLevels,
    currentPrice: price,
    currentSession: getCurrentSession(),
  };
}
```

### Update Telegram commands:
In `src/monitoring/telegramBot.ts`:
- `/swings` → Show last 5 swings for each timeframe from swingCache
- `/bias` → Show current daily bias
- `/levels` → Show top 5 liquidity levels by score
- `/status` → Include Phase 2 state (bias, active FVGs count, liquidity levels count)

The bot needs access to these caches. Use the same setter pattern from the on-chain bot, or export the caches from index.ts. Simplest: add a function `setBotState(state)` in telegramBot that index.ts calls periodically.

## ═══════════════════════════════════════════
## IMPORTANT GUIDELINES
## ═══════════════════════════════════════════

- Keep strict TypeScript — no `any` types
- Every function needs JSDoc comments explaining what it does
- Add debug logging with createModuleLogger for each module
- All scoring thresholds should come from SCORING_CONFIG (src/config/scoring.ts) — add new entries as needed
- Don't break existing Phase 1 functionality — the candle collector, swing detector, and session filter must continue working
- The bot must start and run without crashing even if no signals are detected
- Graceful degradation: if any analyzer fails, log the error and skip that cycle
- Export all public functions from each module for future testing

After implementing everything, run `npx tsc --noEmit` to verify there are no type errors.
```
```

---
