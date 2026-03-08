# Claude Code Prompt — ICT Price Action Bot (Phase 3: Execution Layer)

## Paste this into Claude Code:

---

```
We're continuing the ICT Price Action Bot project. Phase 1 (data pipeline + swings + sessions) and Phase 2 (analyzers + bias engine + signal detector) are complete. Now we're implementing PHASE 3: Execution Layer.

The bot currently:
- Collects candles from Bybit across 5 timeframes (5M, 15M, 1H, 4H, Daily)
- Detects swings, FVGs, liquidity levels, sweeps, market structure
- Computes daily bias using B1/B2/B3 framework
- Generates TradingSignal objects with direction, entry FVG, SL, TP1, TP2, R:R, confidence

Phase 3 turns those TradingSignal objects into actual paper trades, manages open positions, and enforces all risk rules.

## ═══════════════════════════════════════════
## OVERVIEW: What Phase 3 Builds
## ═══════════════════════════════════════════

1. **Risk Manager** — Enforces all risk rules BEFORE any trade is allowed
2. **Paper Trader** — Simulates trades using real Bybit prices without placing real orders
3. **Position Manager** — Monitors open positions, handles TP1 partial close, BE stop, time exits
4. **Bybit Client upgrade** — Add authenticated endpoints (wallet balance, position info)
5. **Exit Strategy** — Implements ICT-specific exit logic (TP1/TP2/structural/time exits)
6. **Trade Logger** — CSV + Supabase trade logging for performance analysis
7. **Index.ts wiring** — Connect signals → risk check → execution → position management

The bot runs in PAPER TRADING mode ONLY for now. Real execution is Phase 4.

## ═══════════════════════════════════════════
## FILE 1: src/execution/bybitClient.ts
## ═══════════════════════════════════════════

Upgrade the existing thin client to support authenticated endpoints.

### Add HMAC SHA256 signing for private endpoints:

```typescript
import crypto from 'crypto';

/**
 * Generate Bybit v5 API signature.
 * signature = HMAC_SHA256(apiSecret, timestamp + apiKey + recvWindow + queryString)
 */
function generateSignature(
  apiSecret: string,
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  params: string, // query string for GET, JSON body for POST
): string {
  const preSign = timestamp + apiKey + recvWindow + params;
  return crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
}
```

### Private headers builder:
```typescript
private getAuthHeaders(params: string): Record<string, string> {
  const apiKey = process.env['BYBIT_API_KEY'] ?? '';
  const apiSecret = process.env['BYBIT_API_SECRET'] ?? '';
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const sign = generateSignature(apiSecret, timestamp, apiKey, recvWindow, params);

  return {
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-SIGN': sign,
    'X-BAPI-SIGN-TYPE': '2',
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': recvWindow,
    'Content-Type': 'application/json',
  };
}
```

### New authenticated methods to add:

```typescript
/** Get wallet balance (Unified Trading Account) */
async getWalletBalance(): Promise<{ totalEquity: number; availableBalance: number }>

/** Get current open position for a symbol (linear perpetual) */
async getPosition(symbol: string): Promise<{
  symbol: string;
  side: 'Buy' | 'Sell' | 'None';
  size: string;
  entryPrice: string;
  unrealisedPnl: string;
  leverage: string;
} | null>

/** Set leverage for a symbol (needed before placing orders) */
async setLeverage(symbol: string, leverage: number): Promise<boolean>

/** Place a limit order */
async placeLimitOrder(params: {
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  price: string;
  stopLoss?: string;
  takeProfit?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}): Promise<{ orderId: string; orderLinkId: string } | null>

/** Place a market order */
async placeMarketOrder(params: {
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  stopLoss?: string;
  takeProfit?: string;
}): Promise<{ orderId: string; orderLinkId: string } | null>

/** Cancel an open order */
async cancelOrder(symbol: string, orderId: string): Promise<boolean>

/** Get open orders for a symbol */
async getOpenOrders(symbol: string): Promise<Array<{
  orderId: string;
  side: string;
  price: string;
  qty: string;
  orderStatus: string;
}>>

/** Modify stop loss of an existing position */
async modifyPositionSL(symbol: string, stopLoss: string): Promise<boolean>
```

### Bybit API endpoints:
- Wallet: GET /v5/account/wallet-balance?accountType=UNIFIED
- Position: GET /v5/position/list?category=linear&symbol={symbol}
- Set Leverage: POST /v5/position/set-leverage
- Place Order: POST /v5/order/create
- Cancel Order: POST /v5/order/cancel
- Open Orders: GET /v5/order/realtime?category=linear&symbol={symbol}
- Modify SL: POST /v5/position/trading-stop

### Important:
- All quantities must be strings in Bybit API (e.g., "0.001" not 0.001)
- BTCUSDT qty precision: 3 decimals (min 0.001)
- Always wrap API calls in try/catch and log errors
- Add 100ms delay between sequential API calls (rate limiting)
- Use `BYBIT_TESTNET=true` to route to testnet (api-testnet.bybit.com)

## ═══════════════════════════════════════════
## FILE 2: src/execution/riskManager.ts
## ═══════════════════════════════════════════

Replace the placeholder. This is the gatekeeper — NO trade happens without passing risk checks.

### Risk check function:
```typescript
export interface RiskCheck {
  allowed: boolean;
  reason: string;        // Human-readable explanation (for logging/Telegram)
  riskPercent: number;   // The risk % that will be used (1%, 0.5%, or 0.25%)
  positionSizeUsdt: number;
  leverage: number;
}

export interface RiskState {
  consecutiveLosses: number;
  tradesToday: number;
  dailyPnlUsdt: number;
  weeklyPnlUsdt: number;
  peakEquity: number;
  currentEquity: number;
}
```

### Check logic (in order of priority — first failure returns immediately):
```
1. KILL SWITCH: If (peakEquity - currentEquity) / peakEquity >= 0.15 → BLOCKED
   reason: "Kill switch: drawdown {pct}% from peak equity"

2. WEEKLY DRAWDOWN: If weeklyPnlUsdt / peakEquity <= -0.05 → BLOCKED
   reason: "Weekly drawdown limit reached ({pct}%)"

3. DAILY LOSS CAP: If dailyPnlUsdt / currentEquity <= -0.02 → BLOCKED
   reason: "Daily loss cap reached ({pct}%)"

4. MAX TRADES/DAY: If tradesToday >= RISK_CONFIG.maxTradesPerDay (1) → BLOCKED
   reason: "Maximum trades per day reached ({n})"

5. MIN R:R: If proposedRR < RISK_CONFIG.minRR (2.0) → BLOCKED
   reason: "R:R too low ({rr} < {minRR})"

6. DYNAMIC SIZING:
   - 0 consecutive losses → riskPercent = RISK_CONFIG.maxRiskPerTrade (1%)
   - 1 consecutive loss  → riskPercent = RISK_CONFIG.postLossRisk (0.5%)
   - 2+ consecutive losses → riskPercent = RISK_CONFIG.post2LossRisk (0.25%)
```

### Position size calculation:
```typescript
/**
 * Calculate position size in USDT.
 *
 * Formula:
 *   riskAmountUsdt = accountBalance * riskPercent
 *   stopDistancePct = |entryPrice - stopLoss| / entryPrice
 *   rawPositionSize = riskAmountUsdt / stopDistancePct
 *   positionSize = rawPositionSize * leverage
 *   
 *   Cap at accountBalance * leverage (can't exceed available margin)
 *
 * @param accountBalance - Total account equity in USDT
 * @param riskPercent    - Risk as decimal (0.01 = 1%)
 * @param entryPrice     - Entry price
 * @param stopLoss       - Stop loss price
 * @param leverage       - Leverage multiplier (from RISK_CONFIG.defaultLeverage)
 */
export function calculatePositionSize(
  accountBalance: number,
  riskPercent: number,
  entryPrice: number,
  stopLoss: number,
  leverage: number,
): number
```

### Risk state management:
```typescript
/** In-memory risk state — persisted to Supabase daily */
let riskState: RiskState = { ... defaults ... };

/** Update risk state after a trade closes */
export function recordTradeResult(pnlUsdt: number, isWin: boolean): void

/** Reset daily counters (called at 00:00 UTC) */
export function resetDaily(): void

/** Reset weekly counters (called on Monday 00:00 UTC) */
export function resetWeekly(): void

/** Update peak equity tracking */
export function updateEquity(currentEquity: number): void
```

## ═══════════════════════════════════════════
## FILE 3: src/execution/paperTrader.ts
## ═══════════════════════════════════════════

Replace placeholder. Simulates trade execution using real Bybit prices.

### Core concept:
The paper trader does NOT place any real orders. Instead it:
1. Records the signal's entry zone, SL, TP1, TP2
2. Uses real price data to determine when entry would have been filled
3. Tracks unrealized PnL based on real price movements
4. Simulates TP1 partial close, BE stop move, and TP2/SL exits

### Trade lifecycle:
```
PENDING → OPEN → TP1_HIT → (TP2_HIT | STOPPED | TIME_EXIT)
```

### Paper trade tracking:
```typescript
export interface PaperPosition {
  trade: Trade;               // Full Trade object from types
  entryFilled: boolean;       // Has price reached entry zone?
  tp1Executed: boolean;       // Has TP1 partial close happened?
  beStopMoved: boolean;       // Has SL been moved to breakeven?
  openTimestamp: Date;
  lastCheckPrice: number;
}

/** In-memory paper positions */
let openPositions: PaperPosition[] = [];
let tradeHistory: Trade[] = [];
```

### Functions:

```typescript
/**
 * Open a paper trade based on a TradingSignal.
 * Sets the trade to PENDING — it becomes OPEN when price reaches the entry zone.
 *
 * @param signal      - The trading signal from signalDetector
 * @param sizeUsdt    - Position size from risk manager
 * @param leverage    - Leverage from risk config
 */
export function openPaperTrade(
  signal: TradingSignal,
  sizeUsdt: number,
  leverage: number,
): Trade

/**
 * Update all open paper positions based on current price.
 * This is the main "tick" function called every 5 minutes.
 *
 * For each position:
 *   1. If PENDING: check if price entered the entry FVG zone → fill it
 *   2. If OPEN: check SL, TP1, TP2 hits
 *   3. Handle TP1: close 50%, move SL to breakeven
 *   4. Handle time exit: close before NY_CLOSE
 *
 * @param currentPrice - Latest price
 * @param currentTime  - Current UTC time (for time-based exits)
 */
export function updatePaperPositions(
  currentPrice: number,
  currentTime: Date,
): { closedTrades: Trade[]; alerts: string[] }

/**
 * Force-close all open paper positions (for shutdown or kill switch).
 */
export function closeAllPaperPositions(currentPrice: number): Trade[]

/**
 * Get current open paper positions.
 */
export function getOpenPositions(): PaperPosition[]

/**
 * Get full trade history.
 */
export function getTradeHistory(): Trade[]
```

### Price fill logic:
```
For LONG entry (pending):
  - Entry zone = FVG bottom to FVG top
  - Fill price = FVG CE (midpoint) — conservative fill
  - Price must touch or go below FVG top to trigger fill

For SHORT entry (pending):
  - Entry zone = FVG bottom to FVG top
  - Fill price = FVG CE (midpoint)
  - Price must touch or go above FVG bottom to trigger fill

Slippage: Add 0.05% adverse slippage to fill price
  - LONG: fillPrice = FVG.ce * 1.0005
  - SHORT: fillPrice = FVG.ce * 0.9995
```

### Exit logic (checked every tick):
```
For LONG position:
  - SL hit: currentPrice <= trade.stopLoss → close at stopLoss (with 0.05% slippage)
  - TP1 hit: currentPrice >= trade.tp1Level → close 50% at tp1Level
    → Move SL to entry price (breakeven)
  - TP2 hit: currentPrice >= trade.tp2Level → close remaining at tp2Level
  - Time exit: if it's after 15:30 NY time and position still open → close at market

For SHORT position: mirror all conditions

After TP1:
  - trade.tp1Hit = true
  - trade.status = 'TP1_HIT'
  - Remaining size = sizeUsdt * 0.5
  - New SL = entry price (breakeven)
```

### PnL calculation:
```typescript
function calculatePnL(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  exitPrice: number,
  sizeUsdt: number,
  leverage: number,
): { pnlUsdt: number; pnlPct: number } {
  const priceDiff = direction === 'LONG'
    ? exitPrice - entryPrice
    : entryPrice - exitPrice;
  const pnlPct = (priceDiff / entryPrice) * leverage * 100;
  const pnlUsdt = (priceDiff / entryPrice) * sizeUsdt * leverage;
  return { pnlUsdt, pnlPct };
}
```

## ═══════════════════════════════════════════
## FILE 4: src/engine/exitStrategy.ts
## ═══════════════════════════════════════════

Replace placeholder. ICT-specific exit rules.

```typescript
export type ExitReason = 'TP1' | 'TP2' | 'STOP_LOSS' | 'TIME_EXIT' | 'STRUCTURAL' | 'KILL_SWITCH';

export interface ExitDecision {
  shouldExit: boolean;
  reason: ExitReason | null;
  exitPercent: number;     // 0-1 (0.5 for TP1 partial, 1.0 for full close)
  newStopLoss?: number;    // Set when moving to breakeven after TP1
  exitPrice?: number;      // The price to use for the exit
}
```

### evaluateExit function:
```typescript
/**
 * Evaluate whether an open trade should be exited or adjusted.
 *
 * Priority order:
 *   1. KILL_SWITCH: from risk manager state
 *   2. STOP_LOSS: price hit SL
 *   3. TP1: price hit TP1 (partial close 50%)
 *   4. TP2: price hit TP2 after TP1 (close remaining)
 *   5. TIME_EXIT: approaching NY_CLOSE (15:30+ NY time)
 *   6. STRUCTURAL: market structure shifted against the trade
 *      (new SMS in opposite direction on 15M)
 */
export function evaluateExit(
  trade: Trade,
  currentPrice: number,
  currentTime: Date,
  structureState15m: StructureState,
  isKillSwitch: boolean,
): ExitDecision
```

### Breakeven stop calculation:
```typescript
/**
 * After TP1 hit, move stop loss to entry price + small buffer.
 * Buffer = 0.05% of entry price (to account for spread/slippage)
 */
export function calculateBreakevenStop(trade: Trade): number {
  const buffer = trade.entryPrice * 0.0005;
  return trade.direction === 'LONG'
    ? trade.entryPrice + buffer  // LONG: SL just above entry
    : trade.entryPrice - buffer; // SHORT: SL just below entry
}
```

### Time exit check:
```typescript
/**
 * ICT rule: close all positions before market close.
 * For crypto (24/7), use NY_CLOSE session (16:00-17:00 NY) as the deadline.
 * Start exiting at 15:30 NY time.
 */
function shouldTimeExit(currentTime: Date): boolean {
  // Convert to NY time, check if hour >= 15 && minute >= 30
  // Use the toNYTime utility from sessionFilter
}
```

## ═══════════════════════════════════════════
## FILE 5: src/execution/positionManager.ts
## ═══════════════════════════════════════════

Replace placeholder. Orchestrates paper trader + exit strategy + risk updates.

```typescript
export class PositionManager {
  private isPaperMode: boolean;

  constructor(paperMode: boolean = true) {
    this.isPaperMode = paperMode;
  }

  /**
   * Execute a trading signal: risk check → open position → notify.
   * Returns the trade if successful, null if blocked by risk.
   */
  async executeSignal(signal: TradingSignal, accountBalance: number): Promise<Trade | null> {
    // 1. Run risk check
    const riskCheck = checkRiskAllowance(accountBalance, signal.rrRatio);
    if (!riskCheck.allowed) {
      log.info(`Signal rejected: ${riskCheck.reason}`);
      await sendAlert(`⛔ Signal rejected: ${riskCheck.reason}`);
      return null;
    }

    // 2. Open paper trade
    const trade = openPaperTrade(signal, riskCheck.positionSizeUsdt, riskCheck.leverage);
    log.info(`Paper trade opened: ${trade.direction} | Size: ${riskCheck.positionSizeUsdt.toFixed(2)} USDT`);

    // 3. Notify via Telegram
    await sendAlert(
      `📝 <b>Paper Trade Opened</b>\n` +
      `Direction: ${trade.direction}\n` +
      `Entry Zone: ${signal.entryFVG.bottom.toFixed(2)}-${signal.entryFVG.top.toFixed(2)}\n` +
      `Size: ${riskCheck.positionSizeUsdt.toFixed(2)} USDT\n` +
      `Leverage: ${riskCheck.leverage}x\n` +
      `Risk: ${(riskCheck.riskPercent * 100).toFixed(2)}%\n` +
      `SL: ${trade.stopLoss.toFixed(2)} | TP1: ${trade.tp1Level.toFixed(2)} | TP2: ${trade.tp2Level.toFixed(2)}`
    );

    return trade;
  }

  /**
   * Check and manage all open positions.
   * Called every 5 minutes (same frequency as analysis cycle).
   */
  async checkPositions(
    currentPrice: number,
    currentTime: Date,
    structureState15m: StructureState,
  ): Promise<void> {
    // 1. Get kill switch status from risk manager
    const isKillSwitch = isKillSwitchActive();

    // 2. Update paper positions with current price
    const { closedTrades, alerts } = updatePaperPositions(currentPrice, currentTime);

    // 3. Process closed trades
    for (const trade of closedTrades) {
      const pnl = trade.pnlUsdt ?? 0;
      const isWin = pnl > 0;

      // Update risk state
      recordTradeResult(pnl, isWin);

      // Log to CSV + Supabase
      await logTrade(trade);

      // Telegram alert
      const emoji = isWin ? '✅' : '❌';
      await sendAlert(
        `${emoji} <b>Trade Closed: ${trade.status}</b>\n` +
        `Direction: ${trade.direction}\n` +
        `Entry: ${trade.entryPrice?.toFixed(2)} → Exit: ${trade.exitPrice?.toFixed(2)}\n` +
        `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (${(trade.pnlPct ?? 0).toFixed(2)}%)\n` +
        `R:R Achieved: ${(trade.rrAchieved ?? 0).toFixed(1)}x`
      );
    }

    // 4. Send any alerts from position updates
    for (const alert of alerts) {
      await sendAlert(alert);
    }

    // 5. Check structural exits for remaining open positions
    for (const pos of getOpenPositions()) {
      const exitDecision = evaluateExit(
        pos.trade, currentPrice, currentTime, structureState15m, isKillSwitch,
      );

      if (exitDecision.shouldExit && exitDecision.reason === 'STRUCTURAL') {
        // Force close via paper trader
        const closed = forceClosePaperPosition(pos.trade.id, currentPrice, 'STRUCTURAL');
        if (closed) {
          await sendAlert(
            `🔄 <b>Structural Exit</b>\n` +
            `15M structure shifted against trade\n` +
            `PnL: ${(closed.pnlUsdt ?? 0).toFixed(2)} USDT`
          );
        }
      }
    }
  }
}
```

## ═══════════════════════════════════════════
## FILE 6: src/monitoring/tradeLogger.ts (NEW)
## ═══════════════════════════════════════════

New file for trade logging — CSV + Supabase.

```typescript
import fs from 'fs';
import path from 'path';
import { Trade } from '../types/index.js';
import { getSupabaseClient } from '../database/supabase.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('TradeLogger');
const CSV_PATH = path.resolve(process.cwd(), 'logs', 'trades.csv');

/**
 * Log a completed trade to both CSV and Supabase.
 */
export async function logTrade(trade: Trade): Promise<void> {
  await logToCSV(trade);
  await logToSupabase(trade);
}
```

### CSV format:
```
id,timestamp,direction,entryPrice,exitPrice,sizeUsdt,leverage,stopLoss,tp1,tp2,tp1Hit,pnlUsdt,pnlPct,rrAchieved,status,displacementScore,confidence,sweepId,fvgId,isPaper
```

Write header if file doesn't exist, then append each trade as a new line.

### Supabase table (add to migrations):
```sql
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  direction TEXT NOT NULL,
  entry_price NUMERIC,
  exit_price NUMERIC,
  size_usdt NUMERIC NOT NULL,
  leverage INTEGER NOT NULL,
  stop_loss NUMERIC NOT NULL,
  tp1_level NUMERIC NOT NULL,
  tp2_level NUMERIC NOT NULL,
  tp1_hit BOOLEAN DEFAULT false,
  pnl_usdt NUMERIC,
  pnl_pct NUMERIC,
  rr_achieved NUMERIC,
  status TEXT NOT NULL,
  displacement_score INTEGER,
  confidence INTEGER,
  sweep_id TEXT,
  fvg_id TEXT,
  is_paper BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_trades_timestamp ON trades(timestamp);
CREATE INDEX idx_trades_status ON trades(status);
```

## ═══════════════════════════════════════════
## FILE 7: Performance Summary (add to telegramBot.ts)
## ═══════════════════════════════════════════

Add these new Telegram commands:

```typescript
/trades    — Last 5 completed trades with PnL
/perf      — Performance summary (win rate, total PnL, avg R:R, streak)
/risk      — Current risk state (consecutive losses, daily PnL, weekly PnL, equity)
/positions — Open paper positions with unrealized PnL
/kill      — Manual kill switch toggle
```

### `/perf` response format:
```
📊 Performance Summary
━━━━━━━━━━━━━━━
Total trades: 15
Win rate: 40.0%
Total PnL: +$234.56
Avg R:R: 2.3x
Best trade: +$89.12
Worst trade: -$45.23
Current streak: 2W
Paper mode: ✅
```

### `/risk` response format:
```
🛡️ Risk State
━━━━━━━━━━━━
Consecutive losses: 1
Risk per trade: 0.50%
Daily PnL: -$23.45 (-0.23%)
Weekly PnL: +$123.45 (+1.23%)
Peak equity: $10,234.56
Current equity: $10,211.11
Kill switch: INACTIVE
```

## ═══════════════════════════════════════════
## WIRING — Update src/index.ts
## ═══════════════════════════════════════════

### New imports:
```typescript
import { PositionManager } from './execution/positionManager.js';
import { checkRiskAllowance, resetDaily, resetWeekly, updateEquity, isKillSwitchActive } from './execution/riskManager.js';
import { getOpenPositions, getTradeHistory } from './execution/paperTrader.js';
import { bybitClient } from './execution/bybitClient.js';
```

### New state:
```typescript
const positionManager = new PositionManager(true); // Paper mode
let accountBalance = parseFloat(process.env['PAPER_BALANCE'] ?? '10000');
```

### Wire signal → execution in handleSignal():
```typescript
async function handleSignal(signal: TradingSignal): Promise<void> {
  // ... existing logging and Telegram alert ...

  // Execute via position manager
  const trade = await positionManager.executeSignal(signal, accountBalance);
  if (!trade) {
    log.info('Signal was blocked by risk manager');
  }
}
```

### Wire position management into analysis cycle:
```typescript
// At the end of runAnalysisCycle(), after signal detection:

// Check and manage open positions
const currentPrice = candles5m.slice(-1)[0]?.close ?? 0;
await positionManager.checkPositions(
  currentPrice,
  new Date(),
  structure15m,
);
```

### Add position check cron for when NOT in killzone too:
```typescript
// Every 5 minutes: check positions even outside killzones (SL/TP can hit anytime)
cron.schedule('*/5 * * * *', async () => {
  const price = candleCache['5m']?.slice(-1)[0]?.close;
  if (!price) return;
  
  const structure15m = analyzeStructure(
    candleCache['15m'] ?? [],
    swingCache['15m'] ?? [],
  );
  
  await positionManager.checkPositions(price, new Date(), structure15m);
});
```

### Add daily/weekly risk resets:
```typescript
// Daily at 00:00 UTC: reset risk counters
cron.schedule('0 0 * * *', () => {
  resetDaily();
  log.info('Daily risk counters reset');
});

// Weekly on Monday 00:00 UTC: reset weekly counters
cron.schedule('0 0 * * 1', () => {
  resetWeekly();
  log.info('Weekly risk counters reset');
});
```

### Update account balance tracking:
```typescript
// Every hour: update equity tracking (for paper mode, use paper balance + unrealized PnL)
cron.schedule('0 * * * *', async () => {
  try {
    // In paper mode, sum paper balance + unrealized PnL of open positions
    const openPnL = getOpenPositions().reduce((sum, p) => {
      // Approximate unrealized PnL
      const price = candleCache['5m']?.slice(-1)[0]?.close ?? 0;
      if (!price || !p.trade.entryPrice) return sum;
      const dir = p.trade.direction === 'LONG' ? 1 : -1;
      const pnl = dir * ((price - p.trade.entryPrice) / p.trade.entryPrice) * p.trade.sizeUsdt * p.trade.leverage;
      return sum + pnl;
    }, 0);
    
    const equity = accountBalance + openPnL;
    updateEquity(equity);
  } catch (err) {
    log.error(`Equity update error: ${(err as Error).message}`);
  }
});
```

### Update Telegram bot state to include trades:
```typescript
// In updateBotState(), add:
setBotState({
  ...existingState,
  openPositions: getOpenPositions(),
  tradeHistory: getTradeHistory(),
  riskState: getRiskState(), // Export from riskManager
  accountBalance,
});
```

## ═══════════════════════════════════════════
## ENV VARS — Add to .env.example
## ═══════════════════════════════════════════

```
# Phase 3: Execution
PAPER_TRADING=true
PAPER_BALANCE=10000
BYBIT_API_KEY=
BYBIT_API_SECRET=
BYBIT_TESTNET=true
```

Note: Even in paper mode, we use the API key to fetch real wallet balance and prices. But NO orders are placed in paper mode.

## ═══════════════════════════════════════════
## IMPORTANT GUIDELINES
## ═══════════════════════════════════════════

- PAPER_TRADING=true means absolutely NO real orders — enforce this with a guard at the top of every order placement function
- Keep strict TypeScript — no `any` types
- Every function needs JSDoc comments
- All monetary amounts: numbers internally, strings only for Bybit API
- Log every trade event: open, TP1 hit, SL move, close
- Send Telegram alert for every trade event
- BTC qty precision: 3 decimal places (e.g., "0.001")
- Graceful degradation: if Bybit API is unreachable, paper trader should still work with cached prices
- The paper trader's slippage model (0.05%) is intentionally conservative
- Export getRiskState() and isKillSwitchActive() from riskManager for other modules
- Add a `forceClosePaperPosition(tradeId, price, reason)` function to paperTrader for structural exits
- The position manager should handle the case where no positions are open (common case — just return early)
- After implementing everything, run `npx tsc --noEmit` to verify type safety
```

---

## NOTES FOR ED:

**What Phase 3 builds:** The complete paper trading loop. Signal → Risk Check → Paper Trade → Position Monitoring → Exit → PnL Logging.

**The execution flow is:**
```
TradingSignal → riskManager.checkRiskAllowance()
  → If allowed: paperTrader.openPaperTrade()
  → Every 5 min: paperTrader.updatePaperPositions(price)
  → On exit: exitStrategy.evaluateExit() → close → logTrade() → recordTradeResult()
  → Telegram alerts at every step
```

**After Phase 3, the bot will:**
- Run 24/7 collecting data and detecting signals
- Open paper trades when ICT signals fire
- Track positions, execute TP1 partial close, move SL to breakeven
- Close remaining at TP2 or SL
- Force-close before NY close (15:30 NY)
- Log everything to CSV + Supabase
- Enforce dynamic risk sizing and all safety limits
- Send real-time Telegram updates

**Files to share for validation after Claude Code finishes:**
1. `src/execution/riskManager.ts` — verify risk logic
2. `src/execution/paperTrader.ts` — verify PnL calculations
3. `src/execution/positionManager.ts` — verify orchestration
4. `src/index.ts` — verify wiring

**Phase 4 (future) will be:** Replace paper trader calls with real Bybit order calls. The PositionManager already has `isPaperMode` flag for this switch.
