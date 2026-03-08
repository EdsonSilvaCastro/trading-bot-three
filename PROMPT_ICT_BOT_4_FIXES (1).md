# Claude Code Prompt — ICT Bot: 4 Critical Fixes Post-Deployment Diagnostic

## Context

The ICT Price Action Bot has been running on a DigitalOcean VPS since Feb 27 but has taken ZERO trades. A diagnostic revealed the root causes. This prompt addresses all 4 issues in priority order.

**Bot location:** `/opt/bots/ict-bot`
**Repo:** `trading-bot-three` (TypeScript/Node.js)
**Key files:**
- `src/engine/biasEngine.ts` — Daily bias calculation
- `src/engine/signalDetector.ts` — 3-step model orchestrator
- `src/analyzer/fvgDetector.ts` — FVG detection
- `src/index.ts` — Main entry point & orchestration
- `.env` — Environment variables

---

## FIX 1: Relax Bias Engine `bothTFAgree` Gate (CRITICAL — This is why the bot hasn't traded)

### Problem

The bias engine requires `bothTFAgree=true` (4H and Daily must point in same direction) to emit anything other than `NO_TRADE`. For the past 9+ days, the 4H has been `TRANSITION` while Daily is `BEARISH`, producing:

```
Bias: NO_TRADE | 4H=TRANSITION Daily=BEARISH bothTFAgree=false | B1=WAITING_FOR_SWEEP
```

This blocks the entire pipeline — sweeps are detected (1,734 in 7 days), MSS events occur (36), but the bot never advances to FVG entry because the bias says NO_TRADE every single day.

### Root Cause

The current logic treats `TRANSITION` on 4H as a disagreement with Daily. But `TRANSITION` means "not clearly trending" — it shouldn't be treated as contradicting the Daily bias. When the Daily timeframe has a clear direction (BEARISH or BULLISH), and the 4H is merely in TRANSITION (not opposing), the bot should still be allowed to trade.

### Fix

In `src/engine/biasEngine.ts`, find the logic where `bothTFAgree` is calculated. It currently requires both timeframes to have the SAME directional bias (BULLISH/BULLISH or BEARISH/BEARISH).

**Change the logic to a 3-tier system:**

```typescript
// OLD logic (too strict):
// const bothTFAgree = (dailyBias === h4Bias);
// if (!bothTFAgree) return 'NO_TRADE';

// NEW logic — 3-tier bias confidence:
// 
// TIER 1 - FULL CONFIDENCE (both agree):
//   Daily=BEARISH + 4H=BEARISH → bias=BEARISH, riskMultiplier=1.0
//   Daily=BULLISH + 4H=BULLISH → bias=BULLISH, riskMultiplier=1.0
//
// TIER 2 - REDUCED CONFIDENCE (Daily clear, 4H transitioning):
//   Daily=BEARISH + 4H=TRANSITION → bias=BEARISH, riskMultiplier=0.5
//   Daily=BULLISH + 4H=TRANSITION → bias=BULLISH, riskMultiplier=0.5
//
// TIER 3 - NO TRADE (conflicting or both unclear):
//   Daily=BEARISH + 4H=BULLISH → NO_TRADE (conflicting)
//   Daily=BULLISH + 4H=BEARISH → NO_TRADE (conflicting)
//   Daily=TRANSITION + 4H=anything → NO_TRADE (no clear HTF direction)
```

**Implementation steps:**

1. Find where `bothTFAgree` is computed in `biasEngine.ts`

2. Replace the boolean `bothTFAgree` with a `biasConfidence` field that can be `'FULL'`, `'REDUCED'`, or `'NONE'`

3. When `biasConfidence === 'REDUCED'`, the bias engine should:
   - Still emit a directional bias (BULLISH or BEARISH) based on the Daily
   - Set a `riskMultiplier` of 0.5 (half position size)
   - Log: `Bias: BEARISH (REDUCED) | Daily=BEARISH 4H=TRANSITION | riskMultiplier=0.5`

4. When `biasConfidence === 'NONE'`, keep the current NO_TRADE behavior

5. Update the return type / interface to include `biasConfidence` and `riskMultiplier`

6. Wherever `riskMultiplier` is consumed downstream (likely in `riskManager.ts` or `positionManager.ts`), multiply the position size by `riskMultiplier`

7. Update the log format so we can see the new tier in the logs:
   ```
   // Old:
   Bias: NO_TRADE | 4H=TRANSITION Daily=BEARISH bothTFAgree=false
   // New:
   Bias: BEARISH (REDUCED) | 4H=TRANSITION Daily=BEARISH confidence=REDUCED riskMult=0.5
   ```

**Important constraints:**
- Do NOT change the B1/B2/B3 logic or the AMD phase detection — those are fine
- Do NOT change the Premium/Discount zone calculation — that's fine
- ONLY change the `bothTFAgree` gate and its downstream effects
- The `B1=WAITING_FOR_SWEEP` condition should still be respected — if B1 hasn't found a sweep context, the bias should still contribute to limiting trades. But the bothTFAgree gate should no longer be a hard block when 4H is TRANSITION.

### Verification

After this fix, with the current market conditions (Daily=BEARISH, 4H=TRANSITION), the bot should produce:
```
Bias: BEARISH (REDUCED) | 4H=TRANSITION Daily=BEARISH confidence=REDUCED riskMult=0.5 | B1=WAITING_FOR_SWEEP | AMD=ACCUMULATION | Zone=PREMIUM
```

This means the bias is no longer NO_TRADE, and the signal detector can now proceed to check for Sweep → MSS → FVG during killzones.

---

## FIX 2: Add Supabase Startup Validation (RELIABILITY)

### Context

The SUPABASE_KEY is now present in `.env` (Ed already added it). But the bot previously ran for 9 days without it and didn't report the issue — it silently swallowed the connection failures.

### Fix

Add a startup health check for Supabase connectivity in `src/database/supabase.ts` or `src/index.ts`:

1. Search the codebase for how the Supabase client is initialized:
   ```bash
   grep -r "SUPABASE" src/ --include="*.ts" | grep -i "key\|anon\|createClient"
   ```

2. After the Supabase client is created, add a startup validation:

   ```typescript
   // Supabase health check at startup
   async function validateSupabaseConnection(): Promise<boolean> {
     try {
       const { data, error } = await supabase.from('candles').select('count', { count: 'exact', head: true });
       if (error) throw error;
       logger.info(`✅ Supabase connected — candles table accessible`);
       return true;
     } catch (err) {
       logger.error(`🛑 CRITICAL: Supabase connection failed: ${err.message}`);
       logger.error(`   Check SUPABASE_URL and SUPABASE_KEY in .env`);
       // Send Telegram alert about Supabase failure
       return false;
     }
   }
   ```

3. Call this during bot startup. If it fails, log the error and send a Telegram alert but do NOT crash — the bot can still operate using local CSV logging as fallback.

---

## FIX 3: Add Live Trading Safety Guard (SAFETY)

### Context

The bot intentionally uses `BYBIT_TESTNET=false` (mainnet API) with `PAPER_TRADING=true`. This is the correct setup — mainnet provides real market data (accurate spreads, volume, orderbook) while the paper trader simulates execution internally without placing real orders. Do NOT change BYBIT_TESTNET.

### Fix

Add a safety guard in `src/index.ts` (or wherever the bot starts up) to prevent accidentally going live:

```typescript
// Safety guard: if someone disables PAPER_TRADING on mainnet, require explicit confirmation
if (process.env.PAPER_TRADING !== 'true' && process.env.BYBIT_TESTNET !== 'true') {
  if (process.env.LIVE_TRADING_CONFIRMED !== 'true') {
    logger.error('🛑 BLOCKED: Live trading on mainnet requires LIVE_TRADING_CONFIRMED=true in .env');
    process.exit(1);
  }
}

// Log the current mode clearly at startup
logger.info(`🔧 Mode: ${process.env.PAPER_TRADING === 'true' ? 'PAPER TRADING' : '⚡ LIVE TRADING'} | API: ${process.env.BYBIT_TESTNET === 'true' ? 'Testnet' : 'Mainnet'}`);
```

This is a low-risk addition that just protects against accidental live deployment.

---

## FIX 4: Add FVG Detection Logging (DIAGNOSTIC)

### Problem

The diagnostic showed **zero FVG-related log entries** in 7 days. This means either:
- (a) The FVG detector is not being called (because bias=NO_TRADE blocks the pipeline before FVGs are checked), or
- (b) The FVG detector runs but doesn't log anything

We need logging to see the full pipeline once Fix 1 unblocks the bias.

### Fix

In `src/analyzer/fvgDetector.ts`:

1. Add logging at the START of the FVG detection function:
   ```typescript
   logger.info(`[FVGDetector] Scanning for FVGs on ${timeframe}...`);
   ```

2. Log when FVGs are found:
   ```typescript
   logger.info(`[FVGDetector] Found ${count} FVG(s) on ${timeframe}: ${fvgs.map(f => `${f.type} @ ${f.midPrice.toFixed(2)}`).join(', ')}`);
   ```

3. Log when NO FVGs are found:
   ```typescript
   logger.info(`[FVGDetector] No qualifying FVGs found on ${timeframe}`);
   ```

4. In the signal detector (`src/engine/signalDetector.ts`), add logging at each step of the 3-step model to trace why signals fail:

   ```typescript
   // After Step 1 (Sweep):
   logger.info(`[SignalDetector] Step 1 (Sweep): ${sweeps.length > 0 ? `${sweeps.length} active sweep(s)` : 'No qualifying sweeps'}`);
   
   // After Step 2 (MSS):
   logger.info(`[SignalDetector] Step 2 (MSS): ${mssConfirmed ? `MSS confirmed — ${mssType} with displacement=${displacementScore}` : 'No MSS after sweep'}`);
   
   // After Step 3 (FVG Entry):
   logger.info(`[SignalDetector] Step 3 (FVG): ${entryFvg ? `Entry FVG found @ ${entryFvg.midPrice.toFixed(2)} — R:R=${riskReward.toFixed(1)}` : 'No qualifying FVG for entry'}`);
   
   // Final decision:
   if (signal) {
     logger.info(`[SignalDetector] ✅ SIGNAL GENERATED: ${signal.direction} entry @ ${signal.entryPrice.toFixed(2)}`);
   } else {
     logger.info(`[SignalDetector] ❌ No signal — pipeline stopped at Step ${failedStep}`);
   }
   ```

5. **Critical**: Also check if the signal detector is even being called during killzones. In `src/index.ts`, in the main loop that runs every 5 minutes, add logging BEFORE the bias check:

   ```typescript
   // Before bias check:
   logger.info(`[Main] Killzone active — checking bias for signal generation...`);
   
   // After bias check but before signal detection:
   logger.info(`[Main] Bias result: ${bias.direction} (${bias.confidence}) — ${bias.direction !== 'NO_TRADE' ? 'proceeding to signal detection' : 'SKIPPING signal detection'}`);
   ```

   This will confirm that the killzone → bias → signal pipeline is connected properly.

---

## Build & Deploy

After all 4 fixes:

```bash
# Build
cd /opt/bots/ict-bot
npm run build

# Verify no TypeScript errors
npx tsc --noEmit

# Restart the service
sudo systemctl restart ict-bot

# Watch for the first killzone cycle with new logging
sudo journalctl -u ict-bot -f
```

## Expected Outcome

After these fixes, during the next London or NY killzone, the logs should show:
1. Bias engine emitting `BEARISH (REDUCED)` instead of `NO_TRADE`
2. Signal detector being invoked and logging each step
3. FVG detector scanning and reporting results
4. Either a signal is generated (and a paper trade is opened), or we can see exactly at which step the pipeline stops — giving us the next piece to fix

---

## Summary of Changes

| Fix | File(s) | Type | Risk |
|-----|---------|------|------|
| 1. Relax bothTFAgree | biasEngine.ts, riskManager.ts | Logic change | Medium — adds REDUCED tier |
| 2. Supabase validation | database/supabase.ts, index.ts | Error handling | Low — adds startup check |
| 3. Live trading guard | index.ts | Safety guard | Low — adds startup check |
| 4. FVG + signal logging | fvgDetector.ts, signalDetector.ts, index.ts | Logging only | Very low — no logic changes |

## NOTE ON BYBIT_TESTNET

The bot intentionally uses `BYBIT_TESTNET=false` (mainnet). This is correct — the bot reads real market data from mainnet while PAPER_TRADING=true simulates execution internally. Do NOT change this setting.
