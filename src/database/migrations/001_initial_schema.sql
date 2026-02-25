-- ============================================================
-- ICT Price Action Bot - Initial Database Schema
-- Run in Supabase SQL Editor
-- ============================================================

-- Candle data across timeframes
CREATE TABLE IF NOT EXISTS candles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('5m', '15m', '1h', '4h', '1d')),
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL,
  UNIQUE(timestamp, timeframe)
);
CREATE INDEX IF NOT EXISTS idx_candles_tf_time ON candles(timeframe, timestamp DESC);

-- Detected swing points
CREATE TABLE IF NOT EXISTS swings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SWING_HIGH', 'SWING_LOW')),
  level NUMERIC NOT NULL,
  method TEXT NOT NULL DEFAULT 'ICT_N3',
  is_valid BOOLEAN DEFAULT true,
  candle_index INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_swings_tf_time ON swings(timeframe, timestamp DESC);

-- Market structure state snapshots
CREATE TABLE IF NOT EXISTS structure_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL,
  trend TEXT NOT NULL CHECK (trend IN ('BULLISH', 'BEARISH', 'TRANSITION', 'UNDEFINED')),
  last_hh NUMERIC,
  last_hl NUMERIC,
  last_lh NUMERIC,
  last_ll NUMERIC,
  critical_swing JSONB,
  event TEXT NOT NULL DEFAULT 'NONE',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Liquidity levels being tracked
CREATE TABLE IF NOT EXISTS liquidity_levels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  level NUMERIC NOT NULL,
  type TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ACTIVE',
  swept_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_liquidity_state ON liquidity_levels(state, type);

-- Fair Value Gaps
CREATE TABLE IF NOT EXISTS fvgs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('BULLISH', 'BEARISH')),
  top NUMERIC NOT NULL,
  bottom NUMERIC NOT NULL,
  ce NUMERIC NOT NULL,
  quality TEXT DEFAULT 'LOW',
  state TEXT NOT NULL DEFAULT 'OPEN',
  in_displacement BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Daily bias calculations
CREATE TABLE IF NOT EXISTS daily_bias (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  b1_framework TEXT,
  b2_draw_level NUMERIC,
  b2_draw_type TEXT,
  b3_zone TEXT,
  b3_depth NUMERIC,
  bias TEXT NOT NULL DEFAULT 'NO_TRADE',
  amd_phase TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Trade log
CREATE TABLE IF NOT EXISTS trades (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry_price NUMERIC NOT NULL,
  exit_price NUMERIC,
  size_usdt NUMERIC NOT NULL,
  leverage NUMERIC NOT NULL,
  stop_loss NUMERIC NOT NULL,
  tp1_level NUMERIC NOT NULL,
  tp2_level NUMERIC NOT NULL,
  tp1_hit BOOLEAN DEFAULT false,
  pnl_usdt NUMERIC,
  pnl_pct NUMERIC,
  rr_achieved NUMERIC,
  sweep_id UUID REFERENCES liquidity_levels(id),
  fvg_id UUID REFERENCES fvgs(id),
  displacement_score INTEGER,
  daily_bias_id UUID REFERENCES daily_bias(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  is_paper BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
